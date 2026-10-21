import { hashPassword, isUniqueConstraintError, verifyPassword } from "@/src/lib/auth";
import { ApiError, all, asString, batch, first, now, normalizePhone, requireFields, run, runtimeBindings, statement, validatePassword, type MobileRole, type MobileUser } from "./common";
import { createMobileSession, currentMobileUser, revokeUserSessions } from "./session";

export type ApiContext = {
  request: Request;
  method: string;
  path: string;
  body: Record<string, unknown>;
  user?: MobileUser;
};
export const NO_ROUTE = Symbol("NO_ROUTE");

export async function apiUser(ctx: ApiContext, roles?: MobileRole[]): Promise<MobileUser> {
  if (!ctx.user) ctx.user = await currentMobileUser(ctx.request);
  if (roles && !roles.includes(ctx.user.role)) throw new ApiError(403, "forbidden");
  return ctx.user;
}

function allowedDriverDocument(value: unknown): string {
  const data = typeof value === "string" ? value : "";
  const prefix = "data:image/jpeg;base64,";
  if (!data.startsWith(prefix) || data.length > 600_000) throw new ApiError(400, "invalid document");
  let decoded: string;
  try { decoded = atob(data.slice(prefix.length)); } catch { throw new ApiError(400, "invalid document"); }
  if (decoded.length < 100 || decoded.length > 450_000 || decoded.charCodeAt(0) !== 0xff || decoded.charCodeAt(1) !== 0xd8 || decoded.charCodeAt(2) !== 0xff || decoded.charCodeAt(decoded.length - 2) !== 0xff || decoded.charCodeAt(decoded.length - 1) !== 0xd9) {
    throw new ApiError(400, "invalid document");
  }
  return data;
}

function versionParts(value: unknown): number[] {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "invalid app version");
  return value.split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

const appUpdateDefaults: Record<string, string> = {
  android_latest_version: "1.0.0",
  android_minimum_version: "1.0.0",
  android_store_url: "https://play.google.com/store/apps/details?id=ly.talbista.app",
  ios_latest_version: "1.0.0",
  ios_minimum_version: "1.0.0",
  ios_store_url: "",
  update_message: "يتوفر تحديث جديد لتطبيق طلبيستا. حدّث التطبيق للاستفادة من التحسينات.",
};

export async function getAppUpdates(): Promise<Record<string, string>> {
  const rows = await all<{ k: string; v: string }>("SELECT k,v FROM settings_text");
  const saved = new Map(rows.map((row) => [row.k, row.v]));
  return Object.fromEntries(Object.entries(appUpdateDefaults).map(([key, fallback]) => [key, saved.get(key) ?? fallback]));
}

function phonePassword(body: Record<string, unknown>) {
  requireFields(body, "phone", "password");
  return { phone: normalizePhone(body.phone), password: validatePassword(body.password) };
}

async function throttleKey(phone: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleAccountApi(ctx: ApiContext): Promise<unknown | typeof NO_ROUTE> {
  const { method, path, body } = ctx;

  if (method === "POST" && path === "/api/register") {
    requireFields(body, "name", "phone", "password");
    const name = asString(body.name, "name", 120);
    if (name.length < 2) throw new ApiError(400, "invalid data");
    const { phone, password } = phonePassword(body);
    let result;
    try {
      result = await run('INSERT INTO "User"(role,name,phone,password) VALUES(\'CUSTOMER\',?,?,?)', name, phone, await hashPassword(password));
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ApiError(409, "phone exists");
      throw error;
    }
    if (result.lastRowId == null) throw new ApiError(500, "server error");
    return { id: result.lastRowId };
  }

  if (method === "POST" && path === "/api/register/store") {
    requireFields(body, "store_name", "manager_name", "phone", "address", "activity_type", "password");
    const storeName = asString(body.store_name, "store_name", 120);
    const managerName = asString(body.manager_name, "manager_name", 120);
    const address = asString(body.address, "address", 120);
    const activityType = asString(body.activity_type, "activity_type", 120);
    if ([storeName, managerName, address, activityType].some((value) => value.length < 2)) throw new ApiError(400, "invalid data");
    const { phone, password } = phonePassword(body);
    try {
      await batch([
        statement('INSERT INTO "User"(role,name,phone,password) VALUES(\'STORE\',?,?,?)', storeName, phone, await hashPassword(password)),
        statement("INSERT INTO stores(user_id,store_name,manager_name,address,activity_type) SELECT id,?,?,?,? FROM \"User\" WHERE phone=?", storeName, managerName, address, activityType, phone),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ApiError(409, "phone exists");
      throw error;
    }
    const created = await first<{ id: number }>('SELECT id FROM "User" WHERE phone=? AND role=\'STORE\'', phone);
    if (!created) throw new ApiError(500, "server error");
    await run("INSERT INTO audit_logs(at,actor,action,detail) VALUES(?,?,?,?)", now(), created.id, "register_store", JSON.stringify({ id: created.id }));
    return { id: created.id };
  }

  if (method === "POST" && path === "/api/driver-applications") {
    requireFields(body, "name", "phone", "password", "car", "model", "year", "color", "plate", "id_document", "license_document");
    const name = asString(body.name, "name", 120);
    const car = asString(body.car, "car", 120);
    const model = asString(body.model, "model", 120);
    const color = asString(body.color, "color", 120);
    const plate = asString(body.plate, "plate", 120);
    if ([name, car, model, color, plate].some((value) => value.length < 2)) throw new ApiError(400, "invalid data");
    const { phone, password } = phonePassword(body);
    const year = Number(body.year);
    const currentYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Africa/Tripoli", year: "numeric" }).format(new Date()));
    if (!Number.isInteger(year) || year < 1950 || year > currentYear + 1) throw new ApiError(400, "invalid data");
    if (await first("SELECT 1 AS found FROM \"User\" WHERE phone = ?", phone)) throw new ApiError(409, "phone exists");
    const idDocument = allowedDriverDocument(body.id_document);
    const licenseDocument = allowedDriverDocument(body.license_document);
    let result;
    try {
      result = await run("INSERT INTO driver_applications(name,phone,password_hash,car,model,year,color,plate,id_document,license_document,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", name, phone, await hashPassword(password), car, model, year, color, plate, idDocument, licenseDocument, now());
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ApiError(409, "application pending");
      throw error;
    }
    if (result.lastRowId == null) throw new ApiError(409, "application pending");
    const admins = await all<{ id: number }>('SELECT id FROM "User" WHERE role=\'ADMIN\' AND active=1');
    for (const admin of admins) await run("INSERT INTO notifications(user_id,text,at,read) VALUES(?,?,?,0)", admin.id, `طلب انضمام سائق جديد #${result.lastRowId}`, now());
    return { id: result.lastRowId, status: "PENDING", message: "تم استلام طلبك، وهو بانتظار مراجعة الإدارة." };
  }

  if (method === "POST" && path === "/api/login") {
    const { phone, password } = phonePassword(body);
    const key = await throttleKey(phone);
    const since = now() - 900;
    const failures = await first<{ n: number }>("SELECT COUNT(*) n FROM login_attempts WHERE phone=? AND attempted_at>?", key, since);
    if (Number(failures?.n ?? 0) >= 5) throw new ApiError(429, "too many attempts");
    const user = await first<MobileUser>('SELECT id,phone,password,name,role,active,photo FROM "User" WHERE phone=?', phone);
    if (!user || !user.active || !(await verifyPassword(password, user.password))) {
      const pending = await first<{ password_hash: string | null }>("SELECT password_hash FROM driver_applications WHERE phone=? AND status='PENDING'", phone);
      if (pending?.password_hash && await verifyPassword(password, pending.password_hash)) throw new ApiError(403, "driver application pending");
      await run("INSERT INTO login_attempts(phone,attempted_at) VALUES(?,?)", key, now());
      throw new ApiError(401, "bad credentials");
    }
    await run("DELETE FROM login_attempts WHERE phone=?", key);
    return createMobileSession(user, body.context);
  }

  if (method === "GET" && path === "/api/me") {
    const user = await apiUser(ctx);
    const result: Record<string, unknown> = { id: user.id, role: user.role, name: user.name, phone: user.phone };
    if (user.role === "DRIVER") {
      const driver = await first<Record<string, number | null>>("SELECT available,outstanding,blocked_until,lat,lng,loc_at FROM drivers WHERE user_id=?", user.id);
      if (!driver) throw new ApiError(404, "not found");
      const entitlement = await first<{ value: number }>("SELECT COALESCE(SUM(amount),0) AS value FROM ledger_entries WHERE driver_id=? AND account='ENTITLEMENT'", user.id);
      const active = await first<{ count: number }>("SELECT COUNT(*) AS count FROM orders WHERE driver_id=? AND status NOT IN ('DELIVERED','CANCELLED')", user.id);
      result.driver = { ...driver, entitlement: Number(entitlement?.value ?? 0) / 1000, active_orders: active?.count ?? 0, status: !driver.available ? "UNAVAILABLE" : (active?.count ?? 0) >= Number(await setting("max_active_orders")) ? "BUSY" : "AVAILABLE" };
    }
    if (user.role === "STORE") result.store = await first("SELECT store_name,manager_name,address,activity_type,lat,lng FROM stores WHERE user_id=?", user.id);
    return result;
  }

  if (method === "PATCH" && path === "/api/me") {
    const user = await apiUser(ctx);
    if (body.name && user.role === "CUSTOMER") await run('UPDATE "User" SET name=? WHERE id=?', String(body.name).trim().slice(0, 80), user.id);
    if (body.new_password !== undefined && body.new_password !== "") {
      requireFields(body, "old_password", "new_password");
      if (typeof body.old_password !== "string" || !(await verifyPassword(body.old_password, user.password)) || typeof body.new_password !== "string" || new TextEncoder().encode(body.new_password).byteLength < 8 || new TextEncoder().encode(body.new_password).byteLength > 256) throw new ApiError(400, "invalid password");
      await run('UPDATE "User" SET password=? WHERE id=?', await hashPassword(body.new_password), user.id);
      await revokeUserSessions(user.id, user.sessionToken);
      user.password = "";
    }
    await audit(user.id, "update_profile", { password_changed: Boolean(body.new_password) });
    return { ok: 1 };
  }

  if (method === "POST" && path === "/api/logout") {
    const user = await apiUser(ctx);
    if (user.sessionToken) await run("DELETE FROM sessions WHERE token=?", user.sessionToken);
    if (user.sessionToken) await run("DELETE FROM session_contexts WHERE token=?", user.sessionToken);
    return { ok: 1 };
  }

  if (method === "POST" && path === "/api/admin/password") {
    const user = await apiUser(ctx, ["ADMIN"]);
    requireFields(body, "old_password", "new_password");
    if (typeof body.old_password !== "string" || typeof body.new_password !== "string" || new TextEncoder().encode(body.new_password).byteLength < 8 || new TextEncoder().encode(body.new_password).byteLength > 256 || !(await verifyPassword(body.old_password, user.password))) throw new ApiError(400, "invalid password");
    await run('UPDATE "User" SET password=? WHERE id=? AND role=\'ADMIN\'', await hashPassword(body.new_password), user.id);
    const revoked = await revokeUserSessions(user.id, user.sessionToken);
    await audit(user.id, "change_admin_password", { sessions_revoked: true, count: revoked });
    return { ok: 1, sessions_revoked: true };
  }

  if (method === "GET" && path === "/api/services") {
    await apiUser(ctx);
    return all("SELECT id,name FROM services WHERE active=1");
  }

  if (method === "GET" && path === "/api/notifications") {
    const user = await apiUser(ctx);
    return all("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50", user.id);
  }

  if (method === "POST" && path === "/api/notifications/read") {
    const user = await apiUser(ctx);
    await run("UPDATE notifications SET read=1 WHERE user_id=?", user.id);
    return { ok: 1 };
  }

  if (method === "POST" && path === "/api/devices/register") {
    const user = await apiUser(ctx);
    const token = typeof body.token === "string" ? body.token : "";
    if (token.length < 20 || token.length > 4096) throw new ApiError(400, "bad token");
    const channelVersion = Number(body.channel_v ?? 1);
    if (![1, 2, 3, 4, 5, 7].includes(channelVersion)) throw new ApiError(400, "invalid channel version");
    await run("INSERT INTO fcm_tokens(token,user_id,created,channel_v) VALUES(?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,created=excluded.created,channel_v=excluded.channel_v", token, user.id, now(), channelVersion);
    return { ok: 1 };
  }

  if (method === "POST" && path === "/api/devices/unregister") {
    const user = await apiUser(ctx);
    await run("DELETE FROM fcm_tokens WHERE token=? AND user_id=?", typeof body.token === "string" ? body.token : "", user.id);
    return { ok: 1 };
  }

  if (method === "GET" && /^\/api\/app\/update\/(android|ios)\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(path)) {
    const match = path.match(/^\/api\/app\/update\/(android|ios)\/(.+)$/);
    if (!match) throw new ApiError(400, "invalid app version");
    const platform = match[1];
    const current = match[2];
    const settings = await getAppUpdates();
    const latest = settings[`${platform}_latest_version`];
    const minimum = settings[`${platform}_minimum_version`];
    const currentVersion = versionParts(current);
    const latestVersion = versionParts(latest);
    const minimumVersion = versionParts(minimum);
    const storeUrl = settings[`${platform}_store_url`];
    const supported = Boolean(storeUrl);
    return { supported, current_version: current, latest_version: latest, minimum_version: minimum, update_available: supported && compareVersions(currentVersion, latestVersion) < 0, force_update: supported && compareVersions(currentVersion, minimumVersion) < 0, store_url: storeUrl, message: settings.update_message };
  }

  if (method === "POST" && path === "/api/diagnostics") {
    const user = await apiUser(ctx);
    const reportId = typeof body.report_id === "string" ? body.report_id : "";
    if (!/^[A-Fa-f0-9-]{32,36}$/.test(reportId)) throw new ApiError(400, "invalid report id");
    const category = String(body.category ?? "");
    const platform = String(body.platform ?? "unknown");
    const route = String(body.route ?? "/other");
    const code = String(body.code ?? "UNKNOWN");
    const appVersion = String(body.app_version ?? "0.0.0");
    const categories = new Set(["network", "api", "push", "audio", "ui"]);
    const platforms = new Set(["android", "ios", "web", "unknown"]);
    const routes = new Set(["/orders", "/store/orders", "/driver/offers", "/driver/orders", "/notifications", "/devices/register", "/push", "/app/update", "/other"]);
    if (!categories.has(category) || !platforms.has(platform) || !routes.has(route) || !/^[A-Za-z0-9_.:-]{1,32}$/.test(code)) throw new ApiError(400, "invalid diagnostic fields");
    versionParts(appVersion);
    const httpStatus = body.http_status;
    if (httpStatus != null && (!Number.isInteger(httpStatus) || Number(httpStatus) < 100 || Number(httpStatus) > 599)) throw new ApiError(400, "invalid status");
    const flags = ["online", "push_ready", "retry_attempted", "retry_succeeded"].map((key) => {
      const value = body[key];
      if (value == null) return null;
      if (typeof value !== "boolean") throw new ApiError(400, "invalid flag");
      return value ? 1 : 0;
    });
    await run("INSERT OR IGNORE INTO diagnostic_reports(report_id,user_id,role,created,platform,app_version,category,code,route,http_status,online,push_ready,retry_attempted,retry_succeeded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", reportId, user.id, user.role, now(), platform, appVersion, category, code, route, httpStatus ?? null, ...flags);
    return { ok: 1, report_id: reportId };
  }

  if (method === "GET" && path === "/api/support") {
    await apiUser(ctx);
    const phone = await first<{ v: string }>("SELECT v FROM settings_text WHERE k='support_phone'");
    const whatsapp = await first<{ v: string }>("SELECT v FROM settings_text WHERE k='support_whatsapp'");
    const env = runtimeBindings();
    return { phone: phone?.v || env.SUPPORT_PHONE || "0930005136", whatsapp: whatsapp?.v || env.SUPPORT_WHATSAPP || "0922030144" };
  }

  if (method === "POST" && path === "/api/support/report") {
    const user = await apiUser(ctx);
    requireFields(body, "message");
    const message = String(body.message).trim().slice(0, 1000);
    if (message.length < 5) throw new ApiError(400, "invalid data");
    const orderId = body.order_id == null || body.order_id === "" ? null : Number(body.order_id);
    if (orderId != null && (!Number.isInteger(orderId) || orderId < 1)) throw new ApiError(400, "invalid data");
    await run("INSERT INTO reports(user_id,order_id,message,created,status) VALUES(?,?,?,?,'OPEN')", user.id, orderId, message, now());
    const admins = await all<{ id: number }>('SELECT id FROM "User" WHERE role=\'ADMIN\' AND active=1');
    for (const admin of admins) await run("INSERT INTO notifications(user_id,text,at,read) VALUES(?,?,?,0)", admin.id, `بلاغ جديد من ${user.name ?? user.phone}`, now());
    return { ok: 1 };
  }

  return NO_ROUTE;
}

async function setting(key: string): Promise<number> {
  const row = await first<{ v: number }>("SELECT v FROM settings WHERE k=?", key);
  return Number(row?.v ?? 0);
}

async function audit(actor: number, action: string, detail: unknown = ""): Promise<void> {
  await run("INSERT INTO audit_logs(at,actor,action,detail) VALUES(?,?,?,?)", now(), actor, action, JSON.stringify(detail));
}

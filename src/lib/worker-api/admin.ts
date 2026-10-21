import { hashPassword } from "@/src/lib/auth";
import { ApiError, all, asNumber, asString, batch, first, now, normalizePhone, run, runtimeBindings, statement, validatePassword, type MobileUser } from "./common";
import { ApiContext, apiUser, NO_ROUTE } from "./accounts";
import { balance, ledgerRows, moneyToUnits, postLedger, settleCustody, unitsToMoney } from "./ledger";
import { adminLoyaltyView, loyaltyConfig } from "./loyalty";
import { dispatchNewOrders, orderById, applyOrderStatus } from "./orders";
import { notifyUser } from "./notifications";

async function admin(ctx: ApiContext): Promise<MobileUser> { return apiUser(ctx, ["ADMIN"]); }
async function audit(actor: number, action: string, detail: unknown = "") { await run("INSERT INTO audit_logs(at,actor,action,detail) VALUES(?,?,?,?)", now(), actor, action, JSON.stringify(detail)); }
function unitMoney(value: unknown, field = "amount"): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000) throw new ApiError(400, `invalid ${field}`);
  return moneyToUnits(parsed);
}
function appVersion(value: unknown): number[] {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "invalid app version");
  return value.split(".").map(Number);
}
function isUnique(error: unknown): boolean { return /unique constraint failed/i.test(error instanceof Error ? error.message : String(error)); }

async function financeState(driverId: number) {
  const custody = await balance(driverId, "CUSTODY");
  const advance = await balance(driverId, "ADVANCE");
  const entitlement = await balance(driverId, "ENTITLEMENT");
  const cap = moneyToUnits(Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_cap'"))?.v ?? 100));
  const warn = moneyToUnits(Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_warn'"))?.v ?? 50));
  const settleDays = Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='settle_days'"))?.v ?? 7);
  const account = await first<{ alert_since: number | null }>("SELECT alert_since FROM driver_accounts WHERE driver_id=?", driverId);
  const since = account?.alert_since ?? null;
  const deadline = since == null ? null : since + settleDays * 86400;
  const status = custody >= cap ? "CAP" : since != null && now() >= Number(deadline) ? "OVERDUE" : since != null ? "WARN" : "OK";
  const open = await first<{ total: number }>("SELECT COALESCE(SUM(COALESCE(commission,CASE WHEN urgent=1 THEN ? ELSE ? END)),0) total FROM orders WHERE driver_id=? AND status NOT IN ('DELIVERED','CANCELLED')", moneyToUnits(Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='commission_urgent'"))?.v ?? 6)), moneyToUnits(Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='commission_normal'"))?.v ?? 3)), driverId);
  return { custody: unitsToMoney(custody), advance: unitsToMoney(advance), entitlement: unitsToMoney(entitlement), projected: unitsToMoney(custody + Number(open?.total ?? 0)), status, warn: unitsToMoney(warn), cap: unitsToMoney(cap), alert_since: since, deadline_at: deadline, days_left: deadline == null ? null : Math.max(0, Math.ceil((Number(deadline) - now()) / 86400)), can_accept_orders: custody < cap, can_accept_purchase: custody < cap && status !== "OVERDUE" };
}

async function openItems(driverId: number) {
  const rows = await all<{ amount: number; order_id: number | null; at: number; txn_id: number; kind: string; corrects_txn_id: number | null }>("SELECT e.amount,e.order_id,e.at,e.txn_id,t.kind,t.corrects_txn_id FROM ledger_entries e JOIN ledger_txns t ON t.id=e.txn_id WHERE e.driver_id=? AND e.account='CUSTODY' ORDER BY e.id", driverId);
  const charges = rows.filter((row) => row.amount > 0).map((row) => ({ txn_id: row.txn_id, order_id: row.order_id, at: row.at, kind: row.kind, original: row.amount, paid: 0 }));
  const byTxn = new Map(charges.map((charge) => [charge.txn_id, charge]));
  const remaining: number[] = [];
  for (const row of rows) {
    if (row.amount >= 0) continue;
    let amount = -row.amount;
    const charge = row.corrects_txn_id == null ? undefined : byTxn.get(row.corrects_txn_id);
    if (charge) { const applied = Math.min(amount, charge.original - charge.paid); charge.paid += applied; amount -= applied; }
    if (amount) remaining.push(amount);
  }
  for (let amount of remaining) for (const charge of charges) {
    if (!amount) break;
    const applied = Math.min(amount, charge.original - charge.paid); charge.paid += applied; amount -= applied;
  }
  return charges.filter((charge) => charge.original > charge.paid).map((charge) => ({ txn_id: charge.txn_id, order_id: charge.order_id, at: charge.at, kind: charge.kind, original: unitsToMoney(charge.original), paid: unitsToMoney(charge.paid), remaining: unitsToMoney(charge.original - charge.paid) }));
}

async function reconcile() {
  const issues: Record<string, unknown>[] = [];
  const unbalanced = await all<{ txn_id: number; total: number }>(`SELECT txn_id,SUM(CASE WHEN account IN ('CUSTODY','CASH_RECEIVED','CLEARING','INVENTORY','LOSS','OPENING_OFFSET') THEN amount ELSE -amount END) total FROM ledger_entries GROUP BY txn_id HAVING total<>0`);
  for (const row of unbalanced) issues.push({ type: "unbalanced_txn", txn_id: row.txn_id, diff: row.total });
  const drivers = await all<{ user_id: number; outstanding: number; custody: number; alert_since: number | null }>("SELECT d.user_id,d.outstanding,COALESCE(SUM(e.amount),0) custody,(SELECT alert_since FROM driver_accounts a WHERE a.driver_id=d.user_id) alert_since FROM drivers d LEFT JOIN ledger_entries e ON e.driver_id=d.user_id AND e.account='CUSTODY' GROUP BY d.user_id");
  const warn = moneyToUnits(Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_warn'"))?.v ?? 50));
  for (const row of drivers) {
    if (Math.abs(Number(row.outstanding) * 1000 - Number(row.custody)) > 0.5) issues.push({ type: "mirror_mismatch", driver_id: row.user_id, ledger: unitsToMoney(Number(row.custody)), mirror: row.outstanding });
    if (row.custody < 0) issues.push({ type: "negative_custody", driver_id: row.user_id });
    if ((Number(row.custody) >= warn) !== Boolean(row.alert_since)) issues.push({ type: "clock_mismatch", driver_id: row.user_id });
  }
  const result = { ok: issues.length === 0, issues: issues.slice(0, 50), at: now() };
  await run("INSERT OR REPLACE INTO kv(k,v) VALUES('reconcile',?)", JSON.stringify(result));
  return result;
}

async function adminStats() {
  const scalar = async (sql: string, ...values: unknown[]) => Number(Object.values((await first<Record<string, number>>(sql, ...values)) ?? { value: 0 })[0] ?? 0);
  const custodyCap = Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_cap'"))?.v ?? 100);
  const totals = async (account: string) => unitsToMoney(await balance(0, account));
  const incomeCommission = await scalar("SELECT COALESCE(SUM(amount),0) value FROM ledger_entries WHERE account='INCOME_COMMISSION'");
  const custody = await scalar("SELECT COALESCE(SUM(amount),0) value FROM ledger_entries WHERE account='CUSTODY'");
  const activeDrivers = await all<{ user_id: number }>("SELECT user_id FROM drivers");
  const statuses = await Promise.all(activeDrivers.map(async (driver) => (await financeState(driver.user_id)).status));
  const [customers, drivers, available, activeOrders, urgent, normal, delivered, cancelled, atLimit, blocked, fines, handovers] = await Promise.all([
    scalar('SELECT COUNT(*) value FROM "User" WHERE role=\'CUSTOMER\''), scalar("SELECT COUNT(*) value FROM drivers"),
    scalar("SELECT COUNT(*) value FROM drivers WHERE available=1"), scalar("SELECT COUNT(*) value FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED')"),
    scalar("SELECT COUNT(*) value FROM orders WHERE urgent=1"), scalar("SELECT COUNT(*) value FROM orders WHERE urgent=0"),
    scalar("SELECT COUNT(*) value FROM orders WHERE status='DELIVERED'"), scalar("SELECT COUNT(*) value FROM orders WHERE status='CANCELLED'"),
    scalar("SELECT COUNT(*) value FROM drivers WHERE outstanding>=?", custodyCap), scalar("SELECT COUNT(*) value FROM drivers WHERE blocked_until>?", now()),
    scalar("SELECT COALESCE(SUM(fine),0) value FROM violations WHERE status='ACTIVE'"), scalar("SELECT COUNT(*) value FROM cash_handovers WHERE status='REQUESTED'"),
  ]);
  void totals;
  return { customers, drivers, available, active_orders: activeOrders, urgent, normal, delivered, cancelled, commissions_total: unitsToMoney(incomeCommission), outstanding_total: unitsToMoney(custody), at_limit: atLimit, blocked_drivers: blocked, fines_total: fines, handover_requests: handovers, driver_status: { warn: statuses.filter((s) => s === "WARN").length, overdue: statuses.filter((s) => s === "OVERDUE").length, cap: statuses.filter((s) => s === "CAP").length } };
}

async function normalizeCorrection(driverId: number, entries: Array<{ account: string; amount: number }>) {
  const result = entries.map((entry) => ({ account: entry.account, amount: -Number(entry.amount) }));
  const custody = result.reduce((sum, entry) => sum + (entry.account === "CUSTODY" ? entry.amount : 0), 0);
  const current = await balance(driverId, "CUSTODY");
  if (custody < 0 && -custody > current) {
    const excess = -custody - current;
    for (const entry of result) if (entry.account === "CUSTODY") entry.amount += excess;
    result.push({ account: "ENTITLEMENT", amount: excess });
  }
  return result.map(({ account, amount }) => [account, amount] as [string, number]);
}

export async function handleAdminApi(ctx: ApiContext): Promise<unknown | typeof NO_ROUTE> {
  const { method, path, body } = ctx;
  if (!path.startsWith("/api/admin/")) return NO_ROUTE;
  const user = await admin(ctx);

  if (method === "GET" && path === "/api/admin/driver-applications") return all("SELECT id,name,phone,car,model,year,color,plate,status,submitted_at FROM driver_applications WHERE status='PENDING' ORDER BY submitted_at,id");
  const applicationMatch = path.match(/^\/api\/admin\/driver-applications\/(\d+)(?:\/(approve|reject))?$/);
  if (applicationMatch && method === "GET" && !applicationMatch[2]) {
    const row = await first("SELECT id,name,phone,car,model,year,color,plate,id_document,license_document,status,submitted_at FROM driver_applications WHERE id=? AND status='PENDING'", Number(applicationMatch[1]));
    if (!row) throw new ApiError(404, "not found");
    return row;
  }
  if (applicationMatch && method === "POST" && applicationMatch[2]) {
    const id = Number(applicationMatch[1]);
    const application = await first<{ id: number; name: string; phone: string; password_hash: string; car: string; model: string; year: number; color: string; plate: string }>("SELECT * FROM driver_applications WHERE id=? AND status='PENDING'", id);
    if (!application) throw new ApiError(409, "application not pending");
    if (applicationMatch[2] === "reject") {
      await run("UPDATE driver_applications SET status='REJECTED',password_hash=NULL,id_document=NULL,license_document=NULL,decision_by=?,decided_at=?,decision_note=? WHERE id=? AND status='PENDING'", user.id, now(), String(body.note ?? "").trim().slice(0, 300), id);
      await audit(user.id, "reject_driver_application", { id, note: body.note ?? "" });
      return { ok: 1, status: "REJECTED" };
    }
    const already = await first('SELECT 1 AS found FROM "User" WHERE phone=?', application.phone);
    if (already) throw new ApiError(409, "phone exists");
    try {
      await batch([
        statement('INSERT INTO "User"(role,name,phone,password) VALUES(\'DRIVER\',?,?,?)', application.name, application.phone, application.password_hash),
        statement("INSERT INTO drivers(user_id,car,model,year,color,plate,docs) SELECT id,?,?,?,?,?,? FROM \"User\" WHERE phone=?", application.car, application.model, application.year, application.color, application.plate, JSON.stringify({ application_id: id, documents_reviewed: true }), application.phone),
        statement("UPDATE driver_applications SET status='APPROVED',password_hash=NULL,id_document=NULL,license_document=NULL,decision_by=?,decided_at=?,approved_user_id=(SELECT id FROM \"User\" WHERE phone=?) WHERE id=? AND status='PENDING'", user.id, now(), application.phone, id),
      ]);
    } catch (error) { if (isUnique(error)) throw new ApiError(409, "phone exists"); throw error; }
    const driver = await first<{ id: number }>('SELECT id FROM "User" WHERE phone=?', application.phone);
    if (!driver) throw new ApiError(500, "driver creation failed");
    await audit(user.id, "approve_driver_application", { id, driver_id: driver.id });
    await notifyUser(driver.id, "تمت الموافقة على طلب انضمامك. يمكنك الآن تسجيل الدخول كسائق.");
    return { ok: 1, status: "APPROVED", driver_id: driver.id };
  }

  if (method === "POST" && path === "/api/admin/drivers") {
    for (const key of ["name", "phone", "password", "car", "model", "year", "color", "plate"]) if (body[key] == null) throw new ApiError(400, `missing ${key}`);
    const name = asString(body.name, "name", 120);
    const phone = normalizePhone(body.phone);
    const password = validatePassword(body.password);
    const car = asString(body.car, "car", 120), model = asString(body.model, "model", 120), color = asString(body.color, "color", 120), plate = asString(body.plate, "plate", 120);
    const year = asNumber(body.year, "year", 1950, new Date().getFullYear() + 1);
    try {
      await batch([
        statement('INSERT INTO "User"(role,name,phone,password,photo) VALUES(\'DRIVER\',?,?,?,NULL)', name, phone, await hashPassword(password)),
        statement("INSERT INTO drivers(user_id,car,model,year,color,plate,docs) SELECT id,?,?,?,?,?,? FROM \"User\" WHERE phone=?", car, model, year, color, plate, body.docs == null ? null : JSON.stringify(body.docs), phone),
      ]);
    } catch (error) { if (isUnique(error)) throw new ApiError(409, "phone exists"); throw error; }
    const created = await first<{ id: number }>('SELECT id FROM "User" WHERE phone=?', phone);
    if (!created) throw new ApiError(500, "driver creation failed");
    await audit(user.id, "create_driver", { id: created.id });
    return { id: created.id };
  }

  if (method === "GET" && path === "/api/admin/drivers") return all('SELECT u.id,u.name,u.phone,u.active,u.photo,d.* FROM "User" u JOIN drivers d ON d.user_id=u.id');
  const driverMatch = path.match(/^\/api\/admin\/drivers\/(\d+)(?:\/(password|photo|violations))?$/);
  if (driverMatch && method === "PATCH" && !driverMatch[2]) {
    const driverId = Number(driverMatch[1]);
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") throw new ApiError(400, "invalid active");
      await run('UPDATE "User" SET active=? WHERE id=? AND role=\'DRIVER\'', body.active ? 1 : 0, driverId);
      if (!body.active) await run("DELETE FROM sessions WHERE user_id=?", driverId);
    }
    for (const key of ["car", "model", "year", "color", "plate"] as const) {
      if (body[key] === undefined) continue;
      const value = key === "year" ? asNumber(body[key], key, 1950, new Date().getFullYear() + 1) : asString(body[key], key, 120);
      await run(`UPDATE drivers SET ${key}=? WHERE user_id=?`, value, driverId);
    }
    await audit(user.id, "patch_driver", { id: driverId, fields: Object.keys(body) });
    return { ok: 1 };
  }
  if (driverMatch && method === "POST" && driverMatch[2] === "password") {
    const password = validatePassword(body.password);
    await run('UPDATE "User" SET password=? WHERE id=? AND role=\'DRIVER\'', await hashPassword(password), Number(driverMatch[1]));
    await run("DELETE FROM sessions WHERE user_id=?", Number(driverMatch[1]));
    await run("DELETE FROM session_contexts WHERE token NOT IN (SELECT token FROM sessions)");
    await audit(user.id, "reset_driver_password", { id: Number(driverMatch[1]) });
    return { ok: 1 };
  }
  if (driverMatch && method === "POST" && driverMatch[2] === "photo") {
    const image = typeof body.image === "string" ? body.image : "";
    const match = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || image.length > 90_000) throw new ApiError(400, "bad image");
    let bytes: string;
    try { bytes = atob(match[2]); } catch { throw new ApiError(400, "bad image"); }
    const valid = bytes.startsWith("\xff\xd8\xff") || bytes.startsWith("\x89PNG\r\n\x1a\n") || (bytes.slice(0, 4) === "RIFF" && bytes.slice(8, 12) === "WEBP");
    if (!valid) throw new ApiError(400, "bad image");
    const driverExists = await first('SELECT 1 AS found FROM "User" WHERE id=? AND role=\'DRIVER\'', Number(driverMatch[1]));
    if (!driverExists) throw new ApiError(404, "not found");
    await run('UPDATE "User" SET photo=? WHERE id=?', image, Number(driverMatch[1]));
    await audit(user.id, "set_driver_photo", { id: Number(driverMatch[1]) });
    return { ok: 1 };
  }
  if (driverMatch && method === "POST" && driverMatch[2] === "violations") {
    const driverId = Number(driverMatch[1]);
    if (!body.reason) throw new ApiError(400, "missing reason");
    const driver = await first<{ blocked_until: number }>("SELECT blocked_until FROM drivers WHERE user_id=?", driverId);
    if (!driver) throw new ApiError(404, "not found");
    const orderId = body.order_id == null || body.order_id === "" ? null : asNumber(body.order_id, "order_id", 1);
    if (orderId && !(await first("SELECT 1 AS found FROM orders WHERE id=?", orderId))) throw new ApiError(400, "bad order");
    const fine = Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='violation_fine'"))?.v ?? 10);
    const hours = Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='violation_block_hours'"))?.v ?? 24);
    const until = Math.max(Number(driver.blocked_until), now() + Math.trunc(hours * 3600));
    const reason = String(body.reason).trim().slice(0, 300);
    const inserted = await run("INSERT INTO violations(driver_id,order_id,reason,fine,created,blocked_until,status,admin_id) VALUES(?,?,?,?,?,?,'ACTIVE',?)", driverId, orderId, reason, fine, now(), until, user.id);
    if (inserted.lastRowId == null) throw new ApiError(500, "server error");
    await run("UPDATE drivers SET blocked_until=? WHERE user_id=?", until, driverId);
    await postLedger({ kind: "FINE", entries: [["CUSTODY", moneyToUnits(fine)], ["INCOME_FINES", moneyToUnits(fine)]], driverId, reason, source: "ADMIN_ACTION", actorId: user.id, orderId, requestId: `fine:${inserted.lastRowId}` });
    await run("DELETE FROM offers WHERE driver_id=? AND status='PENDING'", driverId);
    await audit(user.id, "create_violation", { id: inserted.lastRowId, driver: driverId, order: orderId, fine, reason });
    await notifyUser(driverId, `تم إيقاف استقبال الطلبات لمدة ${hours} ساعة بسبب مخالفة: ${reason}. غرامة ${fine} د.ل`, { kind: "finance" });
    return { id: inserted.lastRowId };
  }

  const customerMatch = path.match(/^\/api\/admin\/customers\/(\d+)$/);
  if (customerMatch && method === "PATCH") {
    if (typeof body.active !== "boolean") throw new ApiError(400, "missing active");
    const customerId = Number(customerMatch[1]);
    await run('UPDATE "User" SET active=? WHERE id=? AND role=\'CUSTOMER\'', body.active ? 1 : 0, customerId);
    if (!body.active) { await run("DELETE FROM sessions WHERE user_id=?", customerId); await run("DELETE FROM session_contexts WHERE token NOT IN (SELECT token FROM sessions)"); }
    await audit(user.id, "set_customer_active", { id: customerId, active: body.active });
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/admin/orders") {
    const { orderView } = await import("./orders");
    const rows = await all("SELECT * FROM orders ORDER BY id DESC");
    return Promise.all(rows.map((row) => orderView(row as never, user)));
  }
  const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)(?:\/(assign|cancel|price-history))?$/);
  if (orderMatch && method === "GET" && orderMatch[2] === "price-history") return all("SELECT p.*,u.name actor_name FROM order_price_history p LEFT JOIN \"User\" u ON u.id=p.actor_id WHERE order_id=? ORDER BY p.id", Number(orderMatch[1]));
  if (orderMatch && method === "POST" && orderMatch[2] === "assign") {
    const order = await orderById(Number(orderMatch[1]));
    if (body.driver_id == null) throw new ApiError(400, "missing driver_id");
    const driverId = asNumber(body.driver_id, "driver_id", 1);
    if (!order || ["ORDER_PICKED_UP", "ON_THE_WAY_TO_CUSTOMER", "DRIVER_ARRIVED_DESTINATION", "DELIVERED", "CANCELLED"].includes(order.status)) throw new ApiError(409, "cannot assign");
    if (!(await first('SELECT 1 AS found FROM "User" WHERE id=? AND role=\'DRIVER\' AND active=1', driverId))) throw new ApiError(400, "bad driver");
    if (order.price_status !== "AGREED" || order.driver_id !== driverId) throw new ApiError(409, "price approval required");
    if (order.driver_id) await notifyUser(order.driver_id, `تم إلغاء الطلب #${order.id}`, { orderId: order.id });
    await run("UPDATE offers SET status='CANCELLED' WHERE order_id=? AND status='PENDING'", order.id);
    await run("UPDATE orders SET driver_id=? WHERE id=?", driverId, order.id);
    await applyOrderStatus({ ...order, driver_id: driverId }, "DRIVER_ASSIGNED", user.id);
    await notifyUser(driverId, `تم تعيينك للطلب #${order.id}`, { orderId: order.id });
    await audit(user.id, "assign", { order: order.id, driver: driverId });
    await dispatchNewOrders();
    return { ok: 1 };
  }
  if (orderMatch && method === "POST" && orderMatch[2] === "cancel") {
    const order = await orderById(Number(orderMatch[1]));
    if (!order || ["DELIVERED", "CANCELLED"].includes(order.status)) throw new ApiError(409, "cannot cancel");
    await run("UPDATE offers SET status='CANCELLED' WHERE order_id=? AND status='PENDING'", order.id);
    await applyOrderStatus(order, "CANCELLED", user.id);
    await audit(user.id, "admin_cancel", { order: order.id });
    return { ok: 1 };
  }

  if (method === "POST" && path === "/api/admin/services") {
    if (body.name == null) throw new ApiError(400, "missing name");
    const name = asString(body.name, "name", 120);
    const inserted = await run("INSERT INTO services(name) VALUES(?)", name);
    await audit(user.id, "add_service", { name });
    return { id: inserted.lastRowId };
  }
  const serviceMatch = path.match(/^\/api\/admin\/services\/(\d+)$/);
  if (serviceMatch && method === "PATCH") {
    const serviceId = Number(serviceMatch[1]);
    if (body.name !== undefined) await run("UPDATE services SET name=? WHERE id=?", asString(body.name, "name", 120), serviceId);
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") throw new ApiError(400, "invalid active");
      await run("UPDATE services SET active=? WHERE id=?", body.active ? 1 : 0, serviceId);
    }
    await audit(user.id, "patch_service", { id: serviceId, fields: Object.keys(body) });
    return { ok: 1 };
  }
  if (method === "GET" && path === "/api/admin/services") return all("SELECT * FROM services");

  if (method === "GET" && path === "/api/admin/settings") {
    const rows = await all<{ k: string; v: number }>("SELECT k,v FROM settings");
    const values = Object.fromEntries(rows.map((row) => [row.k, row.v]));
    values.driver_limit = values.custody_cap;
    return values;
  }
  if (method === "PUT" && path === "/api/admin/settings") {
    const values = { ...body };
    if (Object.prototype.hasOwnProperty.call(values, "driver_limit")) { values.custody_cap = values.driver_limit; delete values.driver_limit; }
    const keys = new Set(["auto_dispatch", "offer_timeout", "violation_fine", "violation_block_hours", "max_active_orders", "location_max_age", "commission_normal", "commission_urgent", "custody_warn", "custody_cap", "settle_days", "approval_threshold"]);
    const entries = Object.entries(values);
    if (entries.some(([key, value]) => !keys.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ApiError(400, "bad setting");
    for (const [key, value] of entries) await run("UPDATE settings SET v=? WHERE k=?", value as number, key);
    await audit(user.id, "settings", values);
    return { ok: 1 };
  }
  if (method === "GET" && path === "/api/admin/app-updates") {
    const { getAppUpdates } = await import("./accounts");
    return getAppUpdates();
  }
  if (method === "PUT" && path === "/api/admin/app-updates") {
    const keys = ["android_latest_version", "android_minimum_version", "android_store_url", "ios_latest_version", "ios_minimum_version", "ios_store_url", "update_message"];
    if (Object.keys(body).length !== keys.length || keys.some((key) => !(key in body))) throw new ApiError(400, "bad app update settings");
    for (const platform of ["android", "ios"] as const) {
      const latest = String(body[`${platform}_latest_version`]).trim();
      const minimum = String(body[`${platform}_minimum_version`]).trim();
      const latestParts = appVersion(latest), minimumParts = appVersion(minimum);
      if (minimumParts.some((part, i) => part > latestParts[i] && minimumParts.slice(0, i).every((v, j) => v === latestParts[j])) || compareVersion(minimumParts, latestParts) > 0) throw new ApiError(400, "minimum version cannot exceed latest version");
      const storeUrl = String(body[`${platform}_store_url`] ?? "").trim();
      if (storeUrl) {
        let parsed: URL;
        try { parsed = new URL(storeUrl); } catch { throw new ApiError(400, `invalid ${platform} store url`); }
        const valid = platform === "android" ? parsed.protocol === "https:" && parsed.hostname === "play.google.com" && parsed.pathname === "/store/apps/details" && parsed.searchParams.getAll("id").length === 1 && parsed.searchParams.get("id") === "ly.talbista.app" : parsed.protocol === "https:" && parsed.hostname === "apps.apple.com" && parsed.pathname.startsWith("/app/");
        if (!valid) throw new ApiError(400, `invalid ${platform} store url`);
      }
    }
    const message = body.update_message;
    if (typeof message !== "string" || !message.trim() || message.trim().length > 240) throw new ApiError(400, "invalid update message");
    const values = Object.fromEntries(keys.map((key) => [key, key === "update_message" ? message.trim() : String(body[key]).trim()]));
    for (const [key, value] of Object.entries(values)) await run("INSERT OR REPLACE INTO settings_text(k,v,updated_by,updated_at) VALUES(?,?,?,?)", key, value, user.id, now());
    await audit(user.id, "app_update_policy", values);
    return { ok: 1 };
  }
  if (method === "GET" && path === "/api/admin/loyalty") return adminLoyaltyView();
  if (method === "PUT" && path === "/api/admin/loyalty/settings") {
    const allowed = new Set(["store_orders_required", "customer_orders_required", "store_free_start", "store_free_end"]);
    if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.has(key))) throw new ApiError(400, "bad loyalty setting");
    const current = await loyaltyConfig();
    const combined = { ...current, ...body };
    for (const key of ["store_orders_required", "customer_orders_required"] as const) if (!Number.isInteger(combined[key]) || Number(combined[key]) < 1 || Number(combined[key]) > 100_000) throw new ApiError(400, "bad loyalty setting");
    const start = String(combined.store_free_start), end = String(combined.store_free_end);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) throw new ApiError(400, "bad loyalty setting");
    const [sh, sm] = start.split(":").map(Number), [eh, em] = end.split(":").map(Number);
    const duration = eh * 60 + em - (sh * 60 + sm);
    if (duration <= 0 || duration > 720) throw new ApiError(400, "نافذة توصيل المتجر يجب أن تكون في اليوم نفسه ومدتها من دقيقة إلى 12 ساعة");
    await run("UPDATE loyalty_settings SET store_orders_required=?,customer_orders_required=?,store_free_start=?,store_free_end=?,updated_by=?,updated_at=? WHERE id=1", combined.store_orders_required as number, combined.customer_orders_required as number, start, end, user.id, now());
    await audit(user.id, "loyalty_settings", { store_orders_required: combined.store_orders_required, customer_orders_required: combined.customer_orders_required, store_free_start: start, store_free_end: end });
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/admin/handovers") return all("SELECT * FROM cash_handovers ORDER BY id DESC");
  const handoverMatch = path.match(/^\/api\/admin\/handovers\/(\d+)\/confirm$/);
  if (method === "POST" && handoverMatch) {
    const handover = await first<{ id: number; driver_id: number }>("SELECT * FROM cash_handovers WHERE id=? AND status='REQUESTED'", Number(handoverMatch[1]));
    if (!handover) throw new ApiError(404, "no pending request");
    const current = await balance(handover.driver_id, "CUSTODY");
    const units = body.amount == null || body.amount === "" ? current : unitMoney(body.amount);
    if (units <= 0 || units > current) throw new ApiError(400, "invalid amount");
    await settleCustody(handover.driver_id, units, user.id, "تسوية عهدة (طلب السائق)", `handover:${handover.id}`, { handover: handover.id });
    await run("UPDATE cash_handovers SET status='CONFIRMED',amount=?,confirmed_at=?,admin_id=? WHERE id=?", unitsToMoney(units), now(), user.id, handover.id);
    await audit(user.id, "confirm_handover", { handover: handover.id, amount: unitsToMoney(units) });
    await notifyUser(handover.driver_id, units === current ? "تم تأكيد استلام العهدة" : `تم تأكيد استلام ${unitsToMoney(units)} د.ل من العهدة`, { kind: "finance" });
    return { ok: 1, amount: unitsToMoney(units) };
  }
  if (method === "GET" && path === "/api/admin/ledger") return ledgerRows();
  if (method === "GET" && path === "/api/admin/stats") return adminStats();
  if (method === "GET" && path === "/api/admin/customers") return all('SELECT id,name,phone,active FROM "User" WHERE role=\'CUSTOMER\' ORDER BY id DESC');
  if (method === "GET" && path === "/api/admin/diagnostics") return all("SELECT report_id,user_id,role,created,platform,app_version,category,code,route,http_status,online,push_ready,retry_attempted,retry_succeeded FROM diagnostic_reports ORDER BY created DESC LIMIT 200");
  if (method === "GET" && path === "/api/admin/system-health") {
    const pending = await first<{ n: number }>("SELECT COUNT(*) n FROM fcm_outbox WHERE status='pending'");
    const dead = await first<{ n: number }>("SELECT COUNT(*) n FROM fcm_outbox WHERE status='dead'");
    const devices = await first<{ n: number }>("SELECT COUNT(*) n FROM fcm_tokens");
    const offers = await first<{ n: number }>("SELECT COUNT(*) n FROM offers WHERE status='PENDING'");
    const waiting = await first<{ n: number }>("SELECT COUNT(*) n FROM orders WHERE status='PRICE_PENDING'");
    const reports = await first<{ n: number }>("SELECT COUNT(*) n FROM diagnostic_reports");
    const env = runtimeBindings();
    return { ok: 1, at: now(), fcm_configured: Boolean(env.FCM_SERVICE_ACCOUNT_JSON), fcm_outbox_pending: pending?.n ?? 0, fcm_outbox_dead: dead?.n ?? 0, registered_devices: devices?.n ?? 0, pending_offers: offers?.n ?? 0, price_waiting: waiting?.n ?? 0, diagnostic_reports: reports?.n ?? 0 };
  }

  if (method === "GET" && path === "/api/admin/reports") return all('SELECT r.*,u.name user_name,u.role user_role,u.phone user_phone FROM reports r JOIN "User" u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 200');
  const reportMatch = path.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
  if (method === "POST" && reportMatch) {
    await run("UPDATE reports SET status='DONE' WHERE id=?", Number(reportMatch[1]));
    await audit(user.id, "resolve_report", { id: Number(reportMatch[1]) });
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/admin/violations") return all('SELECT v.*,u.name driver_name FROM violations v JOIN "User" u ON u.id=v.driver_id ORDER BY v.id DESC');
  const violationMatch = path.match(/^\/api\/admin\/violations\/(\d+)\/cancel$/);
  if (method === "POST" && violationMatch) {
    if (body.note == null) throw new ApiError(400, "missing note");
    const id = Number(violationMatch[1]);
    const violation = await first<{ id: number; driver_id: number; order_id: number | null; fine: number }>("SELECT * FROM violations WHERE id=? AND status='ACTIVE'", id);
    if (!violation) throw new ApiError(409, "not active");
    const note = String(body.note).slice(0, 300);
    await run("UPDATE violations SET status='CANCELLED',cancelled_by=?,cancelled_at=?,cancel_note=? WHERE id=?", user.id, now(), note, id);
    const latest = await first<{ m: number | null }>("SELECT MAX(blocked_until) m FROM violations WHERE driver_id=? AND status='ACTIVE'", violation.driver_id);
    await run("UPDATE drivers SET blocked_until=? WHERE user_id=?", latest?.m ?? 0, violation.driver_id);
    const fine = moneyToUnits(Number(violation.fine));
    const current = await balance(violation.driver_id, "CUSTODY");
    const part = Math.min(fine, Math.max(current, 0));
    const entries: Array<[string, number]> = [["INCOME_FINES", -fine]];
    if (part) entries.push(["CUSTODY", -part]);
    if (fine > part) entries.push(["ENTITLEMENT", fine - part]);
    const original = await first<{ id: number }>("SELECT id FROM ledger_txns WHERE request_id=?", `fine:${id}`);
    await postLedger({ kind: "FINE_REVERSAL", entries, driverId: violation.driver_id, reason: note, source: "ADMIN_ACTION", actorId: user.id, orderId: violation.order_id, requestId: `fine_rev:${id}`, correctsTxnId: original?.id ?? null });
    await audit(user.id, "cancel_violation", { id, note });
    await notifyUser(violation.driver_id, "تم إلغاء مخالفة من الإدارة وإعادة الغرامة", { kind: "finance" });
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/admin/settings/text") {
    const rows = await all<{ k: string; v: string }>("SELECT k,v FROM settings_text WHERE k IN ('support_phone','support_whatsapp')");
    const values = new Map(rows.map((row) => [row.k, row.v]));
    return { support_phone: values.get("support_phone") ?? "", support_whatsapp: values.get("support_whatsapp") ?? "" };
  }
  if (method === "PUT" && path === "/api/admin/settings/text") {
    for (const [key, value] of Object.entries(body)) if (!["support_phone", "support_whatsapp"].includes(key) || typeof value !== "string" || (value && !/^\+?\d{6,15}$/.test(value.trim()))) throw new ApiError(400, `bad setting ${key}`);
    for (const [key, value] of Object.entries(body)) await run("INSERT OR REPLACE INTO settings_text(k,v,updated_by,updated_at) VALUES(?,?,?,?)", key, String(value).trim(), user.id, now());
    await audit(user.id, "settings_text", { keys: Object.keys(body) });
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/admin/finance/drivers") {
    const drivers = await all<{ id: number; name: string; phone: string; active: number }>('SELECT u.id,u.name,u.phone,u.active FROM "User" u JOIN drivers d ON d.user_id=u.id ORDER BY u.id');
    return Promise.all(drivers.map(async (driver) => ({ ...driver, ...(await financeState(driver.id)) })));
  }
  const financeDriverMatch = path.match(/^\/api\/admin\/finance\/drivers\/(\d+)(?:\/(settle))?$/);
  if (financeDriverMatch && method === "GET" && !financeDriverMatch[2]) {
    const driverId = Number(financeDriverMatch[1]);
    if (!(await first("SELECT 1 AS found FROM drivers WHERE user_id=?", driverId))) throw new ApiError(404, "not found");
    const transactions = await all<Record<string, unknown>>("SELECT * FROM ledger_txns WHERE driver_id=? ORDER BY id DESC LIMIT 200", driverId);
    for (const txn of transactions) {
      const items = await all<{ account: string; amount: number }>("SELECT account,amount FROM ledger_entries WHERE txn_id=? ORDER BY seq", txn.id);
      txn.entries = items.map((item) => ({ account: item.account, amount: unitsToMoney(item.amount) }));
      txn.label = ({ COMMISSION: "عمولة", FINE: "مخالفة", SETTLEMENT: "تسوية عهدة", CORRECTION: "تصحيح", ADJUSTMENT: "تعديل", COMPENSATION: "تعويض", OPENING: "رصيد افتتاحي" } as Record<string, string>)[String(txn.kind)] ?? txn.kind;
      txn.actor_name = (await first<{ name: string }>('SELECT name FROM "User" WHERE id=?', txn.actor_id))?.name ?? null;
      txn.approver_name = txn.approver_id == null ? null : (await first<{ name: string }>('SELECT name FROM "User" WHERE id=?', txn.approver_id))?.name ?? null;
      txn.meta = typeof txn.meta === "string" ? JSON.parse(txn.meta) : null;
    }
    const driver = await first('SELECT id,name,phone FROM "User" WHERE id=?', driverId);
    const openOrders = await all("SELECT id,urgent,delivery_price,status FROM orders WHERE driver_id=? AND status NOT IN ('DELIVERED','CANCELLED')", driverId);
    return { ...(await financeState(driverId)), driver, open_items: await openItems(driverId), txns: transactions, open_orders: openOrders };
  }
  if (financeDriverMatch && method === "POST" && financeDriverMatch[2] === "settle") {
    const driverId = Number(financeDriverMatch[1]);
    if (body.amount == null) throw new ApiError(400, "missing amount");
    const amount = unitMoney(body.amount);
    const requestId = body.request_id == null ? `admin-settle:${driverId}:${crypto.randomUUID()}` : String(body.request_id);
    const result = await settleCustody(driverId, amount, user.id, String(body.note ?? "تسوية عهدة").slice(0, 300), requestId, { direct: true });
    if (result.created) {
      const left = await balance(driverId, "CUSTODY");
      const handover = await first<{ id: number }>("SELECT id FROM cash_handovers WHERE driver_id=? AND status='REQUESTED'", driverId);
      if (handover) await run("UPDATE cash_handovers SET status='CONFIRMED',amount=?,confirmed_at=?,admin_id=? WHERE id=?", unitsToMoney(amount), now(), user.id, handover.id);
      await audit(user.id, "settle_custody", { driver: driverId, amount: unitsToMoney(amount) });
      await notifyUser(driverId, left === 0 ? "تم تأكيد استلام العهدة" : `تم تأكيد استلام ${unitsToMoney(amount)} د.ل من العهدة`, { kind: "finance" });
    }
    return { ok: 1, txn_id: result.txnId, duplicate: !result.created, custody: unitsToMoney(await balance(driverId, "CUSTODY")) };
  }

  if (method === "POST" && path === "/api/admin/finance/corrections") {
    if (body.txn_id == null || body.reason == null) throw new ApiError(400, "missing txn_id/reason");
    const transactionId = asNumber(body.txn_id, "txn_id", 1);
    const txn = await first<{ id: number; driver_id: number | null; order_id: number | null; kind: string }>("SELECT * FROM ledger_txns WHERE id=?", transactionId);
    if (!txn) throw new ApiError(404, "not found");
    if (await first("SELECT 1 AS found FROM ledger_txns WHERE corrects_txn_id=?", txn.id) || txn.kind === "CORRECTION") throw new ApiError(409, "already corrected");
    const original = await all<{ account: string; amount: number }>("SELECT account,amount FROM ledger_entries WHERE txn_id=? ORDER BY seq", txn.id);
    const entries = txn.driver_id == null ? original.map((item) => [item.account, -item.amount] as [string, number]) : await normalizeCorrection(txn.driver_id, original);
    const posted = await postLedger({ kind: "CORRECTION", entries, driverId: txn.driver_id, reason: String(body.reason).slice(0, 300), source: "ADMIN_ACTION", actorId: user.id, orderId: txn.order_id, requestId: `correct:${txn.id}`, correctsTxnId: txn.id });
    await audit(user.id, "ledger_correction", { txn: txn.id, reason: body.reason });
    return { ok: 1, txn_id: posted.txnId };
  }
  if (method === "POST" && path === "/api/admin/finance/adjustments") {
    for (const key of ["driver_id", "amount", "account", "reason"]) if (body[key] == null) throw new ApiError(400, `missing ${key}`);
    const driverId = asNumber(body.driver_id, "driver_id", 1);
    const account = body.account;
    if (!["CUSTODY", "ENTITLEMENT"].includes(String(account)) || !(await first("SELECT 1 AS found FROM drivers WHERE user_id=?", driverId))) throw new ApiError(400, "invalid data");
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100_000) throw new ApiError(400, "invalid amount");
    const delta = moneyToUnits(amount);
    const current = await balance(driverId, String(account));
    if (current + delta < 0) throw new ApiError(400, "balance cannot go below zero");
    const counter = account === "CUSTODY" ? "ADJUSTMENTS" : "LOSS";
    const requestId = body.request_id == null ? `admin-adjust:${driverId}:${crypto.randomUUID()}` : String(body.request_id);
    const posted = await postLedger({ kind: "ADJUSTMENT", entries: [[String(account), delta], [counter, delta]], driverId, reason: String(body.reason).slice(0, 300), source: "ADMIN_ACTION", actorId: user.id, requestId, meta: { large: Math.abs(amount) >= Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='approval_threshold'"))?.v ?? 200), account } });
    await audit(user.id, "ledger_adjustment", { driver: driverId, amount, account, reason: body.reason });
    return { ok: 1, txn_id: posted.txnId, duplicate: !posted.created };
  }
  if (method === "GET" && path === "/api/admin/finance/summary") {
    const total = async (account: string) => unitsToMoney(await first<{ amount: number }>("SELECT COALESCE(SUM(amount),0) amount FROM ledger_entries WHERE account=?", account).then((r) => Number(r?.amount ?? 0)));
    const drivers = await all<{ user_id: number }>("SELECT user_id FROM drivers");
    const states = await Promise.all(drivers.map(async (driver) => (await financeState(driver.user_id)).status));
    return { income_commission: await total("INCOME_COMMISSION"), income_fines: await total("INCOME_FINES"), cash_received: await total("CASH_RECEIVED"), custody_total: await total("CUSTODY"), advance_total: await total("ADVANCE"), entitlement_total: await total("ENTITLEMENT"), loss_total: await total("LOSS"), warn: states.filter((value) => value === "WARN").length, overdue: states.filter((value) => value === "OVERDUE").length, cap: states.filter((value) => value === "CAP").length, reconcile: await reconcile() };
  }

  if (method === "GET" && path === "/api/admin/audit") return all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200");
  if (method === "POST" && path === "/api/admin/sessions/revoke") {
    const target = body.user_id == null || body.user_id === "" ? user.id : asNumber(body.user_id, "user_id", 1);
    if (!(await first('SELECT 1 AS found FROM "User" WHERE id=?', target))) throw new ApiError(404, "not found");
    const count = (await run("DELETE FROM sessions WHERE user_id=?", target)).changes;
    await run("DELETE FROM session_contexts WHERE token NOT IN (SELECT token FROM sessions)");
    await audit(user.id, "revoke_sessions", { user_id: target, count });
    return { ok: 1, revoked: count };
  }

  return NO_ROUTE;
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

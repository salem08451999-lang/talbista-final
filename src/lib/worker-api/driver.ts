import { ApiError, all, coordinates, first, now, run, runtimeBindings } from "./common";
import { ApiContext, apiUser, NO_ROUTE } from "./accounts";
import { balance, ledgerRows, moneyToUnits, unitsToMoney } from "./ledger";
import { dispatchNewOrders, driverOfferList, driverOrderAccess, driverOrders, applyOrderStatus, proposePrice } from "./orders";
import { notifyUser } from "./notifications";

const flow = ["DRIVER_ASSIGNED", "DRIVER_ON_THE_WAY", "DRIVER_ARRIVED", "ORDER_PICKED_UP", "ON_THE_WAY_TO_CUSTOMER", "DRIVER_ARRIVED_DESTINATION", "DELIVERED"] as const;

async function setting(key: string): Promise<number> {
  const row = await first<{ v: number }>("SELECT v FROM settings WHERE k=?", key);
  return Number(row?.v ?? 0);
}

async function financeState(driverId: number): Promise<Record<string, unknown>> {
  const custody = await balance(driverId, "CUSTODY");
  const advance = await balance(driverId, "ADVANCE");
  const entitlement = await balance(driverId, "ENTITLEMENT");
  const cap = moneyToUnits(await setting("custody_cap"));
  const warn = moneyToUnits(await setting("custody_warn"));
  const settleDays = Math.trunc(await setting("settle_days"));
  const account = await first<{ alert_since: number | null }>("SELECT alert_since FROM driver_accounts WHERE driver_id=?", driverId);
  const alertSince = account?.alert_since ?? null;
  const deadline = alertSince == null ? null : alertSince + settleDays * 86400;
  const status = custody >= cap ? "CAP" : alertSince != null && now() >= Number(deadline) ? "OVERDUE" : alertSince != null ? "WARN" : "OK";
  const open = await first<{ total: number }>("SELECT COALESCE(SUM(COALESCE(commission,CASE WHEN urgent=1 THEN ? ELSE ? END)),0) total FROM orders WHERE driver_id=? AND status NOT IN ('DELIVERED','CANCELLED')", moneyToUnits(await setting("commission_urgent")), moneyToUnits(await setting("commission_normal")), driverId);
  const daysLeft = deadline == null ? null : Math.max(0, Math.ceil((Number(deadline) - now()) / 86400));
  return {
    custody: unitsToMoney(custody), advance: unitsToMoney(advance), entitlement: unitsToMoney(entitlement),
    projected: unitsToMoney(custody + Number(open?.total ?? 0)), status, warn: unitsToMoney(warn), cap: unitsToMoney(cap),
    alert_since: alertSince, deadline_at: deadline, days_left: daysLeft,
    can_accept_orders: custody < cap, can_accept_purchase: custody < cap && status !== "OVERDUE",
  };
}

async function movements(driverId: number, limit = 30): Promise<Record<string, unknown>[]> {
  const rows = await all<{ id: number; at: number; kind: string; order_id: number | null; reason: string | null }>(
    "SELECT t.id,t.at,t.kind,t.order_id,t.reason FROM ledger_txns t WHERE t.driver_id=? AND EXISTS(SELECT 1 FROM ledger_entries e WHERE e.txn_id=t.id AND e.account IN ('CUSTODY','ADVANCE','ENTITLEMENT') AND e.driver_id=?) ORDER BY t.id DESC LIMIT ?",
    driverId, driverId, limit,
  );
  const labels: Record<string, string> = { COMMISSION: "عمولة طلبيستا", SETTLEMENT: "تسوية عهدة", FINE: "مخالفة", FINE_REVERSAL: "إلغاء مخالفة", OPENING: "رصيد افتتاحي", CORRECTION: "تصحيح", ADJUSTMENT: "تعديل", COMPENSATION: "رصيد تعويض", PURCHASE_ADVANCE: "سلفة شراء", ADVANCE_RECOVERY: "استرداد سلفة", REFUND: "استرداد", LOSS_WRITE_OFF: "تسوية خسارة" };
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    const entries = await all<{ account: string; amount: number }>("SELECT account,SUM(amount) amount FROM ledger_entries WHERE txn_id=? AND account IN ('CUSTODY','ADVANCE','ENTITLEMENT') GROUP BY account", row.id);
    const entry = entries.find((item) => item.account === "CUSTODY") ?? entries.find((item) => item.account === "ADVANCE") ?? entries.find((item) => item.account === "ENTITLEMENT");
    if (!entry) continue;
    result.push({ at: row.at, label: `${labels[row.kind] ?? row.kind}${row.order_id && ["COMMISSION", "PURCHASE_ADVANCE", "ADVANCE_RECOVERY"].includes(row.kind) ? ` #${row.order_id}` : ""}`, amount: unitsToMoney(Number(entry.amount)), account: entry.account, order_id: row.order_id });
  }
  return result;
}

async function financeCredits(driverId: number) {
  const credits = await all<{ order_id: number; amount: number; created_at: number; reason: string | null }>("SELECT c.order_id,c.amount,c.created_at,t.reason FROM loyalty_driver_credits c JOIN ledger_txns t ON t.id=c.txn_id WHERE c.driver_id=? ORDER BY c.created_at DESC LIMIT 100", driverId);
  return { balance: unitsToMoney(await balance(driverId, "ENTITLEMENT")), credits: credits.map((item) => ({ ...item, amount: unitsToMoney(Number(item.amount)) })) };
}

export async function handleDriverApi(ctx: ApiContext): Promise<unknown | typeof NO_ROUTE> {
  const { method, path, body } = ctx;

  if (method === "POST" && path === "/api/driver/available") {
    const user = await apiUser(ctx, ["DRIVER"]);
    if (body.available !== undefined && typeof body.available !== "boolean") throw new ApiError(400, "invalid availability");
    const available = body.available ? 1 : 0;
    await run("UPDATE drivers SET available=? WHERE user_id=?", available, user.id);
    if (available) await dispatchNewOrders();
    return { ok: 1 };
  }
  if (method === "GET" && path === "/api/driver/offers") {
    const user = await apiUser(ctx, ["DRIVER"]);
    await dispatchNewOrders();
    return driverOfferList(user.id);
  }
  const offerMatch = path.match(/^\/api\/driver\/offers\/(\d+)\/(accept|reject)$/);
  if (method === "POST" && offerMatch) {
    const user = await apiUser(ctx, ["DRIVER"]);
    const orderId = Number(offerMatch[1]);
    const offer = await first<{ id: number }>("SELECT id FROM offers WHERE order_id=? AND driver_id=? AND status='PENDING' AND expires>=?", orderId, user.id, now());
    if (!offer) throw new ApiError(409, "offer not available");
    if (offerMatch[2] === "reject") {
      const result = await run("UPDATE offers SET status='REJECTED' WHERE id=? AND status='PENDING'", offer.id);
      if (!result.changes) throw new ApiError(409, "offer not available");
      return { ok: 1 };
    }
    if (body.agreed_price === undefined || body.agreed_price === null || body.agreed_price === "") throw new ApiError(400, "price required");
    return proposePrice(orderId, user, body.agreed_price);
  }
  if (method === "GET" && path === "/api/driver/orders") return driverOrders(await apiUser(ctx, ["DRIVER"]));

  const statusMatch = path.match(/^\/api\/driver\/orders\/(\d+)\/status$/);
  if (method === "POST" && statusMatch) {
    const user = await apiUser(ctx, ["DRIVER"]);
    const order = await driverOrderAccess(Number(statusMatch[1]), user);
    const status = body.status;
    const previous = flow.indexOf(order.status as typeof flow[number]);
    const next = flow.indexOf(status as typeof flow[number]);
    if (previous < 0 || next !== previous + 1) throw new ApiError(409, "invalid transition");
    await applyOrderStatus(order, status as string, user.id);
    return { ok: 1 };
  }

  const cancelMatch = path.match(/^\/api\/driver\/orders\/(\d+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const user = await apiUser(ctx, ["DRIVER"]);
    const order = await driverOrderAccess(Number(cancelMatch[1]), user);
    if (["ORDER_PICKED_UP", "ON_THE_WAY_TO_CUSTOMER", "DRIVER_ARRIVED_DESTINATION", "DELIVERED", "CANCELLED"].includes(order.status)) throw new ApiError(409, "cannot cancel now");
    await run("UPDATE offers SET status='DROPPED' WHERE order_id=? AND driver_id=?", order.id, user.id);
    await run("UPDATE orders SET driver_id=NULL,agreed_price=NULL,delivery_price=NULL,price_source=NULL,proposed_price=NULL,price_status='NONE',price_expires=NULL WHERE id=?", order.id);
    await applyOrderStatus({ ...order, driver_id: null, agreed_price: null, delivery_price: null, proposed_price: null }, "SEARCHING_DRIVER", user.id);
    await dispatchNewOrders();
    return { ok: 1 };
  }

  if (method === "POST" && path === "/api/driver/handover-request") {
    const user = await apiUser(ctx, ["DRIVER"]);
    if (await first("SELECT 1 AS found FROM cash_handovers WHERE driver_id=? AND status='REQUESTED'", user.id)) throw new ApiError(409, "already requested");
    const created = await run("INSERT INTO cash_handovers(driver_id,status,requested) VALUES(?,'REQUESTED',?)", user.id, now());
    const admins = await all<{ id: number }>('SELECT id FROM "User" WHERE role=\'ADMIN\' AND active=1');
    for (const admin of admins) await notifyUser(admin.id, `طلب تسوية عهدة من السائق #${user.id}`, { kind: "finance" });
    return { ok: 1, id: created.lastRowId };
  }

  if (method === "GET" && path === "/api/driver/ledger") {
    const user = await apiUser(ctx, ["DRIVER"]);
    return ledgerRows(user.id);
  }
  if (method === "GET" && path === "/api/driver/ledger/credits") return financeCredits((await apiUser(ctx, ["DRIVER"])).id);

  if (method === "POST" && path === "/api/driver/location") {
    const user = await apiUser(ctx, ["DRIVER"]);
    const [lat, lng] = coordinates(body, "lat", "lng");
    if (lat == null || lng == null) throw new ApiError(400, "bad coordinates");
    await run("UPDATE drivers SET lat=?,lng=?,loc_at=? WHERE user_id=?", lat, lng, now(), user.id);
    await dispatchNewOrders();
    return { ok: 1 };
  }
  if (method === "GET" && path === "/api/driver/violations") {
    const user = await apiUser(ctx, ["DRIVER"]);
    return all("SELECT id,order_id,reason,fine,created,blocked_until,status FROM violations WHERE driver_id=? ORDER BY id DESC", user.id);
  }
  if (method === "GET" && path === "/api/driver/finance") {
    const user = await apiUser(ctx, ["DRIVER"]);
    const text = await first<{ v: string }>("SELECT v FROM settings_text WHERE k='support_phone'");
    return { ...(await financeState(user.id)), movements: await movements(user.id), support_phone: text?.v || runtimeBindings().SUPPORT_PHONE || "0930005136" };
  }
  if (method === "GET" && path === "/api/push/key") {
    await apiUser(ctx, ["DRIVER"]);
    return { key: runtimeBindings().VAPID_PUBLIC_KEY ?? "" };
  }
  if (method === "POST" && path === "/api/push/subscribe") {
    const user = await apiUser(ctx, ["DRIVER"]);
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new ApiError(400, "bad endpoint"); }
    const hostname = parsed.hostname.toLowerCase();
    const hosts = ["googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
    if (parsed.protocol !== "https:" || endpoint.length > 600 || !hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) throw new ApiError(400, "bad endpoint");
    await run("INSERT OR REPLACE INTO push_subs(endpoint,user_id,created) VALUES(?,?,?)", endpoint, user.id, now());
    return { ok: 1 };
  }
  if (method === "POST" && path === "/api/push/unsubscribe") {
    const user = await apiUser(ctx, ["DRIVER"]);
    await run("DELETE FROM push_subs WHERE endpoint=? AND user_id=?", typeof body.endpoint === "string" ? body.endpoint : "", user.id);
    return { ok: 1 };
  }

  return NO_ROUTE;
}

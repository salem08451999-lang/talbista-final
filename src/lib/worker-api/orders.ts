import { ApiError, all, asNumber, coordinates, first, now, run, type MobileUser } from "./common";
import { ApiContext, apiUser, NO_ROUTE } from "./accounts";
import { balance, moneyToUnits, postLedger } from "./ledger";
import { completeLoyaltyOrder, releaseOrderReward, syncStoreReward } from "./loyalty";
import { notifyUser } from "./notifications";

const terminal = ["DELIVERED", "CANCELLED"] as const;
const priceResponseTimeout = 30;

async function randomDeliveryCode(): Promise<number> {
  const existing = await all<{ delivery_code: number }>("SELECT delivery_code FROM orders WHERE status NOT IN ('DELIVERED','CANCELLED')");
  const used = new Set(existing.map((row) => Number(row.delivery_code)));
  const value = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 9000) * 9000;
  for (let attempt = 0; attempt < 128; attempt++) {
    do { crypto.getRandomValues(value); } while (value[0] >= limit);
    const code = 1000 + (value[0] % 9000);
    if (!used.has(code)) return code;
  }
  throw new ApiError(503, "delivery code space unavailable");
}

type Order = {
  id: number; customer_id: number; delivery_code: number; idempotency_key: string | null; service_id: number | null; pickup: string; dropoff: string;
  details: string | null; urgent: number; status: string; driver_id: number | null;
  agreed_price: number | null; delivery_price: number | null; created: number; confirmed: number;
  proposed_price: number | null; price_status: string; kind: string | null; contact: string | null;
  order_value: number | null; is_paid: number | null; delivery_fee: number | null; notes: string | null;
  pickup_lat: number | null; pickup_lng: number | null; dropoff_lat: number | null; dropoff_lng: number | null;
  price_source: string | null; commission: number | null; loyalty_reward_id: number | null; is_demo: number | null;
  price_expires: number | null;
};

async function setting(key: string): Promise<number> {
  const row = await first<{ v: number }>("SELECT v FROM settings WHERE k=?", key);
  return Number(row?.v ?? 0);
}

function lybMinute(timestamp = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tripoli", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function normalWindowOpen(): boolean {
  const minute = lybMinute();
  return minute >= 8 * 60 || minute < 60;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const x = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(x));
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} كم` : `${Math.round(meters / 10) * 10} متر`;
}

async function eligibleDrivers(orderId: number, timestamp: number) {
  const cap = await setting("custody_cap");
  const maxActive = await setting("max_active_orders");
  return all<{ id: number; lat: number | null; lng: number | null; loc_at: number; last_offer: number }>(
    `SELECT u.id,d.lat,d.lng,d.loc_at,d.last_offer FROM "User" u JOIN drivers d ON d.user_id=u.id
     WHERE u.active=1 AND u.role='DRIVER' AND d.available=1 AND d.outstanding<? AND d.blocked_until<=?
       AND (SELECT COUNT(*) FROM orders x WHERE x.driver_id=u.id AND x.status NOT IN ('DELIVERED','CANCELLED'))
         +(SELECT COUNT(*) FROM offers p WHERE p.driver_id=u.id AND p.status='PENDING') < ?
       AND NOT EXISTS(SELECT 1 FROM offers f WHERE f.driver_id=u.id AND f.order_id=? AND f.status='PENDING')`,
    cap, timestamp, maxActive, orderId,
  );
}

async function selectDriver(order: Pick<Order, "id" | "pickup_lat" | "pickup_lng">, timestamp: number): Promise<{ id: number; distance: number | null } | null> {
  const drivers = await eligibleDrivers(order.id, timestamp);
  if (order.pickup_lat != null && order.pickup_lng != null) {
    const freshAge = await setting("location_max_age");
    const fresh = drivers.filter((driver) => driver.lat != null && driver.lng != null && Number(driver.loc_at) >= timestamp - freshAge);
    for (const radiusKm of [5, 15, 50, 500]) {
      const radius = radiusKm * 1000;
      const matching = fresh.map((driver) => ({ driver, distance: haversine(Number(order.pickup_lat), Number(order.pickup_lng), Number(driver.lat), Number(driver.lng)) })).filter((candidate) => candidate.distance <= radius);
      if (matching.length) {
        matching.sort((a, b) => Math.floor(a.distance / 100) - Math.floor(b.distance / 100) || Number(b.driver.loc_at) - Number(a.driver.loc_at) || a.distance - b.distance || Number(a.driver.id) - Number(b.driver.id));
        return { id: Number(matching[0].driver.id), distance: matching[0].distance };
      }
    }
  }
  drivers.sort((a, b) => Number(a.last_offer) - Number(b.last_offer) || Number(a.id) - Number(b.id));
  return drivers.length ? { id: Number(drivers[0].id), distance: null } : null;
}

async function expirePriceProposals(timestamp = now()): Promise<void> {
  const rows = await all<Order>("SELECT * FROM orders WHERE status='PRICE_PENDING' AND price_status='PENDING_CUSTOMER' AND price_expires IS NOT NULL AND price_expires<=?", timestamp);
  for (const order of rows) {
    const change = await run("UPDATE orders SET driver_id=NULL,proposed_price=NULL,price_status='EXPIRED',price_expires=NULL WHERE id=? AND status='PRICE_PENDING' AND price_status='PENDING_CUSTOMER' AND price_expires<=?", order.id, timestamp);
    if (!change.changes) continue;
    await run("UPDATE offers SET status='PRICE_TIMEOUT' WHERE order_id=? AND driver_id=? AND status='ACCEPTED'", order.id, order.driver_id);
    await setStatus({ ...order, driver_id: null, proposed_price: null }, "SEARCHING_DRIVER", 0);
    await notifyUser(order.customer_id, `انتهت مهلة 30 ثانية للرد على سعر الطلب #${order.id}؛ سنبحث تلقائيًا عن سائق آخر.`, { orderId: order.id, kind: "price_timeout" });
    if (order.driver_id) await notifyUser(order.driver_id, `انتهت مهلة موافقة الزبون للطلب #${order.id}، وأُعيد البحث عن سائق آخر.`, { orderId: order.id, kind: "price_timeout" });
  }
}

async function dispatch(): Promise<void> {
  const timestamp = now();
  await expirePriceProposals(timestamp);
  if ((await setting("auto_dispatch")) === 0) return;
  await run("UPDATE offers SET status='EXPIRED' WHERE status='PENDING' AND expires<?", timestamp);
  const orders = await all<Order>("SELECT * FROM orders WHERE status='SEARCHING_DRIVER' ORDER BY urgent DESC,id LIMIT 100");
  for (const order of orders) {
    if (await first("SELECT 1 AS found FROM offers WHERE order_id=? AND status='PENDING'", order.id)) continue;
    const candidate = await selectDriver(order, timestamp);
    if (!candidate) continue;
    await run("INSERT INTO offers(order_id,driver_id,status,expires,distance_m) VALUES(?,?,'PENDING',?,?)", order.id, candidate.id, timestamp + (await setting("offer_timeout")), candidate.distance);
    await run("UPDATE drivers SET last_offer=? WHERE user_id=?", timestamp, candidate.id);
    const text = `${order.urgent ? "⚡ طلب مستعجل قريب منك" : "🚚 طلب جديد قريب منك"} #${order.id}${candidate.distance == null ? "" : ` - يبعد ${formatDistance(candidate.distance)}`}`;
    await notifyUser(candidate.id, text, { orderId: order.id, urgent: order.urgent, kind: "offer" });
  }
}

async function setStatus(order: Order, status: string, actor: number): Promise<void> {
  await run("UPDATE orders SET status=? WHERE id=?", status, order.id);
  await run("INSERT INTO order_status_history(order_id,status,actor,at) VALUES(?,?,?,?)", order.id, status, actor, now());
  if (status === "DELIVERED" && order.driver_id) {
    const commission = order.commission == null ? moneyToUnits(await setting(order.urgent ? "commission_urgent" : "commission_normal")) : Number(order.commission);
    if (commission > 0) await postLedger({ kind: "COMMISSION", entries: [["CUSTODY", commission], ["INCOME_COMMISSION", commission]], driverId: order.driver_id, reason: "عمولة طلبيستا", source: "SYSTEM_RULE", actorId: actor, orderId: order.id, requestId: `commission:${order.id}` });
    const cap = moneyToUnits(await setting("custody_cap"));
    if (await balance(order.driver_id, "CUSTODY") >= cap) await notifyUser(order.driver_id, "وصلت عهدتك إلى الحد المسموح. يرجى تسوية العهدة لدى الشركة قبل استقبال طلبات جديدة.");
    await completeLoyaltyOrder(order);
  }
  if (status === "CANCELLED") await releaseOrderReward(order);
  const messages: Record<string, string> = {
    SEARCHING_DRIVER: "جاري البحث عن سائق",
    PRICE_PENDING: `حدد السائق قيمة توصيل ${Number(order.proposed_price ?? 0)} د.ل؛ بانتظار موافقتك`,
    DRIVER_ASSIGNED: "تم تعيين السائق",
    DRIVER_ON_THE_WAY: "السائق قبل الطلب وفي الطريق",
    DRIVER_ARRIVED: "السائق وصل إلى موقع الاستلام",
    ORDER_PICKED_UP: "تم استلام الطلب",
    ON_THE_WAY_TO_CUSTOMER: "الطلب في الطريق إلى موقع التسليم",
    DRIVER_ARRIVED_DESTINATION: "السائق وصل إلى موقع التسليم",
    DELIVERED: "تم التسليم",
    CANCELLED: "تم إلغاء الطلب",
  };
  const message = messages[status];
  if (message) await notifyUser(order.customer_id, `#${order.id}: ${message}`, { orderId: order.id, kind: "status", soundEvent: status === "DELIVERED" ? "delivered" : "general", status });
}

async function getOrder(orderId: number, user: MobileUser): Promise<Order> {
  const order = await first<Order>("SELECT * FROM orders WHERE id=?", orderId);
  if (!order || ((user.role === "CUSTOMER" || user.role === "STORE") && Number(order.customer_id) !== user.id) || (user.role === "DRIVER" && Number(order.driver_id) !== user.id)) throw new ApiError(404, "not found");
  return order;
}

export async function orderView(order: Order, viewer?: MobileUser): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { ...order, agreed_price: order.agreed_price ?? order.delivery_price };
  delete result.delivery_fee;
  delete result.delivery_price;
  if (viewer?.role !== "ADMIN" && viewer?.role !== "CUSTOMER") delete result.delivery_code;
  result.history = await all("SELECT status,at FROM order_status_history WHERE order_id=? ORDER BY id", order.id);
  result.driver = null;
  if (order.driver_id) {
    result.driver = await first(`SELECT u.name,u.phone,u.photo,d.car,d.model,d.year,d.color,d.plate,
      CASE WHEN d.rating_n>0 THEN ROUND(1.0*d.rating_sum/d.rating_n,2) END AS rating
      FROM "User" u JOIN drivers d ON d.user_id=u.id WHERE u.id=?`, order.driver_id);
  }
  if (viewer?.role === "DRIVER" && terminal.includes(order.status as typeof terminal[number])) result.contact = null;
  if (viewer?.role !== "ADMIN") delete result.commission;
  return result;
}

function roundedPrice(value: unknown): number {
  const amount = asNumber(value, "price", Number.MIN_VALUE, 10_000);
  return Math.round(amount * 1000) / 1000;
}

type IdempotentOrder = { id: number; customer_id: number; delivery_code: number; status: string };

async function findIdempotentOrder(key: string, customerId: number): Promise<IdempotentOrder | null> {
  return first<IdempotentOrder>("SELECT id,customer_id,delivery_code,status FROM orders WHERE idempotency_key=? AND customer_id=? LIMIT 1", key, customerId);
}

async function idempotentOrderResponse(order: IdempotentOrder, user: MobileUser) {
  const existing = await first<Order>("SELECT * FROM orders WHERE id=? AND customer_id=?", order.id, user.id);
  if (!existing) throw new ApiError(404, "not found");
  const id = Number(existing.id);
  return { ok: true, id, existingId: id, delivery_code: Number(existing.delivery_code), status: existing.status, order: await orderView(existing, user) };
}

async function orderCreate(user: MobileUser, body: Record<string, unknown>) {
  if (user.role === "CUSTOMER") {
    const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new ApiError(400, "missing or invalid idempotency_key");
    const previousOrder = await findIdempotentOrder(idempotencyKey, user.id);
    if (previousOrder) {
      console.log(`[DUPLICATE_GUARD] blocked duplicate for customer ${user.id}`);
      return idempotentOrderResponse(previousOrder, user);
    }
    if (body.service_id == null || body.pickup == null || body.dropoff == null) throw new ApiError(400, "missing service_id/pickup/dropoff");
    const serviceId = asNumber(body.service_id, "service_id", 1);
    if (!(await first("SELECT 1 AS found FROM services WHERE id=? AND active=1", serviceId))) throw new ApiError(400, "bad service");
    const [pickupLat, pickupLng] = coordinates(body, "pickup_lat", "pickup_lng");
    const [dropoffLat, dropoffLng] = coordinates(body, "dropoff_lat", "dropoff_lng");
    const createdAt = now();
    const urgent = body.urgent ? 1 : 0;
    if (!urgent && !normalWindowOpen()) throw new ApiError(409, "orders not available now");
    const details = typeof body.details === "string" ? body.details.trim().slice(0, 500) : "";
    const useReward = ["1", "true", "yes"].includes(String(body.use_loyalty_reward ?? "").toLowerCase());
    const reward = useReward ? await first<{ id: number }>("SELECT * FROM loyalty_rewards WHERE owner_kind='CUSTOMER' AND owner_id=? AND reward_type='CUSTOMER_FREE_DELIVERY' AND status='AVAILABLE' ORDER BY earned_at,id LIMIT 1", user.id) : null;
    if (useReward && !reward) throw new ApiError(409, "لا توجد مكافأة توصيل متاحة");
    const commission = moneyToUnits(await setting(urgent ? "commission_urgent" : "commission_normal"));
    let orderId: number | null = null;
    try {
      const inserted = await run(`INSERT INTO orders(customer_id,service_id,pickup,dropoff,details,urgent,status,created,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,delivery_price,agreed_price,price_source,commission,idempotency_key,delivery_code)
        VALUES(?,?,?,?,?,?, 'NEW', ?,?,?,?,?,NULL,NULL,NULL,?,?,?)`, user.id, serviceId, String(body.pickup).slice(0, 200), String(body.dropoff).slice(0, 200), details, urgent, createdAt, pickupLat, pickupLng, dropoffLat, dropoffLng, commission, idempotencyKey, await randomDeliveryCode());
      orderId = inserted.lastRowId == null ? null : Number(inserted.lastRowId);
    } catch (error) {
      const racedOrder = await findIdempotentOrder(idempotencyKey, user.id);
      if (!racedOrder) {
        const keyOwner = await first("SELECT 1 AS found FROM orders WHERE idempotency_key=? LIMIT 1", idempotencyKey);
        if (keyOwner) throw new ApiError(409, "idempotency key already used");
        throw error;
      }
      console.log(`[DUPLICATE_GUARD] blocked duplicate for customer ${user.id}`);
      return idempotentOrderResponse(racedOrder, user);
    }
    if (orderId == null) throw new ApiError(500, "server error");
    if (reward) {
      await run("UPDATE orders SET loyalty_reward_id=? WHERE id=?", reward.id, orderId);
      const reserved = await run("UPDATE loyalty_rewards SET status='RESERVED',reserved_order_id=? WHERE id=? AND status='AVAILABLE'", orderId, reward.id);
      if (reserved.changes !== 1) throw new ApiError(409, "المكافأة مستخدمة بالفعل");
    }
    const order = await first<Order>("SELECT * FROM orders WHERE id=?", orderId);
    if (!order) throw new ApiError(500, "server error");
    await run("INSERT INTO order_status_history(order_id,status,actor,at) VALUES(?,?,?,?)", orderId, "NEW", user.id, now());
    await notifyUser(user.id, `تم إنشاء الطلب #${orderId}`, { orderId });
    await setStatus(order, "SEARCHING_DRIVER", user.id);
    await dispatch();
    return { ok: true, id: orderId, delivery_code: Number(order.delivery_code), note: "سعر التنفيذ يتم الاتفاق عليه بين العميل والسائق قبل التأكيد" };
  }

  if (user.role === "STORE") {
    if (body.contact == null || body.dropoff == null) throw new ApiError(400, "missing contact/dropoff");
    const store = await first<Record<string, unknown>>("SELECT * FROM stores WHERE user_id=?", user.id);
    if (!store) throw new ApiError(404, "not found");
    const urgent = body.urgent ? 1 : 0;
    if (!urgent && !normalWindowOpen()) throw new ApiError(409, "orders not available now");
    const paid = body.is_paid ? 1 : 0;
    const orderValue = paid ? 0 : asNumber(body.order_value, "order_value", 0, 100_000);
    const [providedLat, providedLng] = coordinates(body, "pickup_lat", "pickup_lng");
    const pickupLat = providedLat ?? (store.lat == null ? null : Number(store.lat));
    const pickupLng = providedLng ?? (store.lng == null ? null : Number(store.lng));
    const [dropoffLat, dropoffLng] = coordinates(body, "dropoff_lat", "dropoff_lng");
    await syncStoreReward(user.id);
    const reward = await first<{ id: number }>("SELECT id FROM loyalty_rewards WHERE owner_kind='STORE' AND owner_id=? AND status='ACTIVE' ORDER BY id LIMIT 1", user.id);
    const commission = moneyToUnits(await setting(urgent ? "commission_urgent" : "commission_normal"));
    const inserted = await run(`INSERT INTO orders(customer_id,service_id,pickup,dropoff,details,urgent,status,created,kind,contact,order_value,is_paid,notes,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,delivery_price,agreed_price,price_source,commission,loyalty_reward_id)
      VALUES(?,NULL,?,?,?,?,'NEW',?,'STORE',?,?,?,?,?,?,?, ?,NULL,NULL,NULL,?,?)`, user.id, String(body.pickup ?? store.address ?? "").slice(0, 200), String(body.dropoff).slice(0, 200), String(body.details ?? "").trim().slice(0, 500), urgent, now(), String(body.contact).slice(0, 120), orderValue, paid, String(body.notes ?? "").slice(0, 500), pickupLat, pickupLng, dropoffLat, dropoffLng, commission, reward?.id ?? null);
    const orderId = inserted.lastRowId;
    if (orderId == null) throw new ApiError(500, "server error");
    const order = await first<Order>("SELECT * FROM orders WHERE id=?", orderId);
    if (!order) throw new ApiError(500, "server error");
    await run("INSERT INTO order_status_history(order_id,status,actor,at) VALUES(?,?,?,?)", orderId, "NEW", user.id, now());
    await notifyUser(user.id, `تم إنشاء الطلب #${orderId}`, { orderId });
    await setStatus(order, "SEARCHING_DRIVER", user.id);
    await dispatch();
    return { id: orderId, agreed_price: null, loyalty_reward: Boolean(reward) };
  }
  throw new ApiError(403, "forbidden");
}

export async function handleOrderApi(ctx: ApiContext): Promise<unknown | typeof NO_ROUTE> {
  const { method, path, body } = ctx;

  if (method === "GET" && (path === "/api/orders" || path === "/api/customer/orders")) {
    const user = await apiUser(ctx, ["CUSTOMER"]);
    const rows = await all<Order>("SELECT * FROM orders WHERE customer_id=? ORDER BY id DESC", user.id);
    return Promise.all(rows.map((order) => orderView(order, user)));
  }
  if (method === "POST" && path === "/api/orders") return orderCreate(await apiUser(ctx, ["CUSTOMER"]), body);
  const customerOrderMatch = path.match(/^\/api\/customer\/orders\/(\d+)$/);
  if (method === "GET" && customerOrderMatch) {
    const user = await apiUser(ctx, ["CUSTOMER"]);
    return orderView(await getOrder(Number(customerOrderMatch[1]), user), user);
  }
  const orderIdMatch = path.match(/^\/api\/orders\/(\d+)$/);
  if (method === "GET" && orderIdMatch) {
    const user = await apiUser(ctx);
    return orderView(await getOrder(Number(orderIdMatch[1]), user), user);
  }
  const responseMatch = path.match(/^\/api\/orders\/(\d+)\/price-response$/);
  if (method === "POST" && responseMatch) {
    const user = await apiUser(ctx, ["CUSTOMER", "STORE"]);
    const order = await getOrder(Number(responseMatch[1]), user);
    if (order.status !== "PRICE_PENDING" || order.price_status !== "PENDING_CUSTOMER" || order.proposed_price == null || !order.driver_id) throw new ApiError(409, "price response not available");
    if (order.price_expires == null || Number(order.price_expires) <= now()) {
      await expirePriceProposals();
      throw new ApiError(409, "price response expired");
    }
    if (typeof body.accept !== "boolean") throw new ApiError(400, "invalid price response");
    const proposed = roundedPrice(order.proposed_price);
    if (body.accept) {
      const updated = await run("UPDATE orders SET price_status='AGREED',price_expires=NULL WHERE id=? AND status='PRICE_PENDING' AND price_status='PENDING_CUSTOMER' AND price_expires>?", order.id, now());
      if (!updated.changes) throw new ApiError(409, "price response expired");
      await run("UPDATE orders SET delivery_price=?,agreed_price=?,price_source='CUSTOMER_ACCEPTED' WHERE id=?", proposed, proposed, order.id);
      await run("INSERT INTO order_price_history(order_id,price,at,actor_id,reason) VALUES(?,?,?,?,?)", order.id, proposed, now(), user.id, "وافق طالب الخدمة على عرض السائق");
      await setStatus(order, "DRIVER_ASSIGNED", user.id);
      await notifyUser(order.driver_id, `وافق طالب الخدمة على سعر التوصيل ${proposed} د.ل للطلب #${order.id}. يمكنك البدء.`, { orderId: order.id, kind: "price", soundEvent: "accepted" });
      return { ok: 1, status: "DRIVER_ASSIGNED", agreed_price: proposed };
    }
    const updated = await run("UPDATE orders SET driver_id=NULL,proposed_price=NULL,price_status='REJECTED',price_expires=NULL WHERE id=? AND status='PRICE_PENDING' AND price_status='PENDING_CUSTOMER' AND price_expires>?", order.id, now());
    if (!updated.changes) throw new ApiError(409, "price response expired");
    await run("UPDATE offers SET status='PRICE_REJECTED' WHERE order_id=? AND driver_id=? AND status='ACCEPTED'", order.id, order.driver_id);
    await setStatus({ ...order, driver_id: null, proposed_price: null }, "SEARCHING_DRIVER", user.id);
    await notifyUser(order.driver_id, `لم يوافق طالب الخدمة على السعر المقترح للطلب #${order.id}؛ أُعيد البحث عن سائق آخر.`, { orderId: order.id, kind: "price" });
    await dispatch();
    return { ok: 1, status: "SEARCHING_DRIVER" };
  }
  const customerCancelMatch = path.match(/^\/api\/orders\/(\d+)\/cancel$/);
  if (method === "POST" && customerCancelMatch) {
    const user = await apiUser(ctx, ["CUSTOMER"]);
    const order = await getOrder(Number(customerCancelMatch[1]), user);
    if (["ORDER_PICKED_UP", "ON_THE_WAY_TO_CUSTOMER", "DRIVER_ARRIVED_DESTINATION", "DELIVERED", "CANCELLED"].includes(order.status)) throw new ApiError(409, "cannot cancel now");
    await run("UPDATE offers SET status='CANCELLED' WHERE order_id=? AND status='PENDING'", order.id);
    if (order.driver_id) await notifyUser(order.driver_id, `تم إلغاء الطلب #${order.id}`, { orderId: order.id });
    await setStatus(order, "CANCELLED", user.id);
    return { ok: 1 };
  }
  const customerConfirmMatch = path.match(/^\/api\/orders\/(\d+)\/confirm$/);
  if (method === "POST" && customerConfirmMatch) {
    const user = await apiUser(ctx, ["CUSTOMER"]);
    const order = await getOrder(Number(customerConfirmMatch[1]), user);
    if (order.status !== "DELIVERED") throw new ApiError(409, "not delivered");
    await run("UPDATE orders SET confirmed=1 WHERE id=?", order.id);
    return { ok: 1 };
  }
  const rateMatch = path.match(/^\/api\/orders\/(\d+)\/rate$/);
  if (method === "POST" && rateMatch) {
    const user = await apiUser(ctx, ["CUSTOMER"]);
    const order = await getOrder(Number(rateMatch[1]), user);
    const stars = body.stars;
    if (order.status !== "DELIVERED" || typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) throw new ApiError(400, "invalid");
    try {
      await run("INSERT INTO ratings(order_id,driver_id,customer_id,stars,comment) VALUES(?,?,?,?,?)", order.id, order.driver_id, user.id, stars, body.comment == null ? null : String(body.comment).slice(0, 1000));
    } catch {
      throw new ApiError(409, "already rated");
    }
    if (order.driver_id) await run("UPDATE drivers SET rating_sum=rating_sum+?,rating_n=rating_n+1 WHERE user_id=?", stars, order.driver_id);
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/store/config") {
    const user = await apiUser(ctx, ["STORE"]);
    const store = await first<{ lat: number | null; lng: number | null }>("SELECT lat,lng FROM stores WHERE user_id=?", user.id);
    if (!store) throw new ApiError(404, "not found");
    return store;
  }
  if (method === "PATCH" && path === "/api/store/location") {
    const user = await apiUser(ctx, ["STORE"]);
    const [lat, lng] = coordinates(body, "lat", "lng");
    if (lat == null || lng == null) throw new ApiError(400, "bad coordinates");
    await run("UPDATE stores SET lat=?,lng=? WHERE user_id=?", lat, lng, user.id);
    return { ok: 1 };
  }
  if (method === "POST" && path === "/api/store/orders") return orderCreate(await apiUser(ctx, ["STORE"]), body);
  if (method === "GET" && path === "/api/store/orders") {
    const user = await apiUser(ctx, ["STORE"]);
    return all("SELECT id,pickup,dropoff,details,urgent,status,order_value,is_paid,COALESCE(agreed_price,delivery_price) agreed_price,notes,contact,created,loyalty_reward_id FROM orders WHERE customer_id=? AND kind='STORE' ORDER BY id DESC", user.id);
  }
  const storeCancelMatch = path.match(/^\/api\/store\/orders\/(\d+)\/cancel$/);
  if (method === "POST" && storeCancelMatch) {
    const user = await apiUser(ctx, ["STORE"]);
    const order = await getOrder(Number(storeCancelMatch[1]), user);
    if (["ORDER_PICKED_UP", "ON_THE_WAY_TO_CUSTOMER", "DRIVER_ARRIVED_DESTINATION", "DELIVERED", "CANCELLED"].includes(order.status)) throw new ApiError(409, "cannot cancel now");
    await run("UPDATE offers SET status='CANCELLED' WHERE order_id=? AND status='PENDING'", order.id);
    if (order.driver_id) await notifyUser(order.driver_id, `تم إلغاء الطلب #${order.id}`, { orderId: order.id });
    await setStatus(order, "CANCELLED", user.id);
    return { ok: 1 };
  }

  if (method === "GET" && path === "/api/loyalty") {
    const user = await apiUser(ctx, ["CUSTOMER", "STORE"]);
    const { loyaltyUserStatus } = await import("./loyalty");
    return loyaltyUserStatus(user);
  }
  return NO_ROUTE;
}

export async function orderById(orderId: number): Promise<Order | null> {
  return first<Order>("SELECT * FROM orders WHERE id=?", orderId);
}

export async function applyOrderStatus(order: Order, status: string, actorId: number): Promise<void> {
  await setStatus(order, status, actorId);
}

export async function driverOrderAccess(orderId: number, user: MobileUser): Promise<Order> {
  return getOrder(orderId, user);
}

export async function proposePrice(orderId: number, driver: MobileUser, value: unknown) {
  const offer = await first<{ id: number; expires: number }>("SELECT id,expires FROM offers WHERE order_id=? AND driver_id=? AND status='PENDING' AND expires>=?", orderId, driver.id, now());
  if (!offer) throw new ApiError(409, "offer not available");
  const order = await orderById(orderId);
  const driverData = await first<{ outstanding: number; blocked_until: number; available: number }>("SELECT outstanding,blocked_until,available FROM drivers WHERE user_id=?", driver.id);
  const active = await first<{ count: number }>("SELECT COUNT(*) count FROM orders WHERE driver_id=? AND status NOT IN ('DELIVERED','CANCELLED')", driver.id);
  if (!order || order.status !== "SEARCHING_DRIVER" || order.driver_id != null || !driverData) throw new ApiError(409, "offer not available");
  if (driverData.outstanding >= await setting("custody_cap") || driverData.blocked_until > now() || !driverData.available || Number(active?.count ?? 0) >= await setting("max_active_orders")) throw new ApiError(409, "not eligible");
  const price = roundedPrice(value);
  const update = await run("UPDATE orders SET driver_id=?,agreed_price=NULL,delivery_price=NULL,price_source=NULL,proposed_price=?,price_status='PENDING_CUSTOMER',price_expires=? WHERE id=? AND driver_id IS NULL AND status='SEARCHING_DRIVER'", driver.id, price, now() + priceResponseTimeout, orderId);
  if (!update.changes) throw new ApiError(409, "offer not available");
  await run("UPDATE offers SET status='ACCEPTED' WHERE id=? AND status='PENDING'", offer.id);
  await run("UPDATE offers SET status='CLOSED' WHERE order_id=? AND status='PENDING'", orderId);
  if (Number(active?.count ?? 0) + 1 >= await setting("max_active_orders")) await run("DELETE FROM offers WHERE driver_id=? AND status='PENDING'", driver.id);
  await run("INSERT INTO order_price_history(order_id,price,at,actor_id,reason) VALUES(?,?,?,?,?)", orderId, price, now(), driver.id, "عرض سعر - مهلة موافقة 30 ثانية");
  await setStatus({ ...order, driver_id: driver.id, proposed_price: price }, "PRICE_PENDING", driver.id);
  await notifyUser(driver.id, `تم إرسال عرضك بقيمة ${price} د.ل للطلب #${orderId}. بانتظار موافقة طالب الخدمة خلال 30 ثانية.`, { orderId, kind: "price" });
  return { ok: 1, status: "PRICE_PENDING", proposed_price: price };
}

export async function driverOrders(user: MobileUser): Promise<Record<string, unknown>[]> {
  const activeOnly = "o.status NOT IN ('DELIVERED','CANCELLED')";
  return all(`SELECT o.id,o.customer_id,o.service_id,o.pickup,o.dropoff,o.details,o.urgent,o.status,o.driver_id,COALESCE(o.agreed_price,o.delivery_price) agreed_price,o.proposed_price,o.price_status,o.loyalty_reward_id,o.created,o.confirmed,o.kind,
    o.order_value,o.is_paid,o.notes,o.pickup_lat,o.pickup_lng,o.dropoff_lat,o.dropoff_lng,
    CASE WHEN ${activeOnly} THEN c.name END customer_name,CASE WHEN ${activeOnly} THEN c.phone END customer_phone,
    CASE WHEN ${activeOnly} AND o.kind='STORE' THEN s.address END store_address,CASE WHEN ${activeOnly} THEN o.contact END contact
    FROM orders o JOIN "User" c ON c.id=o.customer_id LEFT JOIN stores s ON s.user_id=o.customer_id WHERE o.driver_id=? ORDER BY o.id DESC`, user.id);
}

export async function driverOfferList(userId: number): Promise<Record<string, unknown>[]> {
  const activeOrder = await first<{ id: number }>("SELECT id FROM orders WHERE driver_id=? AND status NOT IN ('DELIVERED','CANCELLED') ORDER BY id DESC LIMIT 1", userId);
  const driverActiveOrderId = activeOrder ? Number(activeOrder.id) : null;
  const orders = await all<Record<string, unknown>>(`SELECT f.order_id,f.expires,f.distance_m,COALESCE(o.agreed_price,o.delivery_price) agreed_price,o.loyalty_reward_id,o.urgent,o.pickup,o.dropoff,o.details,o.kind,o.order_value,o.is_paid,o.notes,
    CASE WHEN o.kind='STORE' THEN s.store_name END store_name,CASE WHEN o.kind='STORE' THEN s.address END store_address
    FROM offers f JOIN orders o ON o.id=f.order_id LEFT JOIN stores s ON s.user_id=o.customer_id
    WHERE f.driver_id=? AND f.status='PENDING' AND o.status='SEARCHING_DRIVER' AND o.driver_id IS NULL AND (? IS NULL OR o.id<>?)
    ORDER BY o.created DESC,o.id DESC`, userId, driverActiveOrderId, driverActiveOrderId);
  console.log('[NEARBY_FILTER] returning', orders.length, 'orders, active:', driverActiveOrderId);
  return orders;
}

export async function dispatchNewOrders(): Promise<void> {
  await dispatch();
}

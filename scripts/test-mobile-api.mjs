import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const stamp = Date.now().toString().slice(-7).padStart(7, "0");
const password = "TalbistaMobileTest-2026!";
const credentials = {
  customer: { phone: `091${stamp}01`, password },
  store: { phone: `091${stamp}02`, password },
  admin: { phone: `091${stamp}03`, password },
  pendingDriver: { phone: `091${stamp}04`, password },
  rejectedDriver: { phone: `091${stamp}05`, password },
  throttled: { phone: `091${stamp}06`, password },
  directDriver: { phone: `091${stamp}07`, password },
};
const passed = [];

async function request(path, { method = "GET", body, token, headers = {}, origin } = {}) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
  if (origin) requestHeaders.set("Origin", origin);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function expect(path, options, status = 200) {
  const result = await request(path, options);
  assert.equal(result.response.status, status, `${options?.method ?? "GET"} ${path}: expected ${status}, got ${result.response.status}; body=${JSON.stringify(result.data)}`);
  return result.data;
}

function pass(label) {
  passed.push(label);
}

function seedPrimaryAdmin(userId) {
  const id = Number(userId);
  assert.ok(Number.isSafeInteger(id) && id > 0, "admin fixture id must be a positive integer");
  const sql = `UPDATE "User" SET role='ADMIN' WHERE id=${id}; INSERT OR REPLACE INTO kv(k,v) VALUES('primary_admin_id','${id}');`;
  execFileSync("npx", ["wrangler", "d1", "execute", "talbista-auth", "--local", "--command", sql], { stdio: "ignore" });
}

function jpegData() {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, ...Array.from({ length: 128 }, (_, index) => index % 251), 0xff, 0xd9]);
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

const health = await expect("/api/test", { origin: "https://localhost" });
assert.deepEqual(health, { ok: true });
const preflight = await request("/api/login/", {
  method: "OPTIONS",
  origin: "capacitor://localhost",
  headers: {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
  },
});
assert.equal(preflight.response.status, 204);
assert.equal(preflight.response.headers.get("access-control-allow-origin"), "capacitor://localhost");
assert.match(preflight.response.headers.get("access-control-allow-headers") ?? "", /Idempotency-Key/i);
const pagesPreflight = await request("/api/login", {
  method: "OPTIONS",
  origin: "https://talbista.pages.dev",
  headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" },
});
assert.equal(pagesPreflight.response.status, 204);
assert.equal(pagesPreflight.response.headers.get("access-control-allow-origin"), "https://talbista.pages.dev");
const deniedPreflight = await request("/api/login", {
  method: "OPTIONS",
  origin: "https://attacker.invalid",
  headers: { "Access-Control-Request-Method": "POST" },
});
assert.equal(deniedPreflight.response.status, 204);
assert.equal(deniedPreflight.response.headers.get("access-control-allow-origin"), null);
pass("health, explicit Capacitor/Pages CORS and untrusted-origin denial");

for (let attempt = 0; attempt < 5; attempt += 1) {
  await expect("/api/login/", { method: "POST", body: { phone: credentials.throttled.phone, password: "IncorrectPassword!" } }, 401);
}
await expect("/api/login", { method: "POST", body: { phone: credentials.throttled.phone, password: "IncorrectPassword!" } }, 429);
pass("durable login throttle after five failed attempts");

const customerCreated = await expect("/api/register/", {
  method: "POST",
  body: { name: "عميل اختبار", ...credentials.customer },
}, 200);
assert.ok(customerCreated.id);
await expect("/api/register", { method: "POST", body: { name: "عميل مكرر", ...credentials.customer } }, 409);
const customerLogin = await expect("/api/login/", { method: "POST", body: credentials.customer });
assert.equal(customerLogin.role, "CUSTOMER");
assert.equal(typeof customerLogin.token, "string");
const customerToken = customerLogin.token;
const customerMe = await expect("/api/me", { token: customerToken });
assert.equal(customerMe.role, "CUSTOMER");
assert.equal(customerMe.phone, credentials.customer.phone);
assert.equal(Object.hasOwn(customerMe, "password"), false);
await expect("/api/me", { method: "PATCH", token: customerToken, body: { name: "عميل طلبيستا" } });
assert.ok((await expect("/api/services", { token: customerToken })).length > 0);
assert.ok((await expect("/api/loyalty", { token: customerToken })).completed >= 0);
await expect("/api/notifications", { token: customerToken });
await expect("/api/notifications/read", { method: "POST", token: customerToken, body: {} });
await expect("/api/support", { token: customerToken });
await expect("/api/support/report", { method: "POST", token: customerToken, body: { message: "بلاغ اختبار تكامل محلي" } });
const diagnostic = await expect("/api/diagnostics", {
  method: "POST",
  token: customerToken,
  body: {
    report_id: crypto.randomUUID(), category: "network", platform: "android", app_version: "1.0.2",
    code: "TEST_ROUTE", route: "/orders", http_status: 503, online: false, push_ready: true,
    retry_attempted: true, retry_succeeded: false,
  },
});
assert.ok(diagnostic.report_id);
const appUpdate = await expect("/api/app/update/android/1.0.2");
assert.equal(appUpdate.current_version, "1.0.2");
pass("customer registration, login, profile, support, loyalty, notifications, diagnostics and app-update APIs");

const adminCreated = await expect("/api/register", {
  method: "POST",
  body: { name: "مدير اختبار محلي", ...credentials.admin },
});
seedPrimaryAdmin(adminCreated.id);
const adminLogin = await expect("/api/login", { method: "POST", body: credentials.admin });
assert.equal(adminLogin.role, "ADMIN");
assert.equal(adminLogin.admin_authorized, true);
const adminToken = adminLogin.token;
assert.ok(Array.isArray(await expect("/api/admin/audit", { token: adminToken })));
await expect("/api/admin/stats", { token: customerToken }, 403);
const directDriver = await expect("/api/admin/drivers", {
  method: "POST", token: adminToken,
  body: {
    name: "سائق مُضاف من الإدارة", ...credentials.directDriver, car: "كيا", model: "ريو", year: 2021,
    color: "أزرق", plate: `D${stamp}`,
  },
});
assert.ok(directDriver.id);

const rejectedApplication = await expect("/api/driver-applications", {
  method: "POST",
  body: {
    name: "سائق مرفوض", ...credentials.rejectedDriver, car: "تويوتا", model: "كورولا", year: 2022,
    color: "أبيض", plate: `B${stamp}`, id_document: jpegData(), license_document: jpegData(),
  },
}, 200);
assert.equal(rejectedApplication.status, "PENDING");
await expect("/api/login", { method: "POST", body: credentials.rejectedDriver }, 403);
const appDetails = await expect(`/api/admin/driver-applications/${rejectedApplication.id}`, { token: adminToken });
assert.equal(appDetails.status, "PENDING");
await expect(`/api/admin/driver-applications/${rejectedApplication.id}/reject`, { method: "POST", token: adminToken, body: { note: "رفض اختبار محلي" } });

const driverApplication = await expect("/api/driver-applications/", {
  method: "POST",
  body: {
    name: "سائق اختبار", ...credentials.pendingDriver, car: "تويوتا", model: "يارس", year: 2023,
    color: "أبيض", plate: `T${stamp}`, id_document: jpegData(), license_document: jpegData(),
  },
}, 200);
assert.equal(driverApplication.status, "PENDING");
const applications = await expect("/api/admin/driver-applications", { token: adminToken });
assert.ok(applications.some((item) => item.id === driverApplication.id));
const approved = await expect(`/api/admin/driver-applications/${driverApplication.id}/approve`, { method: "POST", token: adminToken, body: {} });
assert.equal(approved.status, "APPROVED");
const driverId = approved.driver_id;
const driverLogin = await expect("/api/login", { method: "POST", body: credentials.pendingDriver });
assert.equal(driverLogin.role, "DRIVER");
let driverToken = driverLogin.token;
assert.equal((await expect("/api/me", { token: driverToken })).role, "DRIVER");
await expect("/api/driver/available", { method: "POST", token: driverToken, body: { available: true } });
await expect("/api/driver/location", { method: "POST", token: driverToken, body: { lat: 32.12, lng: 20.08 } });
await expect("/api/driver/violations", { token: driverToken });
await expect("/api/driver/finance", { token: driverToken });
await expect("/api/driver/ledger", { token: driverToken });
await expect("/api/driver/ledger/credits", { token: driverToken });
await expect("/api/push/key", { token: driverToken });
await expect("/api/push/subscribe", {
  method: "POST", token: driverToken,
  body: { endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${stamp}` },
});
await expect("/api/push/unsubscribe", {
  method: "POST", token: driverToken,
  body: { endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${stamp}` },
});
const fakeFcmToken = `TalbistaIntegrationFakeToken-${stamp}-do-not-send`;
await expect("/api/devices/register", { method: "POST", token: driverToken, body: { token: fakeFcmToken, channel_v: 7 } });
const tokenCheck = await expect("/api/devices/register", { method: "POST", token: driverToken, body: { token: fakeFcmToken, channel_v: 7 } });
assert.equal(tokenCheck.ok, 1);
pass("driver application/review/approval, role access, availability, location, finance, ledger, push and device APIs");

const customerOrderBody = {
  service_id: 1, pickup: "ميدان اختبار التكامل", dropoff: "شارع اختبار التكامل", details: "طلب آلي تجريبي",
  urgent: true, pickup_lat: 32.12, pickup_lng: 20.08, dropoff_lat: 32.13, dropoff_lng: 20.09,
};
const orderKey = `mobile-order-${stamp}-0001`;
const orderFirst = await expect("/api/orders/", {
  method: "POST", token: customerToken, headers: { "Idempotency-Key": orderKey }, body: customerOrderBody,
});
assert.ok(orderFirst.id);
const orderReplay = await expect("/api/orders", {
  method: "POST", token: customerToken, headers: { "Idempotency-Key": orderKey }, body: customerOrderBody,
});
assert.deepEqual(orderReplay, orderFirst);
await expect("/api/orders", {
  method: "POST", token: customerToken, headers: { "Idempotency-Key": orderKey },
  body: { ...customerOrderBody, dropoff: "وجهة مختلفة" },
}, 409);
const customerOrders = await expect("/api/orders", { token: customerToken });
assert.equal(customerOrders.filter((order) => Number(order.id) === Number(orderFirst.id)).length, 1);
assert.equal(Number((await expect(`/api/orders/${orderFirst.id}`, { token: customerToken })).id), Number(orderFirst.id));
const offers = await expect("/api/driver/offers", { token: driverToken });
assert.ok(offers.some((offer) => Number(offer.order_id) === Number(orderFirst.id)), "driver should receive the dispatched order offer");
await expect(`/api/driver/offers/${orderFirst.id}/reject`, { method: "POST", token: driverToken, body: {} });
assert.ok((await expect("/api/driver/offers", { token: driverToken })).some((offer) => Number(offer.order_id) === Number(orderFirst.id)));
await expect(`/api/driver/offers/${orderFirst.id}/accept`, {
  method: "POST", token: driverToken, body: { agreed_price: 5.5 },
});
await expect(`/api/driver/orders/${orderFirst.id}/cancel`, { method: "POST", token: driverToken, body: {} });
assert.ok((await expect("/api/driver/offers", { token: driverToken })).some((offer) => Number(offer.order_id) === Number(orderFirst.id)));
await expect(`/api/driver/offers/${orderFirst.id}/accept`, {
  method: "POST", token: driverToken, body: { agreed_price: 5.5 },
});
const declinedPrice = await expect(`/api/orders/${orderFirst.id}/price-response`, {
  method: "POST", token: customerToken, body: { accept: false },
});
assert.equal(declinedPrice.status, "SEARCHING_DRIVER");
assert.ok((await expect("/api/driver/offers", { token: driverToken })).some((offer) => Number(offer.order_id) === Number(orderFirst.id)));
await expect(`/api/driver/offers/${orderFirst.id}/accept`, {
  method: "POST", token: driverToken, body: { agreed_price: 5.5 },
});
const priceResponse = await expect(`/api/orders/${orderFirst.id}/price-response`, {
  method: "POST", token: customerToken, body: { accept: true },
});
assert.equal(priceResponse.status, "DRIVER_ASSIGNED");
await expect(`/api/admin/orders/${orderFirst.id}/assign`, { method: "POST", token: adminToken, body: { driver_id: driverId } });
const priceHistory = await expect(`/api/admin/orders/${orderFirst.id}/price-history`, { token: adminToken });
assert.ok(priceHistory.length > 0);
for (const status of ["DRIVER_ON_THE_WAY", "DRIVER_ARRIVED", "ORDER_PICKED_UP", "ON_THE_WAY_TO_CUSTOMER", "DRIVER_ARRIVED_DESTINATION", "DELIVERED"]) {
  await expect(`/api/driver/orders/${orderFirst.id}/status`, { method: "POST", token: driverToken, body: { status } });
}
await expect(`/api/orders/${orderFirst.id}/confirm`, { method: "POST", token: customerToken, body: {} });
await expect(`/api/orders/${orderFirst.id}/rate`, { method: "POST", token: customerToken, body: { stars: 5, comment: "اختبار محلي" } });
await expect(`/api/orders/${orderFirst.id}/rate`, { method: "POST", token: customerToken, body: { stars: 5 } }, 409);
const completedOrders = await expect("/api/driver/orders", { token: driverToken });
assert.ok(completedOrders.some((order) => Number(order.id) === Number(orderFirst.id)));
pass("customer order idempotency, driver offer, price approval, full delivery state flow, confirmation and rating");

await expect("/api/driver/available", { method: "POST", token: driverToken, body: { available: false } });
const customerCancelOrder = await expect("/api/orders", {
  method: "POST", token: customerToken, headers: { "Idempotency-Key": `customer-cancel-${stamp}` },
  body: customerOrderBody,
});
await expect(`/api/orders/${customerCancelOrder.id}/cancel`, { method: "POST", token: customerToken, body: {} });
const adminCancelOrder = await expect("/api/orders", {
  method: "POST", token: customerToken, headers: { "Idempotency-Key": `admin-cancel-${stamp}` },
  body: customerOrderBody,
});
await expect(`/api/admin/orders/${adminCancelOrder.id}/cancel`, { method: "POST", token: adminToken, body: {} });
pass("customer and administrator cancellation of unassigned orders");

const storeCreated = await expect("/api/register/store", {
  method: "POST",
  body: {
    store_name: "متجر اختبار", manager_name: "مدير المتجر", phone: credentials.store.phone,
    address: "عنوان اختبار", activity_type: "مطعم", password: credentials.store.password,
  },
});
assert.ok(storeCreated.id);
const storeLogin = await expect("/api/login", { method: "POST", body: credentials.store });
assert.equal(storeLogin.role, "STORE");
const storeToken = storeLogin.token;
await expect("/api/store/config", { token: storeToken });
await expect("/api/store/location", { method: "PATCH", token: storeToken, body: { lat: 32.11, lng: 20.07 } });
const storeOrderBody = {
  pickup: "عنوان متجر الاختبار", contact: "0910000000", dropoff: "وجهة متجر الاختبار", details: "طلب متجر تجريبي",
  urgent: true, is_paid: false, order_value: 20, notes: "اختبار محلي", dropoff_lat: 32.14, dropoff_lng: 20.1,
};
const storeOrderKey = `mobile-store-${stamp}-0001`;
const storeOrder = await expect("/api/store/orders/", {
  method: "POST", token: storeToken, headers: { "Idempotency-Key": storeOrderKey }, body: storeOrderBody,
});
const storeReplay = await expect("/api/store/orders", {
  method: "POST", token: storeToken, headers: { "Idempotency-Key": storeOrderKey }, body: storeOrderBody,
});
assert.deepEqual(storeReplay, storeOrder);
assert.equal((await expect("/api/store/orders", { token: storeToken })).filter((order) => Number(order.id) === Number(storeOrder.id)).length, 1);
await expect(`/api/store/orders/${storeOrder.id}/cancel`, { method: "POST", token: storeToken, body: {} });
await expect(`/api/orders/${storeOrder.id}`, { token: customerToken }, 404);
pass("store registration, configuration, location, order creation/replay, cancellation and ownership isolation");

const adminReadPaths = [
  "/api/admin/diagnostics", "/api/admin/system-health", "/api/admin/stats", "/api/admin/customers",
  "/api/admin/services", "/api/admin/drivers", "/api/admin/orders", "/api/admin/handovers",
  "/api/admin/ledger", "/api/admin/loyalty", "/api/admin/reports", "/api/admin/violations",
  "/api/admin/audit", "/api/admin/settings", "/api/admin/app-updates", "/api/admin/finance/drivers",
  "/api/admin/finance/summary", "/api/admin/settings/text",
];
for (const path of adminReadPaths) await expect(path, { token: adminToken });
const settings = await expect("/api/admin/settings", { token: adminToken });
const writableSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "driver_limit"));
await expect("/api/admin/settings", { method: "PUT", token: adminToken, body: writableSettings });
const textSettings = await expect("/api/admin/settings/text", { token: adminToken });
await expect("/api/admin/settings/text", { method: "PUT", token: adminToken, body: textSettings });
const appSettings = await expect("/api/admin/app-updates", { token: adminToken });
await expect("/api/admin/app-updates", { method: "PUT", token: adminToken, body: appSettings });
await expect("/api/admin/loyalty/settings", {
  method: "PUT", token: adminToken,
  body: { store_orders_required: 100, customer_orders_required: 10, store_free_start: "14:00", store_free_end: "19:00" },
});
const newService = await expect("/api/admin/services", { method: "POST", token: adminToken, body: { name: `خدمة اختبار ${stamp}` } });
await expect(`/api/admin/services/${newService.id}`, { method: "PATCH", token: adminToken, body: { active: false } });
await expect(`/api/admin/services/${newService.id}`, { method: "PATCH", token: adminToken, body: { active: true } });
const reportRows = await expect("/api/admin/reports", { token: adminToken });
const report = reportRows.find((row) => row.message === "بلاغ اختبار تكامل محلي");
assert.ok(report, "admin should see support report");
await expect(`/api/admin/reports/${report.id}/resolve`, { method: "POST", token: adminToken, body: {} });
await expect(`/api/admin/finance/drivers/${driverId}`, { token: adminToken });

const adjustment = await expect("/api/admin/finance/adjustments", {
  method: "POST", token: adminToken,
  body: { driver_id: driverId, amount: 1, account: "ENTITLEMENT", reason: "تعديل اختبار محلي", request_id: `test-adjust-${stamp}` },
});
assert.ok(adjustment.txn_id);
await expect("/api/admin/finance/corrections", {
  method: "POST", token: adminToken,
  body: { txn_id: adjustment.txn_id, reason: "عكس تعديل الاختبار" },
});
const directSettle = await expect(`/api/admin/finance/drivers/${driverId}/settle`, {
  method: "POST", token: adminToken,
  body: { amount: 1, request_id: `test-settle-${stamp}`, note: "تسوية اختبار محلية" },
});
assert.equal(directSettle.ok, 1);
await expect("/api/driver/handover-request", { method: "POST", token: driverToken, body: {} });
const handovers = await expect("/api/admin/handovers", { token: adminToken });
const handover = handovers.find((item) => Number(item.driver_id) === Number(driverId) && item.status === "REQUESTED");
assert.ok(handover);
await expect(`/api/admin/handovers/${handover.id}/confirm`, { method: "POST", token: adminToken, body: {} });
const violation = await expect(`/api/admin/drivers/${driverId}/violations`, {
  method: "POST", token: adminToken, body: { reason: "مخالفة اختبار محلية" },
});
assert.ok(violation.id);
await expect(`/api/admin/violations/${violation.id}/cancel`, { method: "POST", token: adminToken, body: { note: "إلغاء اختبار محلي" } });
const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`;
await expect(`/api/admin/drivers/${driverId}/photo`, { method: "POST", token: adminToken, body: { image: png } });
await expect(`/api/admin/drivers/${driverId}`, { method: "PATCH", token: adminToken, body: { car: "تويوتا", active: true } });
const healthSummary = await expect("/api/admin/system-health", { token: adminToken });
assert.ok(Number(healthSummary.registered_devices) >= 1);
await expect("/api/devices/unregister", { method: "POST", token: driverToken, body: { token: fakeFcmToken } });
pass("admin authorization, read APIs, app/settings/service updates, reports, immutable ledger, settlement, handover and violation/photo/driver operations");

await expect("/api/admin/drivers/invalid", { token: adminToken }, 404);
const secondaryAdminLogin = await expect("/api/login", { method: "POST", body: credentials.admin });
await expect("/api/admin/password", {
  method: "POST", token: adminToken,
  body: { old_password: credentials.admin.password, new_password: "TalbistaAdminReset-2026!" },
});
await expect("/api/admin/stats", { token: secondaryAdminLogin.token }, 401);
await expect("/api/admin/stats", { token: adminToken });
const newAdminLogin = await expect("/api/login", {
  method: "POST", body: { phone: credentials.admin.phone, password: "TalbistaAdminReset-2026!" },
});
assert.equal(newAdminLogin.admin_authorized, true);
await expect("/api/admin/sessions/revoke", { method: "POST", token: newAdminLogin.token, body: { user_id: driverId } });
await expect("/api/driver/orders", { token: driverToken }, 401);
await expect(`/api/admin/drivers/${driverId}/password`, { method: "POST", token: newAdminLogin.token, body: { password: "TalbistaDriverReset-2026!" } });
const resetDriverLogin = await expect("/api/login", { method: "POST", body: { phone: credentials.pendingDriver.phone, password: "TalbistaDriverReset-2026!" } });
assert.equal(resetDriverLogin.role, "DRIVER");
await expect("/api/logout", { method: "POST", token: customerToken, body: {} });
await expect("/api/me", { token: customerToken }, 401);
pass("session revocation, admin and driver password reset, and logout invalidation");

console.log(`PASS ${passed.length} integration groups against ${baseUrl}`);
for (const item of passed) console.log(`PASS ${item}`);
console.log("NOTICE: tests write synthetic fixtures only to Wrangler's local D1 database; no production data is used.");

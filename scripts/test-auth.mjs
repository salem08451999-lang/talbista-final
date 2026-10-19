import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const phone = `09${String(Date.now()).slice(-8)}`;
const password = "TalbistaIntegration-2026!";

async function request(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

const health = await request("/api/test");
assert.equal(health.response.status, 200, "GET /api/test should return HTTP 200");
assert.deepEqual(health.data, { ok: true }, "GET /api/test should return {ok:true}");

const extraField = await request("/api/auth/register", {
  method: "POST",
  body: { phone, password, city: "Benghazi" },
});
assert.equal(extraField.response.status, 400, "registration must reject fields beyond phone/password");

const registration = await request("/api/auth/register", {
  method: "POST",
  body: { phone, password },
});
assert.equal(registration.response.status, 201, "registration should create an account");
assert.equal(registration.data?.ok, true);
assert.equal(registration.data?.user?.phone, phone);
assert.equal(typeof registration.data?.token, "string");
assert.equal("password" in registration.data.user, false, "password hash must not be returned");

const duplicate = await request("/api/auth/register", {
  method: "POST",
  body: { phone, password },
});
assert.equal(duplicate.response.status, 409, "duplicate phone should be rejected");

const wrongPassword = await request("/api/auth/login", {
  method: "POST",
  body: { phone, password: "IncorrectPassword-2026!" },
});
assert.equal(wrongPassword.response.status, 401, "incorrect password should not authenticate");

const login = await request("/api/auth/login", {
  method: "POST",
  body: { phone, password },
});
assert.equal(login.response.status, 200, "valid credentials should authenticate");
assert.equal(login.data?.ok, true);
assert.equal(login.data?.user?.phone, phone);
assert.equal(typeof login.data?.token, "string");
assert.equal("password" in login.data.user, false, "password hash must not be returned");

const noToken = await request("/api/auth/me");
assert.equal(noToken.response.status, 401, "session lookup must reject requests without a token");

const session = await request("/api/auth/me", { token: login.data.token });
assert.equal(session.response.status, 200, "valid bearer token should restore the user session");
assert.equal(session.data?.user?.id, login.data.user.id);
assert.equal(session.data?.user?.phone, phone);

console.log("PASS GET /api/test");
console.log("PASS phone/password-only registration and duplicate protection");
console.log("PASS password verification and signed-token login response");
console.log("PASS bearer-token session restoration");
console.log("PASS password hash is not exposed in API responses");

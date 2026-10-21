import { ApiError, first, now, run } from "./common";
import { currentMobileUser } from "./session";

type StoredRequest = {
  user_id: number;
  method: string;
  path: string;
  request_hash: string;
  response: string;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function hexDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function userIdFor(request: Request): Promise<number> {
  if (!request.headers.has("Authorization")) return 0;
  try {
    return (await currentMobileUser(request)).id;
  } catch (error) {
    if (error instanceof ApiError) return 0;
    throw error;
  }
}

async function replayOrConflict(
  prior: StoredRequest,
  userId: number,
  method: string,
  path: string,
  requestHash: string,
): Promise<unknown> {
  if (prior.user_id !== userId || prior.method !== method || prior.path !== path || prior.request_hash !== requestHash) {
    throw new ApiError(409, "idempotency conflict");
  }
  if (prior.response === "__PENDING__") throw new ApiError(409, "request is still processing; retry later with the same key");
  try {
    return JSON.parse(prior.response) as unknown;
  } catch {
    throw new ApiError(503, "previous request result is unavailable");
  }
}

export async function withIdempotency<T>(
  request: Request,
  method: string,
  path: string,
  body: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T | unknown> {
  const rawKey = request.headers.get("Idempotency-Key")?.trim();
  const orderCreation = method === "POST" && (path === "/api/orders" || path === "/api/store/orders");
  if (!rawKey || !orderCreation) return operation();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(rawKey)) throw new ApiError(400, "invalid idempotency key");

  const userId = await userIdFor(request);
  const key = await hexDigest(rawKey);
  const requestHash = await hexDigest(stable({ body, userId, method, path }));
  const prior = await first<StoredRequest>("SELECT user_id,method,path,request_hash,response FROM idempotency_requests WHERE key=?", key);
  if (prior) return replayOrConflict(prior, userId, method, path, requestHash);

  const inserted = await run(
    "INSERT OR IGNORE INTO idempotency_requests(key,user_id,method,path,response,created,request_hash) VALUES(?,?,?,?,?,?,?)",
    key, userId, method, path, "__PENDING__", now(), requestHash,
  );
  if (!inserted.changes) {
    const raced = await first<StoredRequest>("SELECT user_id,method,path,request_hash,response FROM idempotency_requests WHERE key=?", key);
    if (!raced) throw new ApiError(503, "idempotency receipt unavailable");
    return replayOrConflict(raced, userId, method, path, requestHash);
  }

  try {
    const result = await operation();
    if (typeof result === "symbol") {
      await run("DELETE FROM idempotency_requests WHERE key=? AND response='__PENDING__'", key);
      return result;
    }
    const response = JSON.stringify(result);
    if (response === undefined) throw new ApiError(500, "invalid response");
    await run("UPDATE idempotency_requests SET response=? WHERE key=? AND response='__PENDING__'", response, key);
    return result;
  } catch (error) {
    // Keep a 5xx reservation: the operation may have committed before an upstream
    // failure, so replaying it as a new operation could duplicate a business action.
    if (error instanceof ApiError && error.status < 500) {
      await run("DELETE FROM idempotency_requests WHERE key=? AND response='__PENDING__'", key);
    }
    throw error;
  }
}

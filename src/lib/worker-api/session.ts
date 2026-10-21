import { getBearerToken, signAuthToken, verifyAuthToken } from "@/src/lib/auth";
import { ApiError, first, now, run, runtimeBindings, type MobileRole, type MobileUser } from "./common";

function toHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sessionKey(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export async function isPrimaryAdmin(userId: number): Promise<boolean> {
  const user = await first<{ id: number; role: string; active: number }>(
    'SELECT id, role, active FROM "User" WHERE id = ?', userId,
  );
  if (!user || user.role !== "ADMIN" || !user.active) return false;
  const primary = await first<{ v: string }>("SELECT v FROM kv WHERE k = 'primary_admin_id'");
  return primary?.v === String(userId);
}

export async function createMobileSession(
  user: Pick<MobileUser, "id" | "phone" | "role" | "name" | "active" | "photo">,
  requestedContext?: unknown,
) {
  const bindings = runtimeBindings();
  const secret = bindings.AUTH_TOKEN_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new ApiError(503, "authentication unavailable");
  if (!user.active) throw new ApiError(403, "account disabled");
  const token = await signAuthToken(user, secret);
  const tokenHash = await sessionKey(token);
  const expires = now() + 7 * 86400;
  let role: MobileRole = user.role;
  const primaryAdmin = role === "ADMIN" && await isPrimaryAdmin(user.id);
  if (requestedContext === "CUSTOMER" && primaryAdmin) {
    role = "CUSTOMER";
    await run("INSERT OR REPLACE INTO session_contexts(token,role) VALUES(?,?)", tokenHash, "CUSTOMER");
  }
  await run("INSERT INTO sessions(token,user_id,exp) VALUES(?,?,?)", tokenHash, user.id, expires);
  return {
    token,
    role,
    name: user.name,
    admin_authorized: role === "ADMIN" && primaryAdmin,
  };
}

export async function currentMobileUser(request: Request, allowed?: MobileRole[]): Promise<MobileUser> {
  const token = getBearerToken(request);
  if (!token) throw new ApiError(401, "unauthorized");
  const secret = runtimeBindings().AUTH_TOKEN_SECRET;
  if (typeof secret !== "string" || secret.length < 32) throw new ApiError(503, "authentication unavailable");

  let userId: number;
  try {
    userId = await verifyAuthToken(token, secret);
  } catch {
    throw new ApiError(401, "unauthorized");
  }
  const key = await sessionKey(token);
  const session = await first<{ user_id: number; exp: number }>(
    "SELECT user_id, exp FROM sessions WHERE token = ? AND exp > ?", key, now(),
  );
  if (!session || session.user_id !== userId) throw new ApiError(401, "session expired");

  const user = await first<MobileUser>(
    'SELECT id, phone, password, name, role, active, photo FROM "User" WHERE id = ?', userId,
  );
  if (!user || !user.active) throw new ApiError(401, "account unavailable");
  const context = await first<{ role: string }>("SELECT role FROM session_contexts WHERE token = ?", key);
  if (context?.role === "CUSTOMER" && user.role === "ADMIN" && await isPrimaryAdmin(user.id)) user.role = "CUSTOMER";
  if (user.role === "ADMIN" && !(await isPrimaryAdmin(user.id))) throw new ApiError(403, "admin access not authorized");
  user.sessionToken = key;
  if (allowed && !allowed.includes(user.role)) throw new ApiError(403, "forbidden");
  return user;
}

export async function requireMobileUser(request: Request, allowed?: MobileRole[]): Promise<MobileUser> {
  return currentMobileUser(request, allowed);
}

export async function revokeUserSessions(userId: number, except?: string): Promise<number> {
  if (except) {
    return (await run("DELETE FROM sessions WHERE user_id = ? AND token <> ?", userId, except)).changes;
  }
  return (await run("DELETE FROM sessions WHERE user_id = ?", userId)).changes;
}

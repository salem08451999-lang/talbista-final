import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export type MobileRole = "CUSTOMER" | "STORE" | "DRIVER" | "ADMIN";
export type MobileUser = {
  id: number;
  phone: string;
  password: string;
  name: string | null;
  role: MobileRole;
  active: number;
  photo: string | null;
  sessionToken?: string;
};

export type WorkerBindings = {
  DB?: D1Database;
  AUTH_TOKEN_SECRET?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FCM_PROJECT_ID?: string;
  VAPID_PUBLIC_KEY?: string;
  SUPPORT_PHONE?: string;
  SUPPORT_WHATSAPP?: string;
  ADMIN_PHONE?: string;
  [key: string]: unknown;
};

const allowedOrigins = new Set([
  "https://localhost",
  "capacitor://localhost",
  "http://localhost",
  "http://127.0.0.1",
]);

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function runtimeBindings(): WorkerBindings {
  const { env } = getCloudflareContext();
  return env as unknown as WorkerBindings;
}

export function d1(): D1Database {
  const database = runtimeBindings().DB;
  if (!database) throw new ApiError(503, "database unavailable");
  return database;
}

export function statement(sql: string, ...values: unknown[]): D1PreparedStatement {
  return d1().prepare(sql).bind(...(values as (string | number | null | ArrayBuffer | Uint8Array | boolean)[]));
}

export async function first<T>(sql: string, ...values: unknown[]): Promise<T | null> {
  return statement(sql, ...values).first<T>();
}

export async function all<T>(sql: string, ...values: unknown[]): Promise<T[]> {
  const result = await statement(sql, ...values).all<T>();
  return result.results ?? [];
}

export async function run(sql: string, ...values: unknown[]): Promise<{ changes: number; lastRowId: number | null }> {
  const result = await statement(sql, ...values).run();
  return {
    changes: Number(result.meta?.changes ?? 0),
    lastRowId: result.meta?.last_row_id == null ? null : Number(result.meta.last_row_id),
  };
}

export async function batch(statements: D1PreparedStatement[]): Promise<unknown[]> {
  return d1().batch(statements);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { status, headers });
}

export function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");
  headers.append("Vary", "Origin");
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Request-ID");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflight(request: Request): Response {
  return withCors(request, new Response(null, { status: 204 }));
}

export async function readJson(request: Request, maxBytes = 900_000): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > maxBytes) throw new ApiError(413, "payload too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ApiError(413, "payload too large");
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid JSON body");
  return parsed as Record<string, unknown>;
}

export function requireFields(body: Record<string, unknown>, ...keys: string[]): void {
  for (const key of keys) {
    if (body[key] === undefined || body[key] === null || body[key] === "") throw new ApiError(400, `missing ${key}`);
  }
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "invalid phone/password");
  const phone = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d{9,15}$/.test(phone)) throw new ApiError(400, "invalid phone/password");
  return phone;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength < 8 || new TextEncoder().encode(value).byteLength > 256) {
    throw new ApiError(400, "invalid phone/password");
  }
  return value;
}

export function asString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== "string") throw new ApiError(400, `invalid ${field}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, `invalid ${field}`);
  return normalized;
}

export function asNumber(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new ApiError(400, `invalid ${field}`);
  return parsed;
}

export function coordinates(body: Record<string, unknown>, latKey: string, lngKey: string): [number | null, number | null] {
  const lat = body[latKey];
  const lng = body[lngKey];
  if (lat == null && lng == null) return [null, null];
  const parsedLat = asNumber(lat, latKey, -90, 90);
  const parsedLng = asNumber(lng, lngKey, -180, 180);
  if (parsedLat === 0 && parsedLng === 0) throw new ApiError(400, "bad coordinates");
  return [parsedLat, parsedLng];
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function publicUser(user: Pick<MobileUser, "id" | "phone" | "name" | "role" | "active" | "photo">) {
  return {
    id: user.id,
    phone: user.phone,
    role: user.role,
    name: user.name,
    active: Boolean(user.active),
    photo: user.photo,
  };
}

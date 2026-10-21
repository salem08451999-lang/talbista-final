import { PrismaD1 } from "@prisma/adapter-d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jwtVerify, SignJWT } from "jose";
import type { D1Database } from "@cloudflare/workers-types";
import { PrismaClient } from "../generated/prisma/client";

type AuthBindings = {
  DB?: D1Database;
  AUTH_TOKEN_SECRET?: string;
};

type AuthServices = {
  prisma: PrismaClient;
  tokenSecret: string;
};

type Credentials = {
  phone: string;
  password: string;
};

type UserRecord = {
  id: number;
  phone: string;
  createdAt: Date | string;
};

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BITS = 256;
const PASSWORD_HASH_BYTES = PASSWORD_HASH_BITS / 8;
const textEncoder = new TextEncoder();

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export async function withAuthServices<T>(
  operation: (services: AuthServices) => Promise<T>,
): Promise<T> {
  const ctx = await getCloudflareContext({ async: true });
  const env = ctx.env as unknown as AuthBindings;

  if (!env?.DB) {
    throw new AuthConfigurationError("D1 binding is not configured");
  }
  if (!env.AUTH_TOKEN_SECRET || env.AUTH_TOKEN_SECRET.length < 32) {
    throw new AuthConfigurationError("Auth signing secret is not configured");
  }

  const prisma = new PrismaClient({ adapter: new PrismaD1(env.DB) });
  try {
    return await operation({ prisma, tokenSecret: env.AUTH_TOKEN_SECRET });
  } finally {
    await prisma.$disconnect();
  }
}

export function parseCredentials(value: unknown):
  | { credentials: Credentials; error?: never }
  | { credentials?: never; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "أرسل رقم الهاتف وكلمة المرور فقط." };
  }

  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(body, "phone") ||
    !Object.prototype.hasOwnProperty.call(body, "password")
  ) {
    return { error: "الحقول المطلوبة هي رقم الهاتف وكلمة المرور فقط." };
  }

  if (typeof body.phone !== "string" || typeof body.password !== "string") {
    return { error: "رقم الهاتف وكلمة المرور غير صالحين." };
  }

  const phone = body.phone.trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(phone)) {
    return { error: "أدخل رقم هاتف صحيحاً." };
  }

  const passwordBytes = textEncoder.encode(body.password).byteLength;
  if (passwordBytes < 8) {
    return { error: "يجب أن تتكوّن كلمة المرور من 8 أحرف على الأقل." };
  }
  if (passwordBytes > 256) {
    return { error: "كلمة المرور طويلة جداً." };
  }

  return { credentials: { phone, password: body.password } };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const saltBuffer = new ArrayBuffer(salt.byteLength);
  new Uint8Array(saltBuffer).set(salt);
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: PBKDF2_HASH,
      salt: saltBuffer,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    PASSWORD_HASH_BITS,
  );
  return new Uint8Array(derivedBits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePasswordHash(password, salt);
  return `${encodeBase64Url(salt)}:${encodeBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  storedValue: string,
): Promise<boolean> {
  const parts = storedValue.split(":");
  if (parts.length !== 2) return false;

  const salt = decodeBase64Url(parts[0]);
  const expectedHash = decodeBase64Url(parts[1]);
  if (
    !salt ||
    salt.byteLength !== PASSWORD_SALT_BYTES ||
    !expectedHash ||
    expectedHash.byteLength !== PASSWORD_HASH_BYTES
  ) {
    return false;
  }

  const actualHash = await derivePasswordHash(password, salt);
  let difference = 0;
  for (let index = 0; index < expectedHash.byteLength; index += 1) {
    difference |= expectedHash[index] ^ actualHash[index];
  }
  return difference === 0;
}

export function toPublicUser(user: UserRecord) {
  return {
    id: user.id,
    phone: user.phone,
    createdAt:
      user.createdAt instanceof Date
        ? user.createdAt.toISOString()
        : new Date(user.createdAt).toISOString(),
  };
}

export async function signAuthToken(
  user: Pick<UserRecord, "id" | "phone">,
  secret: string,
): Promise<string> {
  const key = textEncoder.encode(secret);
  return new SignJWT({ phone: user.phone })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("talbista-final")
    .setAudience("talbista-app")
    .setSubject(String(user.id))
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key);
}

export async function verifyAuthToken(
  token: string,
  secret: string,
): Promise<number> {
  const key = textEncoder.encode(secret);
  const { payload } = await jwtVerify(token, key, {
    algorithms: ["HS256"],
    issuer: "talbista-final",
    audience: "talbista-app",
  });

  const userId = Number(payload.sub);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new Error("Invalid token subject");
  }
  return userId;
}

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "P2002" ||
    (typeof candidate.message === "string" &&
      /unique constraint failed/i.test(candidate.message))
  );
}

export function jsonResponse(
  value: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

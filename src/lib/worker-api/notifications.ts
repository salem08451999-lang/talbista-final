import { getCloudflareContext } from "@opennextjs/cloudflare";
import { all, now, run, runtimeBindings } from "./common";

export type NotificationOptions = {
  orderId?: number | null;
  urgent?: boolean | number;
  kind?: string;
  soundEvent?: string | null;
  status?: string | null;
};

function channelFor(version: number, event: string, offer: boolean): string {
  if (version >= 4 && event === "accepted") return "talbista_accepted_v4";
  if (version >= 5 && (event === "normal" || event === "urgent")) return event === "normal" ? "talbista_normal_v5" : "talbista_urgent_v5";
  if (version >= 3) return ({ normal: "talbista_normal_v3", urgent: "talbista_urgent_v3", delivered: "talbista_delivered_v3" } as Record<string, string>)[event] ?? "talbista_general_v3";
  if (version >= 2) return "talbista_signature_v2";
  return offer ? (event === "urgent" ? "talbista_urgent" : "talbista_offer") : "talbista_default";
}

export async function notifyUser(userId: number, text: string, options: NotificationOptions = {}): Promise<void> {
  const at = now();
  await run("INSERT INTO notifications(user_id,text,at,read) VALUES(?,?,?,0)", userId, text, at);
  const tokens = await all<{ token: string; channel_v: number }>("SELECT token,channel_v FROM fcm_tokens WHERE user_id=?", userId);
  if (!tokens.length) return;
  const offer = options.kind === "offer";
  const urgent = Boolean(options.urgent);
  const event = options.soundEvent ?? (offer ? (urgent ? "urgent" : "normal") : "general");
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = at + (offer ? 60 : 3600);
  const title = offer ? (urgent ? "⚡ طلب مستعجل قريب منك" : "🚚 طلب جديد قريب منك") : "طلبيستا";
  const data: Record<string, string> = {
    kind: options.kind ?? "info",
    urgent: urgent ? "1" : "0",
    sound_event: event,
    event_id: eventId,
  };
  if (options.orderId) data.order_id = String(options.orderId);
  if (options.status) data.status = options.status;
  for (const token of tokens) {
    const channel = channelFor(Number(token.channel_v || 1), event, offer);
    const rawSound: Record<string, string> = {
      talbista_normal_v3: "talbista_offer",
      talbista_urgent_v3: "talbista_urgent",
      talbista_delivered_v3: "talbista_signature_v2",
      talbista_accepted_v4: "talbista_accepted",
      talbista_normal_v5: "talbista_offer",
      talbista_urgent_v5: "talbista_urgent",
      talbista_offer: "talbista_offer",
      talbista_urgent: "talbista_urgent",
      talbista_signature_v2: "talbista_signature_v2",
    };
    const androidNotification: Record<string, string> = { channel_id: channel, tag: eventId };
    if (rawSound[channel]) androidNotification.sound = rawSound[channel];
    const apnsSound: Record<string, string> = {
      normal: "talbista_offer.wav",
      urgent: "talbista_urgent.wav",
      delivered: "talbista_signature_v2.wav",
      accepted: "talbista_accepted.wav",
    };
    const message: Record<string, unknown> = {
      token: token.token,
      notification: { title, body: text },
      data,
      android: {
        priority: "HIGH",
        ttl: offer ? "60s" : "3600s",
        notification: androidNotification,
      },
    };
    if (apnsSound[event]) {
      message.apns = {
        headers: { "apns-priority": offer ? "10" : "5", "apns-collapse-id": eventId },
        payload: { aps: { alert: { title, body: text }, sound: apnsSound[event] } },
      };
    }
    await run(
      "INSERT INTO fcm_outbox(id,event_id,token,payload,kind,created,expires_at) VALUES(?,?,?,?,?,?,?)",
      crypto.randomUUID().replaceAll("-", ""), eventId, token.token, JSON.stringify({ message }), options.kind ?? "info", at, expiresAt,
    );
  }
  scheduleFcmDelivery();
}

type FcmOutboxRow = { id: string; token: string; payload: string; attempts: number; expires_at: number };
type FcmServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };

let cachedAccessToken: { value: string; expiresAt: number; serviceAccount: string } | null = null;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function serviceAccount(): FcmServiceAccount | null {
  const raw = runtimeBindings().FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FcmServiceAccount>;
    if (typeof parsed.project_id !== "string" || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return null;
    return parsed as FcmServiceAccount;
  } catch {
    return null;
  }
}

async function withTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function googleAccessToken(account: FcmServiceAccount): Promise<string> {
  const current = now();
  if (cachedAccessToken && cachedAccessToken.serviceAccount === account.client_email && cachedAccessToken.expiresAt > current + 60) {
    return cachedAccessToken.value;
  }
  const issuedAt = current;
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  let der: Uint8Array;
  try {
    const binary = atob(pem);
    der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("fcm_credentials_invalid");
  }
  const keyBytes = new Uint8Array(der.length);
  keyBytes.set(der);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assertionBody = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(assertionBody)));
  const assertion = `${assertionBody}.${base64url(signature)}`;
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await withTimeout(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!response.ok) throw new Error("fcm_oauth_failed");
  const result = await response.json() as { access_token?: string; expires_in?: number };
  if (!result.access_token) throw new Error("fcm_oauth_failed");
  cachedAccessToken = {
    value: result.access_token,
    expiresAt: current + Math.max(60, Number(result.expires_in ?? 3600)),
    serviceAccount: account.client_email,
  };
  return result.access_token;
}

function scheduleFcmDelivery(): void {
  try {
    const { ctx } = getCloudflareContext();
    ctx.waitUntil(flushFcmOutbox());
  } catch {
    // Local route tests may not expose an execution context; the durable outbox remains pending.
  }
}

async function deliverOne(row: FcmOutboxRow, accessToken: string, account: FcmServiceAccount): Promise<void> {
  const timestamp = now();
  const lease = await run(
    "UPDATE fcm_outbox SET status='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending' AND next_attempt<=?",
    timestamp + 60,
    row.id,
    timestamp,
  );
  if (!lease.changes) return;
  let message: unknown;
  try {
    message = (JSON.parse(row.payload) as { message: unknown }).message;
  } catch {
    await run("UPDATE fcm_outbox SET status='dead',lease_until=0,last_error='invalid_payload' WHERE id=?", row.id);
    return;
  }
  const projectId = runtimeBindings().FCM_PROJECT_ID?.trim() || account.project_id;
  const response = await withTimeout(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (response.ok) {
    await run("UPDATE fcm_outbox SET status='sent',sent_at=?,lease_until=0,last_error=NULL WHERE id=? AND status='sending'", now(), row.id);
    return;
  }
  let errorCode = "fcm_http_" + response.status;
  try {
    const body = await response.json() as { error?: { details?: Array<{ errorCode?: string }> } };
    errorCode = body.error?.details?.find((detail) => typeof detail.errorCode === "string")?.errorCode || errorCode;
  } catch {
    // Keep only a generic status code; provider response bodies may include sensitive data.
  }
  if (errorCode === "UNREGISTERED" || errorCode === "NOT_FOUND") {
    await run("DELETE FROM fcm_tokens WHERE token=?", row.token);
    await run("UPDATE fcm_outbox SET status='dead',lease_until=0,last_error='unregistered' WHERE id=? AND status='sending'", row.id);
    return;
  }
  const attempts = Number(row.attempts) + 1;
  if (attempts >= 8 || row.expires_at <= now()) {
    await run("UPDATE fcm_outbox SET status='dead',lease_until=0,last_error=? WHERE id=? AND status='sending'", errorCode.slice(0, 80), row.id);
    return;
  }
  const nextAttempt = now() + Math.min(3600, 30 * (2 ** Math.max(0, attempts - 1)));
  await run("UPDATE fcm_outbox SET status='pending',lease_until=0,next_attempt=?,last_error=? WHERE id=? AND status='sending'", nextAttempt, errorCode.slice(0, 80), row.id);
}

export async function flushFcmOutbox(): Promise<void> {
  const account = serviceAccount();
  if (!account) return;
  const timestamp = now();
  await run("UPDATE fcm_outbox SET status='dead',lease_until=0,last_error='expired' WHERE status='pending' AND expires_at>0 AND expires_at<=?", timestamp);
  await run("UPDATE fcm_outbox SET status='pending',lease_until=0,next_attempt=? WHERE status='sending' AND lease_until<=?", timestamp, timestamp);
  const rows = await all<FcmOutboxRow>(
    "SELECT id,token,payload,attempts,expires_at FROM fcm_outbox WHERE status='pending' AND next_attempt<=? AND (expires_at=0 OR expires_at>?) ORDER BY created LIMIT 10",
    timestamp,
    timestamp,
  );
  if (!rows.length) return;
  let accessToken: string;
  try {
    accessToken = await googleAccessToken(account);
  } catch {
    return;
  }
  await Promise.all(rows.map((row) => deliverOne(row, accessToken, account).catch(async () => {
    const attempts = Number(row.attempts) + 1;
    const nextAttempt = now() + Math.min(3600, 30 * (2 ** Math.max(0, attempts - 1)));
    if (attempts >= 8 || row.expires_at <= now()) {
      await run("UPDATE fcm_outbox SET status='dead',lease_until=0,last_error='delivery_exception' WHERE id=? AND status='sending'", row.id);
    } else {
      await run("UPDATE fcm_outbox SET status='pending',lease_until=0,next_attempt=?,last_error='delivery_exception' WHERE id=? AND status='sending'", nextAttempt, row.id);
    }
  })));
}

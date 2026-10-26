import { ApiError, json, preflight, readJson, withCors } from "@/src/lib/worker-api/common";
import { handleAccountApi } from "@/src/lib/worker-api/accounts";
import { handleOrderApi } from "@/src/lib/worker-api/orders";
import { handleDriverApi } from "@/src/lib/worker-api/driver";
import { handleAdminApi } from "@/src/lib/worker-api/admin";
import { handleChatApi } from "@/src/lib/worker-api/chat";
import { withIdempotency } from "@/src/lib/worker-api/idempotency";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return preflight(request);
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return withCors(request, json({ error: "not found" }, 404));
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  try {
    let body: Record<string, unknown> = {};
    if (!["GET", "HEAD"].includes(method)) body = await readJson(request, 1_300_000);
    const ctx = { request, method, path, body };
    const handlers = [handleAccountApi, handleChatApi, handleOrderApi, handleDriverApi, handleAdminApi];
    for (const handler of handlers) {
      const result = await withIdempotency(request, method, path, body, () => handler(ctx));
      if (typeof result !== "symbol") return withCors(request, json(result));
    }
    return withCors(request, json({ error: "not found" }, 404));
  } catch (error) {
    const response = error instanceof ApiError
      ? json({ error: error.message }, error.status)
      : json({ error: "server error" }, 500);
    return withCors(request, response);
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;

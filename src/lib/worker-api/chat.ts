import { ApiError, all, asString, first, now, run } from "./common";
import { apiUser, NO_ROUTE, type ApiContext } from "./accounts";

type ChatOrder = { customer_id: number; driver_id: number | null };
type ChatMessage = {
  id: number;
  sender_id: number;
  sender_role: string;
  message: string;
  created_at: number;
};

async function participantOrder(orderId: number, userId: number, role: string): Promise<ChatOrder> {
  const order = await first<ChatOrder>("SELECT customer_id,driver_id FROM orders WHERE id=?", orderId);
  if (!order) throw new ApiError(404, "not found");
  const isOwner = (role === "CUSTOMER" || role === "STORE") && Number(order.customer_id) === userId;
  const isAssignedDriver = role === "DRIVER" && Number(order.driver_id) === userId;
  if (!isOwner && !isAssignedDriver) throw new ApiError(404, "not found");
  if (order.driver_id == null) throw new ApiError(409, "chat unavailable until a driver is assigned");
  return order;
}

function orderIdFromRequest(ctx: ApiContext, pathOrderId?: string): number {
  const url = new URL(ctx.request.url);
  const rawOrderId = pathOrderId
    ?? (ctx.method === "GET"
      ? url.searchParams.get("order_id") ?? url.searchParams.get("orderId")
      : ctx.body.order_id ?? ctx.body.orderId);
  const orderId = Number(rawOrderId);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new ApiError(400, "invalid order_id");
  return orderId;
}

function messageText(body: Record<string, unknown>): string {
  const rawMessage = body.message;
  const nestedText = rawMessage && typeof rawMessage === "object" && !Array.isArray(rawMessage)
    ? (rawMessage as Record<string, unknown>).text
    : undefined;
  const value = typeof rawMessage === "string"
    ? rawMessage
    : nestedText ?? body.text ?? body.message_text;
  const text = asString(value, "message", 2000).trim();
  if (!text) throw new ApiError(400, "invalid message");
  return text;
}

export async function handleChatApi(ctx: ApiContext): Promise<unknown | typeof NO_ROUTE> {
  const orderMatch = ctx.path.match(/^\/api\/orders\/(\d+)\/chat$/);
  const isMessagesAlias = ctx.path === "/api/messages";
  if (!orderMatch && !isMessagesAlias) return NO_ROUTE;
  if (!["GET", "POST"].includes(ctx.method)) return NO_ROUTE;

  const user = await apiUser(ctx, ["CUSTOMER", "STORE", "DRIVER"]);
  const orderId = orderIdFromRequest(ctx, orderMatch?.[1]);
  await participantOrder(orderId, user.id, user.role);

  if (ctx.method === "GET") {
    const rows = await all<ChatMessage>(
      "SELECT id,sender_id,sender_role,message,created_at FROM order_chat_messages WHERE order_id=? ORDER BY id DESC LIMIT 100",
      orderId,
    );
    return {
      messages: rows.reverse().map((row) => ({ ...row, text: row.message, body: row.message })),
    };
  }

  const message = messageText(ctx.body);
  const createdAt = now();
  const inserted = await run(
    "INSERT INTO order_chat_messages(order_id,sender_id,sender_role,message,created_at) VALUES(?,?,?,?,?)",
    orderId, user.id, user.role, message, createdAt,
  );
  return {
    id: inserted.lastRowId,
    order_id: orderId,
    sender_id: user.id,
    sender_role: user.role,
    message,
    text: message,
    body: message,
    created_at: createdAt,
  };
}

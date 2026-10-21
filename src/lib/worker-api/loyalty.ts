import { ApiError, all, first, now, run, type MobileUser } from "./common";
import { balance, moneyToUnits, postLedger, unitsToMoney } from "./ledger";
import { notifyUser } from "./notifications";

const defaultConfig = { store_orders_required: 100, customer_orders_required: 10, store_free_start: "14:00", store_free_end: "19:00" };

type LoyaltySettings = typeof defaultConfig & { id: number; updated_by: number | null; updated_at: number | null };
type LoyaltyOrder = {
  id: number; customer_id: number; driver_id: number | null; kind: string | null; is_demo: number | null;
  loyalty_reward_id: number | null; agreed_price: number | null; delivery_price: number | null;
};

export async function loyaltyConfig(): Promise<LoyaltySettings> {
  return (await first<LoyaltySettings>("SELECT * FROM loyalty_settings WHERE id=1")) ?? { id: 1, ...defaultConfig, updated_by: null, updated_at: null };
}

async function progress(ownerKind: string, ownerId: number) {
  await run("INSERT OR IGNORE INTO loyalty_progress(owner_kind,owner_id,progress,cycle) VALUES(?,?,0,1)", ownerKind, ownerId);
  return await first<{ owner_kind: string; owner_id: number; progress: number; cycle: number }>("SELECT * FROM loyalty_progress WHERE owner_kind=? AND owner_id=?", ownerKind, ownerId) ?? { owner_kind: ownerKind, owner_id: ownerId, progress: 0, cycle: 1 };
}

function libyaClock(timestamp: number): { year: number; month: number; day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), minute: Number(values.hour) * 60 + Number(values.minute) };
}

function timeMinutes(value: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function epochAtLibyaTime(year: number, month: number, day: number, minuteOfDay: number): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return Math.floor(Date.UTC(year, month - 1, day, hour - 2, minute, 0) / 1000);
}

export function currentLoyaltyWindow(config: LoyaltySettings, timestamp = now()): { start: number; end: number } | null {
  const startMinute = timeMinutes(config.store_free_start);
  const endMinute = timeMinutes(config.store_free_end);
  if (startMinute == null || endMinute == null || endMinute <= startMinute || endMinute - startMinute > 12 * 60) return null;
  const clock = libyaClock(timestamp);
  if (clock.minute < startMinute || clock.minute >= endMinute) return null;
  return { start: epochAtLibyaTime(clock.year, clock.month, clock.day, startMinute), end: epochAtLibyaTime(clock.year, clock.month, clock.day, endMinute) };
}

export async function syncStoreReward(ownerId: number, timestamp = now()): Promise<Record<string, unknown> | null> {
  await run("UPDATE loyalty_rewards SET status=CASE WHEN used_orders>0 THEN 'USED' ELSE 'EXPIRED' END WHERE owner_kind='STORE' AND status='ACTIVE' AND window_end<=?", timestamp);
  const config = await loyaltyConfig();
  const window = currentLoyaltyWindow(config, timestamp);
  if (!window) return null;
  const active = await first<Record<string, unknown>>("SELECT * FROM loyalty_rewards WHERE owner_kind='STORE' AND owner_id=? AND status='ACTIVE' AND window_start=? AND window_end=? ORDER BY id LIMIT 1", ownerId, window.start, window.end);
  if (active) return active;
  const reward = await first<{ id: number }>("SELECT id FROM loyalty_rewards WHERE owner_kind='STORE' AND owner_id=? AND status='AVAILABLE' AND earned_at<=? ORDER BY earned_at,id LIMIT 1", ownerId, window.start);
  if (!reward) return null;
  await run("UPDATE loyalty_rewards SET status='ACTIVE',window_start=?,window_end=? WHERE id=? AND status='AVAILABLE'", window.start, window.end, reward.id);
  return first<Record<string, unknown>>("SELECT * FROM loyalty_rewards WHERE id=?", reward.id);
}

export async function releaseOrderReward(order: LoyaltyOrder): Promise<void> {
  if (!order.loyalty_reward_id) return;
  await run("UPDATE loyalty_rewards SET status='AVAILABLE',reserved_order_id=NULL WHERE id=? AND owner_kind='CUSTOMER' AND status='RESERVED' AND reserved_order_id=?", order.loyalty_reward_id, order.id);
}

export async function completeLoyaltyOrder(order: LoyaltyOrder): Promise<void> {
  if (order.is_demo) return;
  const timestamp = now();
  const ownerKind = order.kind === "STORE" ? "STORE" : "CUSTOMER";
  const ownerId = Number(order.customer_id);
  const reward = order.loyalty_reward_id ? await first<Record<string, unknown>>("SELECT * FROM loyalty_rewards WHERE id=?", order.loyalty_reward_id) : null;
  const customerRewardUse = ownerKind === "CUSTOMER" && reward?.owner_kind === "CUSTOMER" && reward?.reward_type === "CUSTOMER_FREE_DELIVERY" && reward?.status === "RESERVED" && Number(reward?.reserved_order_id) === order.id;
  const existingReward = ownerKind === "CUSTOMER" ? await first("SELECT 1 AS found FROM loyalty_rewards WHERE owner_kind='CUSTOMER' AND owner_id=? AND reward_type='CUSTOMER_FREE_DELIVERY' AND status IN ('AVAILABLE','RESERVED') LIMIT 1", ownerId) : null;
  const counted = ownerKind === "STORE" || (!customerRewardUse && !existingReward) ? 1 : 0;
  const event = await run("INSERT OR IGNORE INTO loyalty_events(order_id,owner_kind,owner_id,completed_at,counted) VALUES(?,?,?,?,?)", order.id, ownerKind, ownerId, timestamp, counted);
  if (!event.changes) return;
  const current = await progress(ownerKind, ownerId);
  const config = await loyaltyConfig();

  if (customerRewardUse && reward) {
    await run("UPDATE loyalty_rewards SET status='REDEEMED',redeemed_at=? WHERE id=? AND status='RESERVED' AND reserved_order_id=?", timestamp, order.loyalty_reward_id, order.id);
    const remaining = await first("SELECT 1 AS found FROM loyalty_rewards WHERE owner_kind='CUSTOMER' AND owner_id=? AND reward_type='CUSTOMER_FREE_DELIVERY' AND status IN ('AVAILABLE','RESERVED') LIMIT 1", ownerId);
    if (!remaining) await run("UPDATE loyalty_progress SET progress=0,cycle=cycle+1 WHERE owner_kind='CUSTOMER' AND owner_id=?", ownerId);
    await notifyUser(ownerId, `تم استخدام مكافأة التوصيل المجاني في الطلب #${order.id}. بدأ عدادك الجديد.`, { orderId: order.id, kind: "loyalty" });
  } else if (counted) {
    const required = ownerKind === "STORE" ? Number(config.store_orders_required) : Number(config.customer_orders_required);
    const nextProgress = Number(current.progress) + 1;
    if (nextProgress >= required) {
      const rewardType = ownerKind === "STORE" ? "STORE_FREE_WINDOW" : "CUSTOMER_FREE_DELIVERY";
      await run("INSERT OR IGNORE INTO loyalty_rewards(owner_kind,owner_id,reward_type,cycle,status,earned_at) VALUES(?,?,?,?,'AVAILABLE',?)", ownerKind, ownerId, rewardType, current.cycle, timestamp);
      if (ownerKind === "STORE") await run("UPDATE loyalty_progress SET progress=0,cycle=cycle+1 WHERE owner_kind=? AND owner_id=?", ownerKind, ownerId);
      else await run("UPDATE loyalty_progress SET progress=? WHERE owner_kind=? AND owner_id=?", required, ownerKind, ownerId);
      await notifyUser(ownerId, ownerKind === "STORE" ? "مبروك! حصل متجرك على نافذة توصيل مجاني لمدة الفترة المحددة، تبدأ تلقائيًا في الموعد اليومي القادم." : `مبروك! أكملت ${required} طلبات مستلمة وحصلت على توصيل مجاني لطلب واحد.`, { orderId: order.id, kind: "loyalty" });
    } else {
      await run("UPDATE loyalty_progress SET progress=? WHERE owner_kind=? AND owner_id=?", nextProgress, ownerKind, ownerId);
      if (nextProgress === required - 2 || nextProgress === required - 1) await notifyUser(ownerId, `أكملت ${nextProgress} من ${required} طلبات مستلمة. بقي ${required - nextProgress} للحصول على مكافأة التوصيل.`, { orderId: order.id, kind: "loyalty" });
    }
  }

  if (ownerKind === "STORE" && reward?.reward_type === "STORE_FREE_WINDOW") {
    await run("UPDATE loyalty_rewards SET used_orders=used_orders+1,status=CASE WHEN status='EXPIRED' THEN 'USED' ELSE status END WHERE id=?", order.loyalty_reward_id);
  }
  if (order.loyalty_reward_id && order.driver_id) {
    const exists = await first("SELECT 1 AS found FROM loyalty_driver_credits WHERE order_id=?", order.id);
    const rawPrice = order.agreed_price ?? order.delivery_price;
    const amount = rawPrice == null ? 0 : moneyToUnits(Number(rawPrice));
    if (!exists && amount > 0) {
      const custody = Math.max(0, await balance(order.driver_id, "CUSTODY"));
      const offset = Math.min(amount, custody);
      const entitlement = amount - offset;
      const entries: Array<[string, number]> = [["LOSS", amount]];
      if (offset) entries.push(["CUSTODY", -offset]);
      if (entitlement) entries.push(["ENTITLEMENT", entitlement]);
      const posted = await postLedger({ kind: "COMPENSATION", entries, driverId: order.driver_id, reason: "أجرة توصيل ممولة بمكافأة ولاء؛ العمولة مستقلة", source: "LOYALTY_REWARD", orderId: order.id, requestId: `loyalty-driver-credit:${order.id}`, meta: { reward_id: order.loyalty_reward_id, agreed_price: unitsToMoney(amount), custody_offset: unitsToMoney(offset), driver_entitlement: unitsToMoney(entitlement) } });
      await run("INSERT OR IGNORE INTO loyalty_driver_credits(order_id,driver_id,amount,txn_id,created_at) VALUES(?,?,?,?,?)", order.id, order.driver_id, amount, posted.txnId, timestamp);
      await notifyUser(order.driver_id, `تم تسجيل رصيد مكافأة توصيل الطلب #${order.id}: ${unitsToMoney(amount)} د.ل. عمولة الشركة تبقى منفصلة.`, { orderId: order.id, kind: "finance" });
    }
  }
}

export async function loyaltyUserStatus(user: MobileUser): Promise<Record<string, unknown>> {
  if (user.role !== "CUSTOMER" && user.role !== "STORE") throw new ApiError(403, "forbidden");
  const kind = user.role;
  const config = await loyaltyConfig();
  const current = await progress(kind, user.id);
  const active = kind === "STORE" ? await syncStoreReward(user.id) : null;
  const required = kind === "STORE" ? config.store_orders_required : config.customer_orders_required;
  const rewards = await all<{ id: number; reward_type: string; status: string; earned_at: number; reserved_order_id: number | null; window_start: number | null; window_end: number | null; used_orders: number }>("SELECT id,reward_type,status,earned_at,reserved_order_id,window_start,window_end,used_orders FROM loyalty_rewards WHERE owner_kind=? AND owner_id=? ORDER BY id DESC LIMIT 20", kind, user.id);
  const available = rewards.filter((item) => kind === "STORE" ? ["AVAILABLE", "ACTIVE"].includes(item.status) : ["AVAILABLE", "RESERVED"].includes(item.status)).length;
  return {
    owner_kind: kind,
    completed: current.progress,
    required,
    remaining: Math.max(0, Number(required) - Number(current.progress)),
    available_rewards: available,
    rewards,
    free_window: kind === "STORE" ? { active: Boolean(active), start: config.store_free_start, end: config.store_free_end, start_at: active?.window_start ?? null, end_at: active?.window_end ?? null } : null,
  };
}

export async function adminLoyaltyView(): Promise<Record<string, unknown>> {
  const config = await loyaltyConfig();
  const earned = await first<{ n: number }>("SELECT COUNT(*) n FROM loyalty_rewards");
  const available = await first<{ n: number }>("SELECT COUNT(*) n FROM loyalty_rewards WHERE status IN ('AVAILABLE','ACTIVE','RESERVED')");
  const used = await first<{ n: number }>("SELECT COUNT(*) n FROM loyalty_rewards WHERE status IN ('REDEEMED','USED')");
  const credits = await first<{ n: number; amount: number }>("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount FROM loyalty_driver_credits");
  const people: Record<string, unknown[]> = {};
  for (const [kind, role] of [["STORE", "STORE"], ["CUSTOMER", "CUSTOMER"]] as const) {
    const users = await all<{ id: number; name: string | null; phone: string }>('SELECT id,name,phone FROM "User" WHERE role=? ORDER BY name', role);
    const rows: Record<string, unknown>[] = [];
    for (const user of users) {
      const p = await first<{ progress: number; cycle: number }>("SELECT progress,cycle FROM loyalty_progress WHERE owner_kind=? AND owner_id=?", kind, user.id) ?? { progress: 0, cycle: 1 };
      if (kind === "STORE") await syncStoreReward(user.id);
      const statuses = await all<{ status: string; n: number }>("SELECT status,COUNT(*) n FROM loyalty_rewards WHERE owner_kind=? AND owner_id=? GROUP BY status", kind, user.id);
      const counts = Object.fromEntries(statuses.map((row) => [row.status, row.n]));
      rows.push({ ...user, progress: p.progress, cycle: p.cycle, required: kind === "STORE" ? config.store_orders_required : config.customer_orders_required, available: Number(counts.AVAILABLE ?? 0) + Number(counts.ACTIVE ?? 0) + Number(counts.RESERVED ?? 0), used: Number(counts.USED ?? 0) + Number(counts.REDEEMED ?? 0), expired: Number(counts.EXPIRED ?? 0) });
    }
    people[kind === "STORE" ? "stores" : "customers"] = rows;
  }
  const driverCredits = await all<Record<string, unknown>>("SELECT c.order_id,c.driver_id,u.name driver_name,c.amount,c.created_at FROM loyalty_driver_credits c JOIN \"User\" u ON u.id=c.driver_id ORDER BY c.created_at DESC LIMIT 200");
  return { settings: config, stats: { earned: earned?.n ?? 0, available: available?.n ?? 0, used: used?.n ?? 0, free_deliveries: credits?.n ?? 0, waived_total: unitsToMoney(Number(credits?.amount ?? 0)) }, ...people, credits: driverCredits.map((row) => ({ ...row, amount: unitsToMoney(Number(row.amount)) })) };
}

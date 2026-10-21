import { batch, d1, first, now, run, statement } from "./common";
import { notifyUser } from "./notifications";

const side: Record<string, number> = {
  CUSTODY: 1, CASH_RECEIVED: 1, CLEARING: 1, INVENTORY: 1, LOSS: 1, OPENING_OFFSET: 1,
  INCOME_COMMISSION: -1, INCOME_FINES: -1, ADVANCE: -1, ENTITLEMENT: -1, OPENING: -1, ADJUSTMENTS: -1,
};
const ledgerKinds = new Set(["OPENING", "COMMISSION", "FINE", "FINE_REVERSAL", "SETTLEMENT", "CORRECTION", "ADJUSTMENT", "NETTING", "PURCHASE_ADVANCE", "ADVANCE_RECOVERY", "COMPENSATION", "REFUND", "SALVAGE", "LOSS_WRITE_OFF"]);
export const moneyUnits = 1000;
export const moneyToUnits = (value: number): number => Math.round(value * moneyUnits);
export const unitsToMoney = (value: number): number => Math.round(value) / moneyUnits;
export const formatMoney = (value: number): string => String(unitsToMoney(value));

export async function balance(driverId: number, account: string): Promise<number> {
  const row = await first<{ amount: number }>("SELECT COALESCE(SUM(amount),0) AS amount FROM ledger_entries WHERE driver_id=? AND account=?", driverId, account);
  return Number(row?.amount ?? 0);
}

export async function postLedger(input: {
  kind: string;
  entries: Array<[string, number]>;
  driverId: number | null;
  reason?: string;
  source?: string;
  actorId?: number | null;
  approverId?: number | null;
  orderId?: number | null;
  requestId?: string | null;
  correctsTxnId?: number | null;
  meta?: unknown;
}): Promise<{ txnId: number; created: boolean }> {
  const entries = input.entries.filter(([, amount]) => Number.isInteger(amount) && amount !== 0);
  if (!ledgerKinds.has(input.kind) || !entries.length || entries.some(([account]) => !side[account]) || entries.reduce((sum, [account, amount]) => sum + side[account] * amount, 0) !== 0) {
    throw new Error("invalid balanced ledger transaction");
  }
  const requestId = input.requestId || `auto:${crypto.randomUUID()}`;
  const existing = await first<{ id: number }>("SELECT id FROM ledger_txns WHERE request_id=?", requestId);
  if (existing) return { txnId: Number(existing.id), created: false };

  const oldCustody = input.driverId ? await balance(input.driverId, "CUSTODY") : 0;
  const timestamp = now();
  const statements = [statement(
    "INSERT INTO ledger_txns(at,kind,order_id,driver_id,reason,source,actor_id,approver_id,request_id,corrects_txn_id,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    timestamp, input.kind, input.orderId ?? null, input.driverId, input.reason ?? "", input.source ?? "SYSTEM_RULE",
    input.actorId ?? null, input.approverId ?? null, requestId, input.correctsTxnId ?? null,
    input.meta == null ? null : JSON.stringify(input.meta),
  )];
  for (let index = 0; index < entries.length; index += 1) {
    const [account, amount] = entries[index];
    statements.push(statement(
      "INSERT INTO ledger_entries(txn_id,seq,account,driver_id,order_id,amount,at) SELECT id,?,?,?,?,?,? FROM ledger_txns WHERE request_id=?",
      index, account, input.driverId, input.orderId ?? null, amount, timestamp, requestId,
    ));
  }
  if (input.driverId != null) {
    statements.push(statement("UPDATE drivers SET outstanding=(SELECT COALESCE(SUM(amount),0)/1000.0 FROM ledger_entries WHERE driver_id=? AND account='CUSTODY') WHERE user_id=?", input.driverId, input.driverId));
    statements.push(statement("INSERT OR IGNORE INTO driver_accounts(driver_id) VALUES(?)", input.driverId));
    const custodyDelta = entries.reduce((sum, [account, amount]) => sum + (account === "CUSTODY" ? amount : 0), 0);
    const warn = Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_warn'"))?.v ?? 50) * moneyUnits;
    const newCustody = oldCustody + custodyDelta;
    if (newCustody >= warn && oldCustody < warn) {
      statements.push(statement("UPDATE driver_accounts SET alert_since=COALESCE(alert_since,?),notified=CASE WHEN COALESCE(alert_since,0)=0 THEN 'start' ELSE notified END WHERE driver_id=?", timestamp, input.driverId));
    } else if (newCustody < warn) {
      statements.push(statement("UPDATE driver_accounts SET alert_since=NULL,notified='' WHERE driver_id=?", input.driverId));
    }
  }
  try {
    await batch(statements);
  } catch (error) {
    const raced = await first<{ id: number }>("SELECT id FROM ledger_txns WHERE request_id=?", requestId);
    if (raced) return { txnId: Number(raced.id), created: false };
    throw error;
  }
  const inserted = await first<{ id: number }>("SELECT id FROM ledger_txns WHERE request_id=?", requestId);
  if (!inserted) throw new Error("ledger commit receipt missing");
  if (input.driverId != null && oldCustody < Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_warn'"))?.v ?? 50) * moneyUnits && (await balance(input.driverId, "CUSTODY")) >= Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='custody_warn'"))?.v ?? 50) * moneyUnits) {
    const days = Number((await first<{ v: number }>("SELECT v FROM settings WHERE k='settle_days'"))?.v ?? 7);
    await notifyUser(input.driverId, `تنبيه: بلغت عهدتك ${formatMoney(await balance(input.driverId, "CUSTODY"))} د.ل. يرجى تسويتها خلال ${days} أيام.` , { kind: "finance" });
  }
  return { txnId: Number(inserted.id), created: true };
}

export async function driverOutstanding(driverId: number): Promise<number> {
  return unitsToMoney(await balance(driverId, "CUSTODY"));
}

export async function settleCustody(driverId: number, amount: number, actorId: number, reason: string, requestId: string, meta?: unknown) {
  const units = Math.round(amount);
  const current = await balance(driverId, "CUSTODY");
  if (units <= 0 || units > current) throw new Error("invalid amount");
  return postLedger({ kind: "SETTLEMENT", entries: [["CUSTODY", -units], ["CASH_RECEIVED", units]], driverId, reason, source: "ADMIN_ACTION", actorId, requestId, meta });
}

export async function ledgerRows(driverId?: number, limit = 1000): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  let where = "";
  if (driverId != null) { where = " AND e.driver_id=?"; params.push(driverId); }
  params.push(limit);
  const rows = await d1().prepare(`SELECT * FROM (
    SELECT t.id,t.at,t.driver_id,t.order_id,t.kind AS txn_kind,t.reason AS note,t.actor_id,o.urgent,e.amount,
      SUM(e.amount) OVER (PARTITION BY e.driver_id ORDER BY e.id) AS balance_after
    FROM ledger_entries e JOIN ledger_txns t ON t.id=e.txn_id LEFT JOIN orders o ON o.id=t.order_id
    WHERE e.account='CUSTODY'${where}
  ) v ORDER BY id DESC LIMIT ?`).bind(...(params as (string | number | null)[])).all<Record<string, unknown>>();
  const aliases: Record<string, string> = { COMMISSION: "COMMISSION", SETTLEMENT: "HANDOVER", FINE: "FINE", FINE_REVERSAL: "FINE_REVERSAL", OPENING: "OPENING", CORRECTION: "CORRECTION", ADJUSTMENT: "CORRECTION" };
  return (rows.results ?? []).map((row) => ({
    id: Number(row.id), at: Number(row.at), driver_id: Number(row.driver_id), order_id: row.order_id == null ? null : Number(row.order_id),
    kind: aliases[String(row.txn_kind)] ?? row.txn_kind, urgent: row.urgent ?? null, amount: unitsToMoney(Number(row.amount)),
    balance_after: unitsToMoney(Number(row.balance_after)), admin_id: ["SETTLEMENT", "FINE", "FINE_REVERSAL", "CORRECTION", "ADJUSTMENT"].includes(String(row.txn_kind)) ? row.actor_id : null, note: row.note,
  }));
}

export async function audit(actorId: number, action: string, detail: unknown = ""): Promise<void> {
  await run("INSERT INTO audit_logs(at,actor,action,detail) VALUES(?,?,?,?)", now(), actorId, action, JSON.stringify(detail));
}

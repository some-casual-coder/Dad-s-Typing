import { randomUUID } from "node:crypto";
import type { Payments } from "@/adapters/types";
import { openRecipient, sealRecipient } from "@/channel/bridge";
import { formatRange, type Eta } from "@/delivery/eta";
import { freight } from "@/delivery/estimate";
import { FX_BUFFER_PCT, type FxTable } from "@/delivery/fx";
import { AQUANTUO_CM3_PER_KG, chargeableKg, estimateParcel, KENTEX_CM3_PER_KG, type ParcelEstimate } from "@/delivery/packaging";
import type { Component, Plan } from "@/delivery/types";
import { authorize, can } from "./access";
import { recordActual, recordEstimate } from "./calibration";
import { tx, type Tx } from "./db";
import { DomainError } from "./errors";
import { logEvent } from "./events";
import { operatorRefund } from "./operator";

// Option B, sandbox only: one payment for the delivered total, charged at the
// cap (top of our range); the operator buys through the provider; we refund
// the difference once the warehouse weighs it. Above the cap is the only re-ask.
export const SETTLEMENT_RULE = "Charged up to the cap. After the provider's final bill we refund any difference; a cost above the cap needs your yes first.";
export const CONCIERGE_SELLER = "Dad's Typing concierge (sandbox)";

export type Status = "paid" | "ordered" | "at_warehouse" | "departed" | "cleared" | "ready_to_collect" | "out_for_delivery" | "delivered"
  | "cancelled" | "stock_out" | "needs_approval" | "settled";
const PROGRESS: Status[] = ["paid", "ordered", "at_warehouse", "departed", "cleared", "ready_to_collect", "out_for_delivery", "delivered"];
export const STATUS_TEXT: Record<Status, string> = {
  paid: "Paid", ordered: "Ordered from the store", at_warehouse: "Arrived at the US warehouse", departed: "On the plane to Kenya",
  cleared: "Cleared customs", ready_to_collect: "Ready to collect", out_for_delivery: "Out for delivery", delivered: "Delivered",
  cancelled: "Cancelled and refunded", stock_out: "The store ran out, so you have been refunded in full", needs_approval: "The final cost is above the cap and needs your yes",
  settled: "Final cost settled",
};
const isStatus = (s: unknown): s is Status => typeof s === "string" && s in STATUS_TEXT;

// Plan parts in USD minor units; KES parts convert at the frozen rate, the
// high end at a buffered rate. Null when any part cannot be charged.
export function usdRange(cs: Component[], fx: FxTable): { low: number; high: number } | null {
  let low = 0, high = 0;
  for (const c of cs) {
    if (c.status === "unknown") return null;
    if (c.status !== "known" && c.status !== "estimated") continue;
    const lo = c.minor ?? 0, hi = c.highMinor ?? lo;
    if (c.currency === "USD") { low += lo; high += hi; continue; }
    if (c.currency !== "KES" || !fx.USD) return null;
    const micro = fx.USD.kesPerUnitMicro, buf = 1 + (FX_BUFFER_PCT.USD ?? 5) / 100;
    low += Math.floor((lo * 1e6) / micro);
    high += Math.ceil((hi * 1e6 * buf) / micro);
  }
  return { low, high };
}

export interface Frozen { plan: Plan; fx: FxTable; snap: { offerId: string; title: string; sourceOfferId?: string } }

// Called inside createSellerOrder's transaction with a freshly computed plan
export async function freezeConcierge(c: Tx, taskId: string, selectionId: string, grantId: string, f: Frozen) {
  const p = f.plan;
  if (p.provider !== "kentex" && p.provider !== "aquantuo") throw new DomainError("not_payable", "This option is bought at the store");
  if (!p.complete || p.availability !== "available") throw new DomainError("not_payable", "The delivered cost is not confirmed yet, so one payment is not possible");
  const usd = usdRange(p.components, f.fx);
  if (!usd || usd.high <= 0) throw new DomainError("not_payable", "This option cannot be paid in one step yet");
  const merchant = process.env.PAYPAL_MERCHANT_ID;
  if (!merchant) throw new DomainError("not_payable", "Payments are not configured");
  const item = p.components.find((x) => x.key === "item" && x.currency === "USD")?.minor ?? 0;
  const id = randomUUID();
  const row = (await c.query(
    `INSERT INTO seller_orders (id,task_id,selection_id,created_by,merchant_id,seller,sku,title,quantity,currency,item_minor,shipping_minor,total_minor,kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'USD',$9,$10,$11,'concierge') RETURNING *`,
    [id, taskId, selectionId, grantId, merchant, CONCIERGE_SELLER, `${p.provider}:${p.mode}`.slice(0, 60), f.snap.title.slice(0, 300), item, usd.high - item, usd.high],
  )).rows[0];
  await c.query(
    `INSERT INTO concierge_orders (seller_order_id,task_id,offer_id,plan_id,provider,mode,currency,estimate_minor,cap_minor,breakdown,fx,eta,parcel,settlement_rule)
     VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12,$13)`,
    [id, taskId, f.snap.offerId, p.id.slice(0, 200), p.provider, String(p.mode), Math.max(1, usd.low), usd.high, JSON.stringify(p.components), JSON.stringify(f.fx),
      p.eta ? JSON.stringify(p.eta) : null, p.parcel ? JSON.stringify(p.parcel) : null, SETTLEMENT_RULE],
  );
  if (p.parcel) await recordEstimate(c, taskId, f.snap.offerId, p.provider, p.parcel);
  await logEvent(c, taskId, grantId, "order.frozen", { orderId: id, totalMinor: usd.high, kind: "concierge" });
  return row;
}

async function addEvent(c: Tx, orderId: string, taskId: string, status: Status, source: "provider" | "operator" | "system" | "estimate", key: string, note?: string, eta?: Eta | null) {
  const r = await c.query(
    `INSERT INTO fulfilment_events (id,seller_order_id,task_id,status,source,note,eta,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [randomUUID(), orderId, taskId, status, source, note?.slice(0, 200) ?? null, eta ? JSON.stringify(eta) : null, key.slice(0, 120)],
  );
  if (!r.rowCount) return false;
  const dates = eta ? ` Arrives ${formatRange(eta.earliest, eta.latest)}.` : "";
  await notify(c, taskId, `${STATUS_TEXT[status]}.${dates}`, `ful:${r.rows[0].id}`);
  return true;
}

export async function onConciergePaid(c: Tx, order: { id: string; task_id: string }) {
  const co = (await c.query(`SELECT eta FROM concierge_orders WHERE seller_order_id=$1`, [order.id])).rows[0];
  if (co) await addEvent(c, order.id, order.task_id, "paid", "system", `paid:${order.id}`, "Payment confirmed by PayPal (sandbox).", co.eta);
}

// Remember how to reach a chat sender for status pushes, sealed at rest
export async function subscribe(c: Tx, taskId: string, channel: string, senderHash: string, recipient: string) {
  await c.query(`INSERT INTO channel_subscriptions (task_id,channel,sender_hash,recipient_enc) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [taskId, channel, senderHash, sealRecipient(channel, recipient)]);
}

async function notify(c: Tx, taskId: string, text: string, key: string) {
  const subs = (await c.query(`SELECT channel, recipient_enc FROM channel_subscriptions WHERE task_id=$1`, [taskId])).rows;
  for (const s of subs) {
    const to = openRecipient(s.channel, s.recipient_enc);
    if (!to) continue;
    await c.query(`INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [randomUUID(), s.channel, to, text, `${key}:${s.channel}`]);
  }
}

const loadOrder = async (c: Tx, orderId: string) => (await c.query(
  `SELECT o.id, o.task_id, o.status, o.total_minor, o.currency, co.*, a.capture_id FROM seller_orders o
     JOIN concierge_orders co ON co.seller_order_id=o.id
     LEFT JOIN payment_attempts a ON a.seller_order_id=o.id AND a.status='captured'
    WHERE o.id=$1 FOR UPDATE OF o`, [orderId])).rows[0];

const lastProgress = async (c: Tx, orderId: string): Promise<Status | null> => {
  const r = (await c.query(`SELECT status FROM fulfilment_events WHERE seller_order_id=$1 ORDER BY occurred_at`, [orderId])).rows.map((x) => x.status as Status);
  return [...r].reverse().find((s) => PROGRESS.includes(s)) ?? null;
};

export interface FulfilmentInput {
  orderId: string; status: string; source: "provider" | "operator"; key: string; note?: string;
  // Actuals from the provider's bill: a total in USD minor units, or a weighed parcel
  actual?: { totalMinor?: number; grams?: number; lengthMm?: number; widthMm?: number; heightMm?: number; hub?: "texas" | "delaware"; source: string };
}

// Operator or provider facts move the order forward; refunds run after commit
export async function recordFulfilment(payments: Payments, input: FulfilmentInput) {
  if (!isStatus(input.status) || input.status === "paid" || input.status === "settled" || input.status === "needs_approval")
    throw new DomainError("invalid", "status is invalid");
  const status = input.status;
  const refund = await tx(async (c) => {
    const o = await loadOrder(c, input.orderId);
    if (!o) throw new DomainError("not_found", "Order not found");
    if (o.status !== "paid") throw new DomainError("conflict", "The order is not paid");
    const last = await lastProgress(c, o.id);
    if (last === "delivered" || (await c.query(`SELECT 1 FROM fulfilment_events WHERE seller_order_id=$1 AND status IN ('cancelled','stock_out')`, [o.id])).rowCount)
      throw new DomainError("conflict", "This order is closed");
    if (PROGRESS.includes(status) && last && PROGRESS.indexOf(status) <= PROGRESS.indexOf(last))
      return null;
    if (status === "ordered") await c.query(`UPDATE concierge_orders SET provider_paid_at=COALESCE(provider_paid_at, now()) WHERE seller_order_id=$1`, [o.id]);
    if (status === "stock_out" && o.provider_paid_at) throw new DomainError("conflict", "Already paid to the provider; handle as a return");
    if (status === "cancelled") throw new DomainError("invalid", "The payer cancels; the operator records stock-outs");
    await addEvent(c, o.id, o.task_id, status, input.source, `op:${input.key}`, input.note);
    if (status === "stock_out") return { captureId: o.capture_id as string, amount: "full" as const, key: `stockout:${o.id}` };
    if (!input.actual) return null;
    const actual = actualTotal(o, input.actual);
    const w = input.actual;
    if (w.grams && w.lengthMm && w.widthMm && w.heightMm) {
      const div = o.provider === "kentex" ? KENTEX_CM3_PER_KG : AQUANTUO_CM3_PER_KG;
      const kg = chargeableKg({ grams: w.grams, lengthMm: w.lengthMm, widthMm: w.widthMm, heightMm: w.heightMm }, div);
      await recordActual(c, o.task_id, o.offer_id, o.provider, { grams: w.grams, chargeableGrams: Math.round(kg * 1000), source: w.source });
    }
    await c.query(`UPDATE concierge_orders SET actual_minor=$2, actual_source=$3 WHERE seller_order_id=$1`, [o.id, actual, input.actual.source.slice(0, 120)]);
    await logEvent(c, o.task_id, null, "order.actual", { orderId: o.id, actualMinor: actual });
    if (actual > o.cap_minor) {
      await c.query(`UPDATE concierge_orders SET extra_due_minor=$2 WHERE seller_order_id=$1`, [o.id, actual - o.cap_minor]);
      await addEvent(c, o.id, o.task_id, "needs_approval", "system", `extra:${o.id}`, `USD ${((actual - o.cap_minor) / 100).toFixed(2)} above the cap.`);
      return null;
    }
    await c.query(`UPDATE concierge_orders SET settled_at=now() WHERE seller_order_id=$1`, [o.id]);
    await addEvent(c, o.id, o.task_id, "settled", "system", `settle:${o.id}`,
      actual < o.cap_minor ? `Refunding USD ${((o.cap_minor - actual) / 100).toFixed(2)}, the difference from the cap.` : "No difference to refund.");
    return actual < o.cap_minor ? { captureId: o.capture_id as string, amount: o.cap_minor - actual, key: `settle:${o.id}` } : null;
  });
  if (refund?.captureId) {
    await operatorRefund(payments, { operator: "settlement", captureId: refund.captureId, amountMinor: refund.amount, operationKey: refund.key,
      reason: status === "stock_out" ? "Store out of stock" : "Refund of the difference from the cap" });
  }
  return { ok: true };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actualTotal(o: Record<string, any>, a: NonNullable<FulfilmentInput["actual"]>): number {
  if (a.totalMinor !== undefined) {
    if (!Number.isSafeInteger(a.totalMinor) || a.totalMinor <= 0 || a.totalMinor > 10_000_000) throw new DomainError("invalid", "actual total is invalid");
    return a.totalMinor;
  }
  const ok = (v: unknown, max: number) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= max;
  if (!ok(a.grams, 200_000) || !ok(a.lengthMm, 5000) || !ok(a.widthMm, 5000) || !ok(a.heightMm, 5000)) throw new DomainError("invalid", "weighed parcel is invalid");
  const measured: ParcelEstimate = estimateParcel({ title: "" }, { grams: a.grams!, lengthMm: a.lengthMm!, widthMm: a.widthMm!, heightMm: a.heightMm! });
  const lane = o.mode === "buy_for_me" && o.provider === "aquantuo" && String(o.plan_id).includes("GBP") ? "uk" : "us";
  const fresh = freight(o.provider, measured, lane, a.hub ?? (o.mode === "amazon_buy_ship" ? "texas" : "unknown"));
  const parts = (o.breakdown as Component[]).map((x) => (x.key === "freight" ? { ...fresh, minor: fresh.highMinor ?? fresh.minor } : x));
  const usd = usdRange(parts, o.fx as FxTable);
  if (!usd) throw new DomainError("conflict", "Cannot settle this order automatically");
  return usd.high;
}

// Before the provider is paid the payer can cancel for a full refund
export async function cancelOrder(payments: Payments, taskId: string, token: string) {
  const r = await tx(async (c) => {
    const g = await authorize(c, taskId, token, "pay");
    const o = (await c.query(`SELECT o.id FROM seller_orders o WHERE o.task_id=$1 AND o.kind='concierge' AND o.status='paid'`, [taskId])).rows[0];
    if (!o) throw new DomainError("not_found", "No paid order to cancel");
    const full = await loadOrder(c, o.id);
    if (full.provider_paid_at) throw new DomainError("conflict", "The provider has been paid; this is now a return");
    const closed = (await c.query(`SELECT 1 FROM fulfilment_events WHERE seller_order_id=$1 AND status IN ('cancelled','stock_out')`, [o.id])).rowCount;
    if (closed) return null;
    await addEvent(c, o.id, taskId, "cancelled", "system", `cancel:${o.id}`, "Cancelled before the provider was paid.");
    await logEvent(c, taskId, g.id, "order.cancelled", { orderId: o.id });
    return { captureId: full.capture_id as string, key: `cancel:${o.id}` };
  });
  if (r?.captureId) await operatorRefund(payments, { operator: "payer-cancel", captureId: r.captureId, amountMinor: "full", operationKey: r.key, reason: "Cancelled by payer" });
  return { ok: true };
}

export async function decideExtra(taskId: string, token: string, decision: "approved" | "declined") {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "pay");
    const r = await c.query(`UPDATE concierge_orders SET extra_decision=$2 WHERE task_id=$1 AND extra_due_minor IS NOT NULL AND extra_decision IS NULL RETURNING seller_order_id`,
      [taskId, decision]);
    if (!r.rowCount) throw new DomainError("not_found", "Nothing to approve");
    await logEvent(c, taskId, g.id, `order.extra_${decision}`, {});
    return { ok: true };
  });
}

// Plain lines for everyone; money detail only for the payer
export async function timeline(c: Tx, taskId: string, roles: string[]) {
  const o = (await c.query(`SELECT co.*, o.id AS order_id FROM concierge_orders co JOIN seller_orders o ON o.id=co.seller_order_id
     WHERE co.task_id=$1 AND o.status='paid' ORDER BY co.created_at DESC LIMIT 1`, [taskId])).rows[0];
  if (!o) return null;
  const evs = (await c.query(`SELECT status, source, note, eta, occurred_at FROM fulfilment_events WHERE seller_order_id=$1 ORDER BY occurred_at`, [o.order_id])).rows;
  const payer = can(roles as never, "pay");
  const eta = [...evs].reverse().find((e) => e.eta)?.eta as Eta | undefined ?? o.eta as Eta | null;
  const reached = new Set(evs.map((e) => e.status));
  const closed = reached.has("cancelled") || reached.has("stock_out");
  const next = closed || reached.has("delivered") ? [] : PROGRESS.filter((s) => !reached.has(s))
    .filter((s) => (o.breakdown as Component[]).some((x) => x.key === "kenya_delivery" && x.label.startsWith("Pickup")) ? s !== "out_for_delivery" : s !== "ready_to_collect");
  return {
    arrival: eta && !closed ? formatRange(eta.earliest, eta.latest) : null,
    done: evs.filter((e) => payer || e.status !== "settled").map((e) => ({
      status: e.status as Status, text: STATUS_TEXT[e.status as Status], at: new Date(e.occurred_at).toISOString(),
      source: e.source === "provider" ? "Confirmed by the provider" : e.source === "operator" ? "Confirmed by our operator" : e.source === "system" ? "Recorded by Dad's Typing" : "Estimate",
      ...(payer && e.note ? { note: e.note as string } : {}),
    })),
    next: next.map((s) => STATUS_TEXT[s]),
    canCancel: payer && !o.provider_paid_at && !closed,
    ...(payer ? { money: { capMinor: o.cap_minor, estimateMinor: o.estimate_minor, actualMinor: o.actual_minor, extraDueMinor: o.extra_due_minor,
      extraDecision: o.extra_decision, currency: o.currency, rule: o.settlement_rule, concierge: "Sandbox demonstration: an operator places the order with the provider." } } : {}),
  };
}

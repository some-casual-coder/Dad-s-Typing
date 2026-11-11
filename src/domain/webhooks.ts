import type { Payments } from "@/adapters/types";
import { tx } from "./db";
import { DomainError } from "./errors";
import { settleCapture } from "./payments";
import { refundsForAttempt, settleRefund } from "./refunds";
import { randomUUID } from "node:crypto";

export const HANDLED = [
  "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED",
] as const;

export interface WebhookFacts { eventId: string; eventType: string; resourceId: string | null; orderId: string | null }
export type WebhookState = "processed" | "ignored";

const ID = /^[A-Za-z0-9._-]{1,64}$/;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});

// Minimal facts from an already-verified delivery; nothing else is kept
export function extractFacts(event: unknown): WebhookFacts {
  const e = obj(event);
  const res = obj(e.resource);
  const eventId = typeof e.id === "string" && ID.test(e.id) ? e.id : null;
  const eventType = typeof e.event_type === "string" && e.event_type.length <= 64 ? e.event_type : null;
  if (!eventId || !eventType) throw new DomainError("invalid", "Invalid event");
  const rid = typeof res.id === "string" && ID.test(res.id) ? res.id : null;
  const oid = obj(obj(res.supplementary_data).related_ids).order_id;
  return { eventId, eventType, resourceId: rid, orderId: typeof oid === "string" && ID.test(oid) ? oid : null };
}

// Durable inbox row first; a duplicate of a finished event is acknowledged only
export async function recordEvent(env: string, f: WebhookFacts) {
  return tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO webhook_events (environment,provider_event_id,event_type,resource_id,payload)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (environment,provider_event_id) DO NOTHING RETURNING id`,
      [env, f.eventId, f.eventType, f.resourceId, JSON.stringify({ orderId: f.orderId })]);
    const row = (await c.query(`SELECT id, state FROM webhook_events WHERE environment=$1 AND provider_event_id=$2`, [env, f.eventId])).rows[0];
    return { id: row.id as number, done: !ins.rowCount && ["processed", "ignored"].includes(row.state) };
  });
}

const finish = (id: number, state: "processed" | "ignored" | "failed") =>
  tx((c) => c.query(`UPDATE webhook_events SET state=$2, attempts=attempts+1, updated_at=now() WHERE id=$1`, [id, state]));

// Reads provider state and applies it through the shared domain functions;
// it never creates or captures a payment
async function apply(payments: Payments, f: WebhookFacts): Promise<WebhookState> {
  const find = async (col: "paypal_order_id" | "capture_id", v: string | null) =>
    v ? (await tx((c) => c.query(`SELECT id, seller_order_id FROM payment_attempts WHERE ${col}=$1`, [v]))).rows[0] as { id: string; seller_order_id: string } | undefined : undefined;

  switch (f.eventType) {
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.PENDING": {
      const a = await find("paypal_order_id", f.orderId);
      if (!a) return "ignored";
      await settleCapture(a.id, await payments.getOrder(f.orderId!));
      return "processed";
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      const a = await find("capture_id", f.resourceId);
      if (!a) return "ignored";
      const mine = await refundsForAttempt(a.id);
      for (const r of mine) {
        if (["requested", "pending"].includes(r.status) && r.providerRefundId) await settleRefund(r.id, await payments.getRefund(r.providerRefundId));
      }
      // a refund we never asked for (for example from PayPal's dashboard) needs a person
      if (mine.length === 0) {
        const cap = await payments.getCapture(f.resourceId!);
        if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(cap.status.toUpperCase())) {
          await tx(async (c) => {
            const open = await c.query(`SELECT 1 FROM payment_exceptions WHERE attempt_id=$1 AND kind='external_refund' AND resolved_at IS NULL`, [a.id]);
            if (open.rowCount) return;
            const o = (await c.query(`SELECT task_id FROM seller_orders WHERE id=$1`, [a.seller_order_id])).rows[0];
            await c.query(`INSERT INTO payment_exceptions (id,task_id,attempt_id,kind,detail) VALUES ($1,$2,$3,'external_refund',$4)`,
              [randomUUID(), o.task_id, a.id, JSON.stringify({ captureStatus: cap.status })]);
          });
        }
      }
      return "processed";
    }
    case "PAYMENT.CAPTURE.REVERSED": {
      const a = await find("capture_id", f.resourceId);
      if (!a) return "ignored";
      const cap = await payments.getCapture(f.resourceId!);
      if (cap.captureId !== f.resourceId || cap.status.toUpperCase() !== "REVERSED") return "ignored";
      await tx(async (c) => {
        const o = (await c.query(`SELECT task_id, total_minor, currency FROM seller_orders WHERE id=$1`, [a.seller_order_id])).rows[0];
        if (cap.amountMinor !== o.total_minor || cap.currency !== o.currency) return;
        const open = await c.query(`SELECT 1 FROM payment_exceptions WHERE attempt_id=$1 AND kind='capture_reversed' AND resolved_at IS NULL`, [a.id]);
        if (!open.rowCount) {
          await c.query(`INSERT INTO payment_exceptions (id,task_id,attempt_id,kind,detail) VALUES ($1,$2,$3,'capture_reversed','{}')`, [randomUUID(), o.task_id, a.id]);
        }
      });
      return "processed";
    }
    case "PAYMENT.REFUND.PENDING":
    case "PAYMENT.REFUND.FAILED": {
      if (!f.resourceId) return "ignored";
      const r = (await tx((c) => c.query(`SELECT id FROM refunds WHERE provider_refund_id=$1`, [f.resourceId]))).rows[0];
      // unknown id: not ours, or the direct path has not stored it yet (the reconciler resends)
      if (!r) return "ignored";
      await settleRefund(r.id, await payments.getRefund(f.resourceId));
      return "processed";
    }
    default:
      return "ignored";
  }
}

export async function processEvent(payments: Payments, id: number, f: WebhookFacts): Promise<WebhookState> {
  try {
    const state = (HANDLED as readonly string[]).includes(f.eventType) ? await apply(payments, f) : "ignored";
    await finish(id, state);
    return state;
  } catch (e) {
    await finish(id, "failed").catch(() => {});
    throw e;
  }
}

import { randomUUID } from "node:crypto";
import type { Payments } from "@/adapters/types";
import { AdapterError } from "@/adapters/types";
import { tx, type Tx } from "./db";
import { DomainError } from "./errors";
import { logEvent } from "./events";

type Row = Record<string, unknown>;
export type RefundStatus = "requested" | "pending" | "completed" | "failed" | "cancelled";

export interface ObservedRefund { refundId: string; status: string; amountMinor?: number; currency?: string }

const LIVE = "('requested','pending','completed')";
const OPERATOR = /^[A-Za-z0-9._-]{1,40}$/;
// a lost first send is re-sent once with the same request id, never a new one
export const RESEND_AFTER_MS = 120_000;
export const MAX_RESENDS = 1;

export const refundView = (r: Row) => ({
  id: r.id as string, captureId: r.capture_id as string, orderId: r.seller_order_id as string,
  amountMinor: r.amount_minor as number, currency: r.currency as string, status: r.status as RefundStatus,
  providerRefundId: (r.provider_refund_id as string | null) ?? null, initiatedBy: r.initiated_by as string,
  createdAt: r.created_at as Date,
});
export type RefundView = ReturnType<typeof refundView>;

// captured minus completed minus reserved (requested and pending)
export async function refundableBalance(c: Tx, attemptId: string) {
  const a = (await c.query(
    `SELECT o.total_minor, o.currency FROM payment_attempts a JOIN seller_orders o ON o.id=a.seller_order_id WHERE a.id=$1`,
    [attemptId])).rows[0];
  if (!a) throw new DomainError("not_found", "Capture not found");
  const rows = (await c.query(`SELECT status, COALESCE(SUM(amount_minor),0) AS n FROM refunds WHERE attempt_id=$1 AND status IN ${LIVE} GROUP BY status`, [attemptId])).rows;
  const sum = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const completed = sum("completed"), reserved = sum("requested") + sum("pending");
  return { capturedMinor: a.total_minor as number, currency: a.currency as string, completedMinor: completed, reservedMinor: reserved, remainingMinor: a.total_minor - completed - reserved };
}

export interface RefundRequest {
  operator: string; captureId: string; amountMinor: number | "full"; operationKey: string; reason?: string;
}

// Reserves atomically under a lock on the capture's attempt row; no network here
export async function requestRefund(req: RefundRequest): Promise<{ refund: RefundView; created: boolean }> {
  if (!OPERATOR.test(req.operator)) throw new DomainError("invalid", "operator label is invalid");
  if (req.operationKey.length < 8 || req.operationKey.length > 100) throw new DomainError("invalid", "operationKey is invalid");
  if (req.reason !== undefined && req.reason.length > 200) throw new DomainError("invalid", "reason too long");
  if (req.amountMinor !== "full" && (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0)) {
    throw new DomainError("invalid", "amount must be a positive whole number of minor units");
  }
  return tx(async (c) => {
    const a = (await c.query(
      `SELECT a.id, a.status, a.capture_id, o.id AS order_id, o.task_id FROM payment_attempts a
         JOIN seller_orders o ON o.id=a.seller_order_id WHERE a.capture_id=$1 FOR UPDATE OF a`, [req.captureId])).rows[0];
    if (!a || a.status !== "captured") throw new DomainError("not_found", "No refundable capture");
    const bal = await refundableBalance(c, a.id);
    const want = req.amountMinor === "full" ? bal.remainingMinor : req.amountMinor;

    const prior = (await c.query(`SELECT * FROM refunds WHERE attempt_id=$1 AND operator_key=$2`, [a.id, req.operationKey])).rows[0];
    if (prior) {
      // "full" is only comparable to the amount it resolved to
      const same = req.amountMinor === "full" || prior.amount_minor === req.amountMinor;
      if (!same || prior.initiated_by !== req.operator) throw new DomainError("idempotency_mismatch", "operationKey was used for a different refund");
      return { refund: refundView(prior), created: false };
    }
    const open = (await c.query(`SELECT 1 FROM payment_exceptions WHERE attempt_id=$1 AND kind='capture_reversed' AND resolved_at IS NULL`, [a.id])).rowCount;
    if (open) throw new DomainError("conflict", "The capture was reversed by PayPal");
    if (want <= 0) throw new DomainError("conflict", "Nothing left to refund");
    if (want > bal.remainingMinor) throw new DomainError("conflict", "Amount exceeds the refundable balance");

    const empty = want === bal.capturedMinor && bal.completedMinor + bal.reservedMinor === 0;
    const row = (await c.query(
      `INSERT INTO refunds (id,attempt_id,seller_order_id,capture_id,amount_minor,currency,reason,initiated_by,operator_key,request_id,empty_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [randomUUID(), a.id, a.order_id, req.captureId, want, bal.currency, req.reason ?? null, req.operator, req.operationKey, randomUUID(), empty],
    )).rows[0];
    await logEvent(c, a.task_id, null, "refund.requested", { refundId: row.id, amountMinor: want });
    return { refund: refundView(row), created: true };
  });
}

// Provider facts only. Terminal states are final; amounts must match exactly.
export async function settleRefund(refundId: string, obs: ObservedRefund): Promise<{ refund: RefundView; flagged: boolean }> {
  return tx(async (c) => {
    const r = (await c.query(`SELECT * FROM refunds WHERE id=$1 FOR UPDATE`, [refundId])).rows[0];
    if (!r) throw new DomainError("not_found", "Refund not found");
    const out = async (flagged = false) => ({
      refund: refundView((await c.query(`SELECT * FROM refunds WHERE id=$1`, [refundId])).rows[0]), flagged,
    });
    const status = obs.status.toUpperCase();
    const task = (await c.query(`SELECT task_id FROM seller_orders WHERE id=$1`, [r.seller_order_id])).rows[0].task_id as string;
    const flag = async (kind: string) => {
      const dup = await c.query(`SELECT 1 FROM payment_exceptions WHERE attempt_id=$1 AND kind=$2 AND resolved_at IS NULL`, [r.attempt_id, kind]);
      if (!dup.rowCount) {
        await c.query(`INSERT INTO payment_exceptions (id,task_id,attempt_id,kind,detail) VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), task, r.attempt_id, kind, JSON.stringify({ refundId, status })]);
        await logEvent(c, task, null, "refund.flagged", { refundId, kind });
      }
      return out(true);
    };
    if (r.provider_refund_id && r.provider_refund_id !== obs.refundId) return flag("refund_mismatch");
    if (obs.currency !== undefined && obs.currency !== r.currency) return flag("refund_mismatch");
    if (obs.amountMinor !== undefined && obs.amountMinor !== r.amount_minor) return flag("refund_mismatch");

    const next: RefundStatus | null =
      status === "COMPLETED" ? "completed" : status === "PENDING" ? "pending"
      : status === "FAILED" ? "failed" : status === "CANCELLED" ? "cancelled" : null;
    if (!next) return out();
    if (next === "completed" && obs.amountMinor === undefined) return flag("refund_mismatch");
    const cur = r.status as RefundStatus;
    // no regression: only requested -> pending -> final moves forward
    const allowed = cur === "requested" || (cur === "pending" && next !== "pending");
    if (r.provider_refund_id === null || (allowed && next !== cur)) {
      await c.query(
        `UPDATE refunds SET provider_refund_id=COALESCE(provider_refund_id,$2), status=$3, updated_at=now() WHERE id=$1`,
        [refundId, obs.refundId, allowed ? next : cur]);
      if (allowed && next !== cur) await logEvent(c, task, null, `refund.${next}`, { refundId });
    }
    return out();
  });
}

const load = async (id: string) => (await tx((c) => c.query(`SELECT * FROM refunds WHERE id=$1`, [id]))).rows[0] as Row | undefined;

// Sends the persisted operation (same request id every time) and settles it
export async function executeRefund(refundId: string, payments: Payments): Promise<RefundView> {
  const r = await load(refundId);
  if (!r) throw new DomainError("not_found", "Refund not found");
  if (r.status !== "requested") return refundView(r);
  let obs: ObservedRefund;
  try {
    obs = await payments.refundCapture(r.capture_id as string, {
      amountMinor: r.empty_body ? undefined : (r.amount_minor as number),
      currency: r.currency as string, requestId: r.request_id as string,
    });
    if (obs.amountMinor === undefined) obs = await payments.getRefund(obs.refundId);
  } catch (e) {
    // a definitive provider rejection releases the reservation; anything else stays reserved
    if (e instanceof AdapterError && e.kind === "rejected") {
      await tx(async (c) => {
        const x = await c.query(`UPDATE refunds SET status='failed', updated_at=now() WHERE id=$1 AND status='requested' RETURNING seller_order_id`, [refundId]);
        if (x.rows[0]) {
          const t = (await c.query(`SELECT task_id FROM seller_orders WHERE id=$1`, [x.rows[0].seller_order_id])).rows[0].task_id;
          await logEvent(c, t, null, "refund.failed", { refundId });
        }
      });
      return refundView((await load(refundId))!);
    }
    throw e;
  }
  return (await settleRefund(refundId, obs)).refund;
}

export async function reconcileRefunds(payments: Payments, now = Date.now()) {
  const out = { checked: 0, resent: 0, errors: 0 };
  const { rows } = await tx((c) => c.query(`SELECT * FROM refunds WHERE status IN ('requested','pending') ORDER BY created_at`));
  for (const r of rows) {
    out.checked++;
    try {
      if (r.provider_refund_id) {
        await settleRefund(r.id, await payments.getRefund(r.provider_refund_id));
      } else if (r.status === "requested" && now - new Date(r.created_at).getTime() >= RESEND_AFTER_MS) {
        const claimed = await tx((c) => c.query(
          `UPDATE refunds SET resend_count=resend_count+1, updated_at=now() WHERE id=$1 AND status='requested' AND resend_count < $2 RETURNING id`,
          [r.id, MAX_RESENDS]));
        if (!claimed.rowCount) continue;
        out.resent++;
        await executeRefund(r.id, payments);
      }
    } catch {
      out.errors++;
    }
  }
  return out;
}

export async function refundsForAttempt(attemptId: string) {
  return (await tx((c) => c.query(`SELECT * FROM refunds WHERE attempt_id=$1 ORDER BY created_at`, [attemptId]))).rows.map(refundView);
}

// Buyer-facing totals, separate from paid and from fulfilment
export async function refundSummary(c: Tx, orderId: string) {
  const rows = (await c.query(`SELECT status, SUM(amount_minor) AS n FROM refunds WHERE seller_order_id=$1 AND status IN ('requested','pending','completed') GROUP BY status`, [orderId])).rows;
  const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((t, r) => t + Number(r.n), 0);
  return { refundedMinor: n(["completed"]), refundPendingMinor: n(["requested", "pending"]) };
}

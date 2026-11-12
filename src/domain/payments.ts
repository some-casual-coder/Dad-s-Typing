import { randomUUID } from "node:crypto";
import { authorize } from "./access";
import { onConciergePaid, onTopupPaid } from "./concierge";
import { tx, type Tx } from "./db";
import { DomainError } from "./errors";
import { logEvent } from "./events";

type Row = Record<string, unknown>;
export type OperationKind = "create" | "capture" | "refund";

const FAILED = new Set(["DECLINED", "DENIED", "FAILED", "VOIDED", "EXPIRED"]);
export const isTerminalFailure = (status: string) => FAILED.has(status.toUpperCase());
const OPEN = "('created','approved','pending')";

async function operationRow(c: Tx, attemptId: string, kind: OperationKind) {
  const id = randomUUID();
  const ins = await c.query(
    `INSERT INTO payment_operations (id,attempt_id,kind,request_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (attempt_id, kind) WHERE kind <> 'refund' DO NOTHING RETURNING *`,
    [id, attemptId, kind, randomUUID()],
  );
  if (ins.rows[0]) return ins.rows[0] as Row;
  return (await c.query(`SELECT * FROM payment_operations WHERE attempt_id=$1 AND kind=$2`, [attemptId, kind])).rows[0] as Row;
}

// Persist the operation before calling PayPal; a retry gets the same request ID
export const operationFor = (attemptId: string, kind: Exclude<OperationKind, "refund">) =>
  tx(async (c) => {
    const o = await operationRow(c, attemptId, kind);
    return { operationId: o.id as string, requestId: o.request_id as string };
  });

export const markOperation = (requestId: string, status: "succeeded" | "failed" | "unknown") =>
  tx((c) => c.query(`UPDATE payment_operations SET status=$2, updated_at=now() WHERE request_id=$1`, [requestId, status]));

export async function beginAttempt(taskId: string, token: string, orderId: string) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "pay");
    const o = (await c.query(`SELECT * FROM seller_orders WHERE id=$1 AND task_id=$2 FOR UPDATE`, [orderId, taskId])).rows[0];
    if (!o) throw new DomainError("not_found", "Order not found");
    if (o.status === "paid") throw new DomainError("conflict", "Already paid");
    const open = (await c.query(`SELECT * FROM payment_attempts WHERE seller_order_id=$1 AND status IN ${OPEN}`, [orderId])).rows[0];
    if (open) return attemptView(c, open, true);
    const live = (await c.query(`SELECT s.superseded_at, t.cancelled_at, s.task_version <> t.version AS changed FROM selections s JOIN tasks t ON t.id=s.task_id WHERE s.id=$1`, [o.selection_id])).rows[0];
    if (!live || live.superseded_at || live.cancelled_at || live.changed) throw new DomainError("stale", "The choice changed; it needs a fresh review");
    const a = (await c.query(
      `INSERT INTO payment_attempts (id,seller_order_id,created_by) VALUES ($1,$2,$3) RETURNING *`,
      [randomUUID(), orderId, g.id],
    )).rows[0];
    await c.query(`UPDATE seller_orders SET status='pending' WHERE id=$1`, [orderId]);
    await logEvent(c, taskId, g.id, "payment.attempt_started", { attemptId: a.id });
    return attemptView(c, a, false);
  });
}

export async function recordProviderOrder(attemptId: string, paypalOrderId: string) {
  return tx(async (c) => {
    const r = await c.query(
      `UPDATE payment_attempts SET paypal_order_id=COALESCE(paypal_order_id,$2), updated_at=now()
        WHERE id=$1 AND status IN ${OPEN} RETURNING *`,
      [attemptId, paypalOrderId],
    );
    if (!r.rows[0]) throw new DomainError("conflict", "Attempt is not open");
    if (r.rows[0].paypal_order_id !== paypalOrderId) throw new DomainError("conflict", "Attempt already bound to another PayPal order");
    await c.query(`UPDATE payment_operations SET status='succeeded', updated_at=now() WHERE attempt_id=$1 AND kind='create'`, [attemptId]);
    return attemptView(c, r.rows[0], true);
  });
}

export interface ObservedCapture {
  paypalOrderId: string; captureId?: string; status: string;
  amountMinor?: number; currency?: string; payeeMerchantId?: string;
}

// Unresolved attempts, plus cancelled ones whose capture may have landed
export async function listOpenAttempts() {
  const { rows } = await tx((c) => c.query(
    `SELECT a.id, a.seller_order_id, a.paypal_order_id, a.status FROM payment_attempts a
      WHERE a.status IN ${OPEN}
         OR (a.status IN ('cancelled','failed') AND EXISTS (
              SELECT 1 FROM payment_operations p WHERE p.attempt_id = a.id AND p.kind = 'capture' AND p.status IN ('started','unknown')))
      ORDER BY a.created_at`));
  return rows.map((r) => ({ id: r.id as string, orderId: r.seller_order_id as string, paypalOrderId: r.paypal_order_id as string | null, status: r.status as string }));
}

// Provider facts only: paid needs a COMPLETED capture matching the order
export async function settleCapture(attemptId: string, obs: ObservedCapture) {
  return tx(async (c) => {
    const a = (await c.query(`SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE`, [attemptId])).rows[0];
    if (!a) throw new DomainError("not_found", "Attempt not found");
    const o = (await c.query(`SELECT * FROM seller_orders WHERE id=$1 FOR UPDATE`, [a.seller_order_id])).rows[0];
    const status = obs.status.toUpperCase();
    const result = async (flagged = false) => ({
      attempt: await attemptView(c, (await c.query(`SELECT * FROM payment_attempts WHERE id=$1`, [attemptId])).rows[0], true),
      order: (await c.query(`SELECT status FROM seller_orders WHERE id=$1`, [o.id])).rows[0].status as string,
      flagged,
    });

    if (a.status === "captured") return result();
    // an older non-final event must not undo a cancelled or failed attempt
    if ((a.status === "cancelled" || a.status === "failed") && status !== "COMPLETED") return result();

    const flag = async (kind: string) => {
      const open = await c.query(`SELECT 1 FROM payment_exceptions WHERE attempt_id=$1 AND kind=$2 AND resolved_at IS NULL`, [attemptId, kind]);
      if (open.rowCount) return result(true);
      await c.query(`INSERT INTO payment_exceptions (id,task_id,attempt_id,kind,detail) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), o.task_id, attemptId, kind, JSON.stringify({ status, paypalOrderId: obs.paypalOrderId })]);
      await c.query(`UPDATE payment_attempts SET status='pending', updated_at=now() WHERE id=$1`, [attemptId]);
      await c.query(`UPDATE seller_orders SET status='pending' WHERE id=$1`, [o.id]);
      await logEvent(c, o.task_id, null, "payment.flagged", { attemptId, kind });
      return result(true);
    };

    if (a.paypal_order_id && a.paypal_order_id !== obs.paypalOrderId) return flag("order_mismatch");

    const set = async (attempt: string, order: string) => {
      await c.query(
        `UPDATE payment_attempts SET status=$2, capture_id=COALESCE($3,capture_id), paypal_order_id=COALESCE(paypal_order_id,$4), updated_at=now() WHERE id=$1`,
        [attemptId, attempt, attempt === "captured" ? obs.captureId ?? null : null, obs.paypalOrderId],
      );
      await c.query(`UPDATE seller_orders SET status=$2 WHERE id=$1`, [o.id, order]);
      if (attempt === "captured") await c.query(`UPDATE payment_operations SET status='succeeded', updated_at=now() WHERE attempt_id=$1 AND kind='capture'`, [attemptId]);
      if (attempt === "captured" && o.kind === "concierge") await onConciergePaid(c, o);
      if (attempt === "captured" && o.kind === "topup") await onTopupPaid(c, o);
      await logEvent(c, o.task_id, null, `payment.${attempt}`, { attemptId, orderId: o.id });
      return result();
    };

    if (status === "COMPLETED") {
      const ok = obs.captureId && obs.amountMinor === o.total_minor && obs.currency === o.currency && obs.payeeMerchantId === o.merchant_id;
      if (!ok) return flag("capture_mismatch");
      const sel = (await c.query(`SELECT superseded_at FROM selections WHERE id=$1`, [o.selection_id])).rows[0];
      if (sel?.superseded_at) {
        // the money moved for an order the task has since moved past: record it for review
        await c.query(`INSERT INTO payment_exceptions (id,task_id,attempt_id,kind,detail) VALUES ($1,$2,$3,'superseded_selection',$4)`,
          [randomUUID(), o.task_id, attemptId, JSON.stringify({ paypalOrderId: obs.paypalOrderId })]);
      }
      return set("captured", "paid");
    }
    if (status === "PENDING") return set("pending", "pending");
    if (status === "CANCELLED") return set("cancelled", "awaiting_payer");
    if (FAILED.has(status)) return set("failed", "awaiting_payer");
    return result();   // CREATED, APPROVED, PAYER_ACTION_REQUIRED: still waiting
  });
}

async function attemptView(c: Tx, a: Row, resumed: boolean) {
  const op = await operationRow(c, a.id as string, "create");
  return {
    id: a.id as string, orderId: a.seller_order_id as string, createRequestId: op.request_id as string,
    paypalOrderId: a.paypal_order_id as string | null, status: a.status as string, captureId: a.capture_id as string | null, resumed,
  };
}

export async function hasCaptureOperation(attemptId: string) {
  const r = await tx((c) => c.query(`SELECT 1 FROM payment_operations WHERE attempt_id=$1 AND kind='capture' AND status <> 'failed'`, [attemptId]));
  return r.rowCount! > 0;
}

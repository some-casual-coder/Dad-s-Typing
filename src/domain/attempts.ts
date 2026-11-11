import { authorize } from "./access";
import { tx } from "./db";
import { DomainError } from "./errors";

export type AttemptRef = { attemptId: string } | { paypalOrderId: string };

// Payer-only lookup so routes never trust a client-supplied attempt id
export async function getPayerAttempt(taskId: string, token: string, ref: AttemptRef) {
  return tx(async (c) => {
    await authorize(c, taskId, token, "pay");
    const byAttempt = "attemptId" in ref;
    const { rows } = await c.query(
      `SELECT a.id, a.seller_order_id, a.paypal_order_id, a.status
         FROM payment_attempts a JOIN seller_orders o ON o.id = a.seller_order_id
        WHERE ${byAttempt ? "a.id" : "a.paypal_order_id"} = $1 AND o.task_id = $2`,
      [byAttempt ? ref.attemptId : ref.paypalOrderId, taskId],
    );
    if (!rows[0]) throw new DomainError("not_found", "Attempt not found");
    return { id: rows[0].id as string, orderId: rows[0].seller_order_id as string, paypalOrderId: rows[0].paypal_order_id as string | null, status: rows[0].status as string };
  });
}

import { expect, it } from "vitest";
import { getPayments } from "@/adapters";
import { pool } from "@/domain/db";
import { operatorRefund } from "@/domain/operator";
import { reconcileRefunds, refundableBalance, refundsForAttempt } from "@/domain/refunds";

// Refunds the existing captured sandbox payment: USD 10.00, then the remainder.
// Fixed operation keys make a re-run resume the same operations, never add new ones.
const last4 = (s: string | null) => (s ? `...${s.slice(-4)}` : null);

it("partial then remaining refund on a real sandbox capture, reconciled from the API", async () => {
  const a = (await pool.query(`SELECT id, capture_id FROM payment_attempts WHERE status='captured' AND capture_id IS NOT NULL ORDER BY updated_at LIMIT 1`)).rows[0];
  expect(a).toBeTruthy();
  const p = getPayments();
  const bal = async () => { const c = await pool.connect(); try { return await refundableBalance(c, a.id); } finally { c.release(); } };
  console.log("before", JSON.stringify({ capture: last4(a.capture_id), ...(await bal()) }));

  const first = await operatorRefund(p, { operator: "live-proof", captureId: a.capture_id, amountMinor: 1000, operationKey: "live-proof-partial-1", reason: "sandbox proof" });
  console.log("partial", JSON.stringify({ status: first.status, amountMinor: first.amountMinor, currency: first.currency, refund: last4(first.providerRefundId) }));
  const rest = await operatorRefund(p, { operator: "live-proof", captureId: a.capture_id, amountMinor: "full", operationKey: "live-proof-remainder-1" });
  console.log("remainder", JSON.stringify({ status: rest.status, amountMinor: rest.amountMinor, currency: rest.currency, refund: last4(rest.providerRefundId) }));

  // independent read of each refund from the API, then reconcile any still pending
  for (const r of await refundsForAttempt(a.id)) {
    if (!r.providerRefundId) continue;
    const o = await p.getRefund(r.providerRefundId);
    console.log("api", JSON.stringify({ refund: last4(o.refundId), status: o.status, amountMinor: o.amountMinor, currency: o.currency, local: r.status }));
    expect(o.amountMinor).toBe(r.amountMinor);
  }
  console.log("reconcile", JSON.stringify(await reconcileRefunds(p)));
  const after = await refundsForAttempt(a.id);
  console.log("after", JSON.stringify({ ...(await bal()), refunds: after.map((r) => ({ status: r.status, amountMinor: r.amountMinor, refund: last4(r.providerRefundId) })) }));
  const att = (await pool.query(`SELECT status FROM payment_attempts WHERE id=$1`, [a.id])).rows[0];
  console.log("attempt", att.status);
  expect(att.status).toBe("captured");
  await pool.end();
}, 120_000);

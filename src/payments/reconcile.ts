import { listOpenAttempts, settleCapture } from "@/domain/payments";
import type { Payments } from "@/adapters/types";
import { reconcileRefunds } from "@/domain/refunds";

export async function reconcileOpenAttempts(payments: Payments) {
  const out = { checked: 0, settled: 0, errors: 0 };
  for (const a of await listOpenAttempts()) {
    if (!a.paypalOrderId) continue;
    out.checked++;
    try {
      const r = await settleCapture(a.id, await payments.getOrder(a.paypalOrderId));
      if (r.attempt.status !== a.status) out.settled++;
    } catch {
      out.errors++;
    }
  }
  // refunds are reconciled from the API too, with or without a webhook
  const refunds = await reconcileRefunds(payments);
  return { ...out, refunds };
}

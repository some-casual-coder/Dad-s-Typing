import { listOpenAttempts, settleCapture } from "@/domain/payments";
import type { Payments } from "@/adapters/types";

// Only a final COMPLETED reading settles; anything else stays open
export async function reconcileOpenAttempts(payments: Payments) {
  const out = { checked: 0, settled: 0, errors: 0 };
  for (const a of await listOpenAttempts()) {
    if (!a.paypalOrderId) continue;
    out.checked++;
    try {
      const obs = await payments.getOrder(a.paypalOrderId);
      if (obs.status.toUpperCase() !== "COMPLETED") continue;
      await settleCapture(a.id, obs);
      out.settled++;
    } catch {
      out.errors++;
    }
  }
  return out;
}

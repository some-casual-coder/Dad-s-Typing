import { getPayments } from "@/adapters";
import { getPayerAttempt } from "@/domain/attempts";
import { DomainError } from "@/domain/errors";
import { hasCaptureOperation, settleCapture } from "@/domain/payments";
import { getTaskView } from "@/domain/view";
import { attemptRef, bearer, handle, json, readJson, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  const a = await getPayerAttempt(taskId, token, attemptRef(await readJson(req, 1_000)));
  if (a.paypalOrderId) {
    // a capture may already be in flight, so PayPal decides before we cancel
    if (await hasCaptureOperation(a.id)) {
      const obs = await getPayments().getOrder(a.paypalOrderId).catch(() => null);
      if (!obs) throw new DomainError("conflict", "Checking the payment; try again shortly");
      if (["COMPLETED", "PENDING"].includes(obs.status.toUpperCase())) await settleCapture(a.id, obs);
      else await settleCapture(a.id, { paypalOrderId: a.paypalOrderId, status: "CANCELLED" });
    } else {
      await settleCapture(a.id, { paypalOrderId: a.paypalOrderId, status: "CANCELLED" });
    }
  }
  return json({ order: (await getTaskView(taskId, token)).order });
});

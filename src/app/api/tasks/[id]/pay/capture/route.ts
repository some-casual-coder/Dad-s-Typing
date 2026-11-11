import { getPayments } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { getPayerAttempt } from "@/domain/attempts";
import { DomainError } from "@/domain/errors";
import { isTerminalFailure, markOperation, operationFor, settleCapture, type ObservedCapture } from "@/domain/payments";
import { getTaskView } from "@/domain/view";
import { attemptRef, bearer, handle, json, readJson, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  const a = await getPayerAttempt(taskId, token, attemptRef(await readJson(req, 1_000)));
  const respond = async (status: string, flagged: boolean) => {
    const v = await getTaskView(taskId, token);
    return json({ order: v.order, attempt: { id: a.id, status }, flagged, receipt: v.receipt ?? undefined });
  };

  if (a.status === "captured") return respond("captured", false);
  if (!["created", "approved", "pending"].includes(a.status)) throw new DomainError("not_payable", "This payment attempt is closed");
  if (!a.paypalOrderId) throw new DomainError("conflict", "Payment has not been started");
  if (!a.current) throw new DomainError("stale", "The choice changed; this payment was not taken");

  const payments = getPayments();
  const op = await operationFor(a.id, "capture");
  let obs: ObservedCapture | null = null;
  try {
    obs = await payments.capture(a.paypalOrderId, op.requestId);
  } catch (e) {
    if (e instanceof AdapterError && e.kind === "rejected") {
      // an expired or voided order cannot be captured; free the attempt
      obs = await payments.getOrder(a.paypalOrderId).catch(() => null);
      if (!obs || !isTerminalFailure(obs.status)) throw e;
      const s = await settleCapture(a.id, obs);
      return respond(s.attempt.status, s.flagged);
    }
    if (!(e instanceof AdapterError) || e.kind !== "timeout") throw e;
    await markOperation(op.requestId, "unknown");
    // One look at PayPal; still unclear means we keep checking later
    obs = await payments.getOrder(a.paypalOrderId).catch(() => null);
    if (!obs || obs.status.toUpperCase() !== "COMPLETED") {
      return json({ status: "checking_payment" }, 202);
    }
  }
  const s = await settleCapture(a.id, obs);
  return respond(s.attempt.status, s.flagged);
});

import { getPayerAttempt } from "@/domain/attempts";
import { settleCapture } from "@/domain/payments";
import { getTaskView } from "@/domain/view";
import { attemptRef, bearer, handle, json, readJson, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  const a = await getPayerAttempt(taskId, token, attemptRef(await readJson(req, 1_000)));
  // Without a PayPal order there is nothing to cancel; the attempt stays resumable
  if (a.paypalOrderId) await settleCapture(a.id, { paypalOrderId: a.paypalOrderId, status: "CANCELLED" });
  return json({ order: (await getTaskView(taskId, token)).order });
});

import { getPayments } from "@/adapters";
import { beginAttempt, operationFor, recordProviderOrder } from "@/domain/payments";
import { DomainError } from "@/domain/errors";
import { getTaskView } from "@/domain/view";
import { bearer, handle, json, readJson, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  const orderId = uuid((await readJson(req, 1_000)).orderId);
  const attempt = await beginAttempt(taskId, token, orderId);
  // Amounts come from the frozen order row, never the request
  const v = await getTaskView(taskId, token);
  const order = v.order?.id === orderId ? v.order : v.topup?.id === orderId ? { ...v.topup, title: `Extra shipping: ${v.order?.title ?? ""}`, itemMinor: v.topup.totalMinor, shippingMinor: 0 } : null;
  if (!order) throw new DomainError("not_found", "Order not found");
  const op = await operationFor(attempt.id, "create");
  const base = process.env.APP_BASE_URL ?? "";
  const returnUrl = `${base}/t/${taskId}/pay/return`;
  // Resume re-creates with the same request id; PayPal returns the same order
  const created = await getPayments().createOrder({
    requestId: op.requestId, referenceId: order.id, currency: order.currency, totalMinor: order.totalMinor,
    itemMinor: order.itemMinor, shippingMinor: order.shippingMinor, description: order.title.slice(0, 127),
    returnUrl, cancelUrl: `${returnUrl}?cancelled=1`,
  });
  await recordProviderOrder(attempt.id, created.paypalOrderId);
  return json({ attemptId: attempt.id, paypalOrderId: created.paypalOrderId, approveUrl: created.approveUrl });
});

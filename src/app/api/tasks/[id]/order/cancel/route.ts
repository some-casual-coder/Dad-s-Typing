import { getPayments } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { cancelOrder } from "@/domain/concierge";
import { bearer, clientIp, handle, json, rateLimit, uuid } from "../../../../_lib/http";

export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`ocancel:${clientIp(req)}`, 10);
  try {
    return json(await cancelOrder(getPayments(), uuid(id), bearer(req)));
  } catch (e) {
    // the refund is reserved durably; the reconciler finishes it
    if (e instanceof AdapterError) return json({ status: "checking_refund" }, 202);
    throw e;
  }
});

import { executeRefund, requestRefund, type RefundView } from "./refunds";
import type { Payments } from "@/adapters/types";

// Operator path: reserve durably first, then one provider call per operation
export async function operatorRefund(payments: Payments, req: Parameters<typeof requestRefund>[0]): Promise<RefundView> {
  const { refund } = await requestRefund(req);
  return refund.status === "requested" ? executeRefund(refund.id, payments) : refund;
}

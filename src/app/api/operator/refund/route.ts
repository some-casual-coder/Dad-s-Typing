import { getPayments } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { MAX_BODY, verifyHmac } from "@/channel/bridge";
import { DomainError } from "@/domain/errors";
import { operatorRefund } from "@/domain/operator";
import { handle, invalid, json, readJson, str } from "../../_lib/http";

const last4 = (s: string | null) => (s ? s.slice(-4) : null);

// Restricted operator path only; there is no merchant UI
export const POST = handle(async (req) => {
  const secret = process.env.OPERATOR_SECRET ?? "";
  if (secret.length < 32) throw new DomainError("forbidden", "Not allowed");
  if (Number(req.headers.get("content-length") ?? "0") > 2_000) throw new DomainError("forbidden", "Not allowed");
  const text = await req.text();
  if (text.length > 2_000 || text.length > MAX_BODY) throw new DomainError("forbidden", "Not allowed");
  verifyHmac(secret, req, text);
  const body = await readJson(new Request(req.url, { method: "POST", body: text }), 2_000);
  const amount = body.full === true ? "full" : body.amountMinor;
  if (amount !== "full" && typeof amount !== "number") throw invalid("amountMinor or full required");
  const payments = getPayments();
  try {
    const r = await operatorRefund(payments, {
      operator: str(body, "operator", { max: 40, min: 1 })!, captureId: str(body, "captureId", { max: 64, min: 5 })!,
      amountMinor: amount, operationKey: str(body, "operationKey", { max: 100, min: 8 })!,
      reason: str(body, "reason", { max: 200, optional: true }),
    });
    return json({ refund: { id: r.id, status: r.status, amountMinor: r.amountMinor, currency: r.currency, providerRefundId: last4(r.providerRefundId), initiatedBy: r.initiatedBy } });
  } catch (e) {
    // the reservation is durable; the same operationKey resumes this exact operation
    if (e instanceof AdapterError) return json({ status: "checking_refund" }, 202);
    throw e;
  }
});

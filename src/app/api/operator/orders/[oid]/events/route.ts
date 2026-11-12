import { randomUUID } from "node:crypto";
import { getPayments } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { recordFulfilment } from "@/domain/concierge";
import { requireOperator } from "@/domain/operatorSession";
import { clientIp, handle, invalid, json, rateLimit, readJson, str, uuid } from "../../../../_lib/http";

// Console form: one status, optional note, optional actual bill or weighed parcel
export const POST = handle<{ oid: string }>(async (req, { oid }) => {
  requireOperator(req);
  rateLimit(`opevt:${clientIp(req)}`, 60);
  const b = await readJson(req, 2_000);
  const source = b.source === "provider" ? "provider" : "operator";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
  const a = b.actual && typeof b.actual === "object" ? (b.actual as Record<string, unknown>) : null;
  if (a && !str(a, "source", { max: 120, min: 3, optional: true })) throw invalid("say where the actual comes from");
  try {
    return json(await recordFulfilment(getPayments(), {
      orderId: uuid(oid), status: str(b, "status", { max: 30, min: 3 })!, source,
      key: str(b, "operationKey", { max: 100, min: 8, optional: true }) ?? `console:${randomUUID()}`, note: str(b, "note", { max: 200, optional: true }),
      actual: a ? { totalMinor: num(a.totalMinor), grams: num(a.grams), lengthMm: num(a.lengthMm), widthMm: num(a.widthMm), heightMm: num(a.heightMm),
        source: str(a, "source", { max: 120, min: 3 })! } : undefined,
    }));
  } catch (e) {
    if (e instanceof AdapterError) return json({ status: "checking_refund" }, 202);
    throw e;
  }
});

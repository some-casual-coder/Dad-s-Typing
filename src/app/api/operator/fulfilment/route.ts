import { getPayments } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { MAX_BODY, verifyHmac } from "@/channel/bridge";
import { channelIds, channelSecret, isConfigured } from "@/channel/registry";
import { recordFulfilment } from "@/domain/concierge";
import { DomainError } from "@/domain/errors";
import { handle, invalid, json, readJson, str, uuid } from "../../_lib/http";

// Restricted operator path, same gate as refunds: provider or operator facts only
export const POST = handle(async (req) => {
  const secret = process.env.OPERATOR_SECRET ?? "";
  if (secret.length < 32) throw new DomainError("forbidden", "Not allowed");
  if (process.env.NODE_ENV === "production" && process.env.OPERATOR_ENABLED !== "1") throw new DomainError("forbidden", "Not allowed");
  if (channelIds().some((id) => isConfigured(id) && channelSecret(id) === secret)) throw new DomainError("forbidden", "Not allowed");
  const text = await req.text();
  if (text.length > 2_000 || text.length > MAX_BODY) throw new DomainError("forbidden", "Not allowed");
  verifyHmac(secret, req, text);
  const b = await readJson(new Request(req.url, { method: "POST", body: text }), 2_000);
  const source = b.source === "provider" ? "provider" : b.source === "operator" ? "operator" : null;
  if (!source) throw invalid("source must be provider or operator");
  const a = b.actual as Record<string, unknown> | undefined;
  if (a !== undefined && (typeof a !== "object" || a === null)) throw invalid("actual is invalid");
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  try {
    return json(await recordFulfilment(getPayments(), {
      orderId: uuid(b.orderId), status: str(b, "status", { max: 30, min: 3 })!, source, key: str(b, "operationKey", { max: 100, min: 8 })!,
      note: str(b, "note", { max: 200, optional: true }),
      actual: a ? { totalMinor: num(a.totalMinor), grams: num(a.grams), lengthMm: num(a.lengthMm), widthMm: num(a.widthMm), heightMm: num(a.heightMm),
        hub: a.hub === "texas" || a.hub === "delaware" ? a.hub : undefined, source: str(a, "source", { max: 120, min: 3 })! } : undefined,
    }));
  } catch (e) {
    if (e instanceof AdapterError) return json({ status: "checking_refund" }, 202);
    throw e;
  }
});

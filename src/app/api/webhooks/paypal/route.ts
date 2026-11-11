import { getPayments } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { DomainError } from "@/domain/errors";
import { extractFacts, processEvent, recordEvent } from "@/domain/webhooks";
import { handle, HttpError, json } from "../../_lib/http";

const MAX = 64 * 1024;
const H = (req: Request, n: string) => req.headers.get(n) ?? "";
const PAYPAL_CERT = /^https:\/\/[a-z0-9.-]+\.paypal\.com\//;

// Off unless PAYPAL_WEBHOOK_ID is set; PayPal verifies the signature, not us
export const POST = handle(async (req) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID ?? "";
  if (!webhookId) throw new HttpError(404, "not_found", "Not found");
  if (!/^application\/json\b/i.test(H(req, "content-type"))) throw new HttpError(415, "unsupported", "Unsupported");
  if (Number(H(req, "content-length") || "0") > MAX) throw new HttpError(413, "too_large", "Too large");
  const raw = await req.text();
  if (raw.length > MAX) throw new HttpError(413, "too_large", "Too large");

  const h = {
    transmissionId: H(req, "paypal-transmission-id"), transmissionTime: H(req, "paypal-transmission-time"),
    transmissionSig: H(req, "paypal-transmission-sig"), certUrl: H(req, "paypal-cert-url"), authAlgo: H(req, "paypal-auth-algo"),
  };
  if (Object.values(h).some((v) => !v || v.length > 2048) || !PAYPAL_CERT.test(h.certUrl)) throw new HttpError(400, "invalid", "Invalid");
  let event: unknown;
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, "invalid", "Invalid"); }

  const payments = getPayments();
  let ok = false;
  try {
    ok = await payments.verifyWebhook({ ...h, webhookId, rawEvent: raw });
  } catch (e) {
    // could not verify: fail closed, and ask PayPal to retry
    if (e instanceof AdapterError && e.kind === "rejected") throw new HttpError(400, "invalid", "Invalid");
    throw new HttpError(503, "unavailable", "Try again");
  }
  if (!ok) throw new HttpError(400, "invalid", "Invalid");

  let facts;
  try { facts = extractFacts(event); } catch (e) { if (e instanceof DomainError) throw new HttpError(400, "invalid", "Invalid"); throw e; }
  const { id, done } = await recordEvent(process.env.PAYPAL_ENV ?? "sandbox", facts);
  if (done) return json({ ok: true, duplicate: true });
  const state = await processEvent(payments, id, facts);
  return json({ ok: true, state });
});

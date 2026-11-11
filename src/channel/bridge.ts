import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/domain/errors";
import { channelSecret, getChannel } from "./registry";

const MAX_SKEW_S = 300;
export const MAX_BODY = 6 * 1024 * 1024;

export const sign = (secret: string, ts: string, method: string, path: string, body: string) =>
  createHmac("sha256", secret).update(`${ts}\n${method}\n${path}\n${body}`).digest("hex");

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Fails closed: no secret, no signature, stale clock or wrong MAC all reject
export function verifySigned(channel: string, req: Request, body: string, now = Date.now()) {
  const secret = channelSecret(channel);
  const ts = req.headers.get("x-dt-timestamp") ?? "";
  const sig = req.headers.get("x-dt-signature") ?? "";
  if (!/^\d{10}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) throw new DomainError("forbidden", "Bad signature");
  if (Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_S) throw new DomainError("forbidden", "Stale request");
  const path = new URL(req.url).pathname;
  if (!safeEqual(sig, sign(secret, ts, req.method, path, body))) throw new DomainError("forbidden", "Bad signature");
}

// Read the raw body first: the MAC covers the exact bytes
export async function readSigned(channel: string, req: Request): Promise<Record<string, unknown>> {
  getChannel(channel);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new DomainError("invalid", "Body too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new DomainError("invalid", "Body too large");
  verifySigned(channel, req, text);
  try {
    const v = JSON.parse(text || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new DomainError("invalid", "Body must be a JSON object");
  }
}

// Keyed per channel, so one connector's secret never yields another's tokens
export const deriveChannelToken = (channel: string, grantId: string) =>
  createHmac("sha256", channelSecret(channel)).update(`grant:${channel}:${grantId}`).digest("base64url");

export const senderHash = (channel: string, sender: string) =>
  createHmac("sha256", channelSecret(channel)).update(`sender:${channel}:${sender}`).digest("hex");

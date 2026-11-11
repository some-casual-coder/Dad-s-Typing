import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
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
export function verifyHmac(secret: string, req: Request, body: string, now = Date.now()) {
  const ts = req.headers.get("x-dt-timestamp") ?? "";
  const sig = req.headers.get("x-dt-signature") ?? "";
  if (!/^\d{10}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) throw new DomainError("forbidden", "Not allowed");
  if (Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_S) throw new DomainError("forbidden", "Not allowed");
  const path = new URL(req.url).pathname;
  if (!safeEqual(sig, sign(secret, ts, req.method, path, body))) throw new DomainError("forbidden", "Not allowed");
}

export const verifySigned = (channel: string, req: Request, body: string, now = Date.now()) =>
  verifyHmac(channelSecret(channel), req, body, now);

// Read the raw body first: the MAC covers the exact bytes
export async function readSigned(channel: string, req: Request): Promise<Record<string, unknown>> {
  // unknown, unconfigured and badly signed all look the same from outside
  try {
    getChannel(channel);
    channelSecret(channel);
  } catch {
    throw new DomainError("forbidden", "Not allowed");
  }
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

// The request MAC uses the secret itself (the connector signs with it); every
// other use gets its own HKDF subkey so purposes cannot be confused
const subkey = (channel: string, purpose: "grant" | "sender") =>
  Buffer.from(hkdfSync("sha256", channelSecret(channel), "dt-channel-v1", `${channel}:${purpose}`, 32));

export const deriveChannelToken = (channel: string, grantId: string) =>
  createHmac("sha256", subkey(channel, "grant")).update(grantId).digest("base64url");

export const senderHash = (channel: string, sender: string) =>
  createHmac("sha256", subkey(channel, "sender")).update(sender).digest("hex");

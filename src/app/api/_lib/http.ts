import { DomainError } from "@/domain/errors";
import { AdapterError } from "@/adapters/types";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const body = (code: string, message: string) => ({ error: { code, message } });
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

// Missing or malformed credentials reveal nothing about any task
export function bearer(req: Request): string {
  const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "unauthorized", "Sign-in link needed");
  return m[1];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new DomainError("not_found", "Not found");
  return v;
}

export const invalid = (message: string) => new DomainError("invalid", message);

export function handle<P = Record<string, never>>(fn: (req: Request, params: P) => Promise<Response>) {
  return async (req: Request, ctx?: { params: Promise<P> }): Promise<Response> => {
    try {
      return await fn(req, (await ctx?.params) ?? ({} as P));
    } catch (e) {
      if (e instanceof HttpError) return json(body(e.code, e.message), e.status);
      if (e instanceof DomainError) return json(body(e.code, e.message), e.status);
      if (e instanceof AdapterError) {
        console.error("api_error", "AdapterError", e.kind);
        return e.kind === "timeout"
          ? json(body("provider_timeout", "The service took too long. Please try again."), 504)
          : json(body("provider_unavailable", "The service is unavailable. Please try again."), 502);
      }
      console.error("api_error", e instanceof Error ? e.name : "unknown", (e as { code?: unknown })?.code ?? "");
      return json(body("internal", "Something went wrong."), 500);
    }
  };
}

export async function readJson(req: Request, maxChars: number): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxChars) throw new HttpError(413, "too_large", "Request too large");
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError(413, "too_large", "Request too large");
  let v: unknown;
  try { v = text ? JSON.parse(text) : {}; } catch { throw invalid("Invalid JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("Invalid body");
  return v as Record<string, unknown>;
}

export function str(o: Record<string, unknown>, k: string, opts: { max: number; min?: number; optional?: boolean }): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opts.optional) return undefined;
    throw invalid(`${k} required`);
  }
  if (typeof v !== "string" || v.length > opts.max || v.length < (opts.min ?? 0)) throw invalid(`${k} is invalid`);
  return v;
}

export function attemptRef(body: Record<string, unknown>) {
  if (body.attemptId !== undefined) return { attemptId: uuid(body.attemptId) };
  const id = body.paypalOrderId;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{5,64}$/.test(id)) throw invalid("attemptId or paypalOrderId required");
  return { paypalOrderId: id };
}

export function idempotencyKey(req: Request): string {
  const k = req.headers.get("idempotency-key");
  if (!k) return crypto.randomUUID();
  if (k.length > 100) throw invalid("Idempotency-Key too long");
  return k;
}

// Small fixed-window limiter; the map is capped so it cannot grow unbounded
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs = 60_000) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  if (hits.size > 5000) hits.clear();
  const h = hits.get(key);
  if (!h || h.reset < now) return void hits.set(key, { n: 1, reset: now + windowMs });
  if (++h.n > max) throw new HttpError(429, "rate_limited", "Too many requests, slow down");
}

// x-forwarded-for is spoofable unless a trusted proxy sets it
export const clientIp = (req: Request) =>
  process.env.TRUST_PROXY === "1" ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local" : "local";

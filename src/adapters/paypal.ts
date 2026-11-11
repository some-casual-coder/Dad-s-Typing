import { fromDecimalString, toDecimalString } from "@/domain/money";
import type { ObservedCapture } from "@/domain/payments";
import { failFor, jsonOf, send } from "./http";
import { AdapterError, type CreateOrderInput, type Payments } from "./types";

const SANDBOX = "https://api-m.sandbox.paypal.com";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function mapOrder(order: unknown): ObservedCapture {
  const o = obj(order);
  const id = str(o.id);
  if (!id) throw new AdapterError("unavailable", "PayPal order has no id");
  const unit = obj((Array.isArray(o.purchase_units) ? o.purchase_units : [])[0]);
  const caps = obj(unit.payments).captures;
  const cap = Array.isArray(caps) && caps.length
    ? obj([...caps].sort((a, b) => (str(obj(a).create_time) ?? "").localeCompare(str(obj(b).create_time) ?? "")).at(-1))
    : undefined;
  const payeeMerchantId = str(obj(unit.payee).merchant_id);
  if (!cap) return { paypalOrderId: id, status: str(o.status) ?? "UNKNOWN", payeeMerchantId };
  const amount = obj(cap.amount);
  const currency = str(amount.currency_code);
  const value = str(amount.value);
  return {
    paypalOrderId: id, captureId: str(cap.id), status: str(cap.status) ?? "UNKNOWN", currency, payeeMerchantId,
    amountMinor: currency && value ? fromDecimalString(value, currency) : undefined,
  };
}

export class PayPalPayments implements Payments {
  private token?: { value: string; expiresAt: number };

  constructor(private cfg: { env: string | undefined; baseUrl: string; clientId: string; clientSecret: string }) {
    if (cfg.env !== "sandbox" || cfg.baseUrl !== SANDBOX) throw new AdapterError("rejected", "PayPal adapter is sandbox only");
    if (!cfg.clientId || !cfg.clientSecret) throw new AdapterError("unavailable", "PayPal is not configured");
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const r = await send(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) throw failFor(r.status, "PayPal auth");
    const j = obj(await jsonOf(r, "PayPal auth"));
    const value = str(j.access_token);
    const ttl = Number(j.expires_in);
    if (!value || !Number.isFinite(ttl)) throw new AdapterError("unavailable", "PayPal auth response invalid");
    this.token = { value, expiresAt: Date.now() + ttl * 1000 };
    return value;
  }

  private async call(method: "GET" | "POST", path: string, opts: { requestId?: string; body?: object; prefer?: string } = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.bearer()}`, "Content-Type": "application/json" };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    if (opts.prefer) headers.Prefer = opts.prefer;
    const r = await send(`${this.cfg.baseUrl}${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (r.status === 401) this.token = undefined;
    return { status: r.status, ok: r.ok, json: obj(await r.json().catch(() => ({}))) };
  }

  async createOrder(i: CreateOrderInput) {
    if (i.itemMinor + i.shippingMinor !== i.totalMinor) throw new AdapterError("rejected", "amounts do not add up");
    const dec = (n: number) => toDecimalString(n, i.currency);
    const money = (n: number) => ({ currency_code: i.currency, value: dec(n) });
    const res = await this.call("POST", "/v2/checkout/orders", {
      requestId: i.requestId,
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: i.referenceId, description: i.description.slice(0, 127),
          amount: { ...money(i.totalMinor), breakdown: { item_total: money(i.itemMinor), shipping: money(i.shippingMinor) } },
        }],
        payment_source: { paypal: { experience_context: { return_url: i.returnUrl, cancel_url: i.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
      },
    });
    if (!res.ok) throw failFor(res.status, "PayPal create order");
    const links = Array.isArray(res.json.links) ? res.json.links.map(obj) : [];
    const link = links.find((l) => l.rel === "payer-action") ?? links.find((l) => l.rel === "approve");
    const approveUrl = str(link?.href);
    const paypalOrderId = str(res.json.id);
    if (!paypalOrderId || !approveUrl?.startsWith("https://")) throw new AdapterError("unavailable", "PayPal order response invalid");
    return { paypalOrderId, approveUrl };
  }

  async capture(paypalOrderId: string, requestId: string): Promise<ObservedCapture> {
    const res = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, { requestId, prefer: "return=representation", body: {} });
    if (res.ok) return mapOrder(res.json);
    const issues = Array.isArray(res.json.details) ? res.json.details.map((d) => str(obj(d).issue)) : [];
    if (res.status === 422 && issues.includes("INSTRUMENT_DECLINED")) return { paypalOrderId, status: "DECLINED" };
    if (res.status === 422 && issues.includes("ORDER_NOT_APPROVED")) return this.getOrder(paypalOrderId);
    throw failFor(res.status, "PayPal capture");
  }

  async getOrder(paypalOrderId: string): Promise<ObservedCapture> {
    const res = await this.call("GET", `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
    if (!res.ok) throw failFor(res.status, "PayPal get order");
    return mapOrder(res.json);
  }
}

export function paypalFromEnv(env = process.env): Payments {
  return new PayPalPayments({
    env: env.PAYPAL_ENV, baseUrl: env.PAYPAL_BASE_URL ?? SANDBOX,
    clientId: env.PAYPAL_CLIENT_ID ?? "", clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
  });
}

export async function discoverMerchantId(p: Payments, orderId: string): Promise<string | undefined> {
  return (await p.getOrder(orderId)).payeeMerchantId;
}

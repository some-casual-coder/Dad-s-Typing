import { afterEach, describe, expect, it, vi } from "vitest";
import { validateInterpretation, GeminiInterpreter } from "@/adapters/gemini";
import { mapProduct, Channel3Discovery } from "@/adapters/channel3";
import { PayPalPayments, discoverMerchantId, isSandboxPayPalUrl } from "@/adapters/paypal";
import { OpenRouterInterpreter } from "@/adapters/openrouter";
import { AdapterError } from "@/adapters/types";

const BASE = "https://api-m.sandbox.paypal.com";
const cfg = { env: "sandbox", baseUrl: BASE, clientId: "id", clientSecret: "secret" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const input = { requestId: "req-1", referenceId: "ref-1", currency: "USD", totalMinor: 5700, itemMinor: 4900, shippingMinor: 800, description: "Carrier", returnUrl: "https://x.test/r", cancelUrl: "https://x.test/c" };

afterEach(() => vi.unstubAllGlobals());

function stub(...responses: (Response | Error)[]) {
  const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const token = () => json({ access_token: "tok", expires_in: 3600 });

describe("paypal", () => {
  it("refuses anything but the sandbox", () => {
    expect(() => new PayPalPayments({ ...cfg, env: "live" })).toThrow(AdapterError);
    expect(() => new PayPalPayments({ ...cfg, baseUrl: "https://api-m.paypal.com" })).toThrow(AdapterError);
  });

  it("sends the request id and decimal amounts, returns the payer-action link", async () => {
    const f = stub(token(), json({ id: "O1", links: [{ rel: "self", href: "https://a" }, { rel: "payer-action", href: "https://sandbox.paypal.com/approve?token=O1" }] }, 201));
    const r = await new PayPalPayments(cfg).createOrder(input);
    expect(r).toEqual({ paypalOrderId: "O1", approveUrl: "https://sandbox.paypal.com/approve?token=O1" });
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v2/checkout/orders`);
    expect((init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("req-1");
    const body = JSON.parse(init.body as string);
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "57.00", breakdown: { item_total: { currency_code: "USD", value: "49.00" }, shipping: { currency_code: "USD", value: "8.00" } } });
    expect(body.payment_source.paypal.experience_context).toMatchObject({ user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" });
  });

  it("caches the token until expiry", async () => {
    const f = stub(token(), json({ id: "A", status: "CREATED" }), json({ id: "A", status: "CREATED" }));
    const p = new PayPalPayments(cfg);
    await p.getOrder("A");
    await p.getOrder("A");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("maps a capture", async () => {
    const f = stub(token(), json({ id: "O1", status: "COMPLETED", purchase_units: [{ payee: { merchant_id: "M1" }, payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "57.00" }, create_time: "2026-01-01T00:00:00Z" }] } }] }, 201));
    const o = await new PayPalPayments(cfg).capture("O1", "req-2");
    expect(o).toEqual({ paypalOrderId: "O1", captureId: "C1", status: "COMPLETED", amountMinor: 5700, currency: "USD", payeeMerchantId: "M1" });
    const init = f.mock.calls[1][1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>)).toMatchObject({ "PayPal-Request-Id": "req-2", Prefer: "return=representation" });
  });

  it("reports the order status when not approved, and DECLINED on decline", async () => {
    stub(token(), json({ details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422), json({ id: "O1", status: "CREATED", purchase_units: [{ payee: { merchant_id: "M1" } }] }));
    expect(await new PayPalPayments(cfg).capture("O1", "r")).toMatchObject({ status: "CREATED", payeeMerchantId: "M1" });
    stub(token(), json({ details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422));
    expect((await new PayPalPayments(cfg).capture("O1", "r")).status).toBe("DECLINED");
  });

  it("getOrder uses the latest capture and exposes the payee", async () => {
    const order = { id: "O1", status: "COMPLETED", purchase_units: [{ payee: { merchant_id: "M9" }, payments: { captures: [
      { id: "C1", status: "DECLINED", amount: { currency_code: "USD", value: "1.00" }, create_time: "2026-01-01T00:00:00Z" },
      { id: "C2", status: "PENDING", amount: { currency_code: "USD", value: "2.50" }, create_time: "2026-01-02T00:00:00Z" }] } }] };
    stub(token(), json(order));
    const p = new PayPalPayments(cfg);
    expect(await p.getOrder("O1")).toMatchObject({ captureId: "C2", status: "PENDING", amountMinor: 250 });
    stub(json(order));
    expect(await discoverMerchantId(p, "O1")).toBe("M9");
  });

  it("maps timeouts and 4xx without leaking secrets", async () => {
    stub(token(), Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(new PayPalPayments(cfg).getOrder("O1")).rejects.toMatchObject({ kind: "timeout" });
    stub(token(), json({ name: "X" }, 400));
    const err = await new PayPalPayments(cfg).createOrder(input).catch((e) => e);
    expect(err).toMatchObject({ kind: "rejected" });
    expect(err.message).not.toMatch(/tok|secret/);
  });
});

describe("gemini validation", () => {
  const ok = { key: "opening", op: "eq", value: "top", essential: true, quote: "it must open from the top" };
  const wrap = (r: object) => ({ observations: [], proposedRequirements: [r], clarification: null, reply: "ok" });
  const text = "I like it, it must open from the top";

  it("accepts a clear essential requirement", () => {
    expect(validateInterpretation(wrap(ok), text).proposedRequirements[0]).toMatchObject({ key: "opening", op: "eq", value: "top", essential: true });
  });
  it("rejects bad ops, unknown keys, bad values and non-finite numbers", () => {
    expect(() => validateInterpretation(wrap({ ...ok, op: "like" }), text)).toThrow();
    expect(() => validateInterpretation(wrap({ ...ok, op: "lte" }), text)).toThrow();
    expect(() => validateInterpretation(wrap({ ...ok, key: "price" }), text)).toThrow();
    expect(() => validateInterpretation(wrap({ ...ok, key: "__proto__" }), text)).toThrow();
    expect(() => validateInterpretation(wrap({ ...ok, value: "bottom" }), text)).toThrow();
    for (const v of ["NaN", "Infinity", "abc", ""]) {
      expect(() => validateInterpretation(wrap({ key: "internal_length_cm", op: "gte", value: v, essential: false, quote: "" }))).toThrow();
    }
  });
  it("is essential only when the user clearly said must or need", () => {
    expect(validateInterpretation(wrap({ ...ok, quote: "I like it" }), "I like it").proposedRequirements[0].essential).toBe(false);
    expect(validateInterpretation(wrap(ok), "unrelated").proposedRequirements[0].essential).toBe(false);
    const neg = "it does not need to open from the top";
    expect(validateInterpretation(wrap({ ...ok, op: "neq", quote: neg }), neg).proposedRequirements[0].essential).toBe(false);
  });
  it("sends text as data and maps a timeout", async () => {
    const f = stub(json({ candidates: [{ content: { parts: [{ text: JSON.stringify(wrap(ok)) }] } }] }));
    const r = await new GeminiInterpreter("k", "m").interpret({ text, currentRequirements: [] });
    expect(r.proposedRequirements).toHaveLength(1);
    const init = f.mock.calls[0][1] as unknown as RequestInit;
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    expect(JSON.parse(init.body as string).generationConfig.responseSchema).toBeTruthy();
    stub(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(new GeminiInterpreter("k", "m").interpret({ text, currentRequirements: [] })).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("gemini retry", () => {
  const body = { observations: [], proposedRequirements: [], clarification: "Top?", reply: "ok" };
  const good = () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] });
  const run = () => new GeminiInterpreter("k", "m").interpret({ text: "hi", currentRequirements: [] });

  it("retries an overloaded response then succeeds", async () => {
    const f = stub(json({}, 503), json({}, 429), good());
    expect((await run()).clarification).toBe("Top?");
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("gives up after three attempts and never retries a timeout", async () => {
    const f = stub(json({}, 503), json({}, 503), json({}, 503));
    await expect(run()).rejects.toMatchObject({ kind: "unavailable" });
    expect(f).toHaveBeenCalledTimes(3);
    const g = stub(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(run()).rejects.toMatchObject({ kind: "timeout" });
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe("channel3 mapping", () => {
  const product = (extra: object = {}) => ({ id: "p1", title: "Top Loader Carrier", structured_attributes: { material: ["Plastic"] },
    offers: [{ url: "https://buy.example/x", domain: "shop.test", price: { price: 35.99, currency: "USD" }, availability: "InStock" }], ...extra });

  it("leaves attributes empty when there is no evidence, even if the title says top", () => {
    const o = mapProduct(product())!;
    expect(o).toMatchObject({ route: "external", unitPriceMinor: 3599, shippingMinor: null, currency: "USD", seller: "shop.test", availability: "InStock" });
    expect(o.attributes).toEqual({});
  });
  it("uses an explicit opening attribute only", () => {
    expect(mapProduct(product({ structured_attributes: { "opening-type": ["Top"] } }))!.attributes.opening).toMatchObject({ value: "top" });
  });
  it("rejects non-https offer urls and bad prices", () => {
    expect(mapProduct(product({ offers: [{ url: "http://x.test", price: { price: 1, currency: "USD" } }] }))).toBeNull();
    expect(mapProduct(product({ offers: [{ url: "https://x.test", price: { price: "1", currency: "USD" } }] }))).toBeNull();
  });
  it("posts the documented body and refuses other countries", async () => {
    const f = stub(json({ products: [product()] }));
    const d = new Channel3Discovery("key");
    expect(await d.search({ query: "cat carrier", country: "GB", limit: 3 })).toHaveLength(1);
    const init = f.mock.calls[0][1] as unknown as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ query: "cat carrier", limit: 3, config: { country: "GB" } });
    await expect(d.search({ query: "x", country: "KE" as "US", limit: 1 })).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("openrouter", () => {
  const out = { observations: [], proposedRequirements: [{ key: "opening", op: "eq", value: "top", essential: true, quote: "must open from the top" }], clarification: null, reply: "ok" };
  const reply = (body: unknown) => json({ choices: [{ message: { content: JSON.stringify(body) } }] });
  const run = (text = "it must open from the top") => new OpenRouterInterpreter("k", "m/x").interpret({ text, currentRequirements: [] });

  it("sends a bearer request with a plain json schema and validates the output", async () => {
    const f = stub(reply(out));
    const r = await run();
    expect(r.proposedRequirements[0]).toMatchObject({ key: "opening", value: "top", essential: true });
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("m/x");
    expect(body.response_format.json_schema.schema.type).toBe("object");
    expect(body.response_format.json_schema.schema.properties.clarification.type).toEqual(["string", "null"]);
    expect(body.messages[1].content[0].text).toContain("untrusted data");
  });
  it("attaches an image as a data uri", async () => {
    const f = stub(reply(out));
    await new OpenRouterInterpreter("k", "m").interpret({ text: "x", image: { mime: "image/png", base64: "AAAA" }, currentRequirements: [] });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).messages[1].content[1].image_url.url).toBe("data:image/png;base64,AAAA");
  });
  it("rejects output outside the allowlist and maps a credit error", async () => {
    stub(reply({ ...out, proposedRequirements: [{ key: "price", op: "eq", value: "1", essential: true, quote: "" }] }));
    await expect(run()).rejects.toBeInstanceOf(AdapterError);
    stub(json({}, 402));
    await expect(run()).rejects.toMatchObject({ kind: "rejected" });
  });
});

describe("approval url", () => {
  it("accepts only https sandbox PayPal hosts", () => {
    expect(isSandboxPayPalUrl("https://www.sandbox.paypal.com/checkoutnow?token=A")).toBe(true);
    for (const bad of ["http://www.sandbox.paypal.com/x", "https://paypal.com.evil.test/x", "https://evil.test/www.sandbox.paypal.com", "https://www.paypal.com/x", "javascript:alert(1)", "", undefined]) {
      expect(isSandboxPayPalUrl(bad as string)).toBe(false);
    }
  });
});

describe("refund error classification", () => {
  const pay = () => new PayPalPayments(cfg);
  it("only a plain refusal is definitive; 408, 409 and 422 stay unknown", async () => {
    for (const [code, kind] of [[400, "rejected"], [403, "rejected"], [404, "rejected"], [408, "unavailable"], [409, "unavailable"], [422, "unavailable"], [500, "unavailable"]] as const) {
      stub(token(), json({ name: "X" }, code));
      await expect(pay().refundCapture("CAP123456", { amountMinor: 100, currency: "USD", requestId: "r" })).rejects.toMatchObject({ kind });
    }
  });
});

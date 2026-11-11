import "./env";
process.env.OPERATOR_SECRET = "o".repeat(40);
process.env.PAYPAL_WEBHOOK_ID = "WH-TEST";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdapterError, type Payments } from "@/adapters/types";
import { PayPalPayments } from "@/adapters/paypal";
import { sign } from "@/channel/bridge";
import { pool } from "@/domain/db";
import { beginAttempt, recordProviderOrder, settleCapture } from "@/domain/payments";
import { executeRefund, reconcileRefunds, refundableBalance, requestRefund, settleRefund } from "@/domain/refunds";
import { operatorRefund } from "@/domain/operator";
import { getTaskView } from "@/domain/view";
import { createInvite, createSellerOrder, createTask, getComparison, recordOffers, selectOffer, setRequirement } from "@/domain/tasks";
import { processEvent, recordEvent, extractFacts } from "@/domain/webhooks";

const gate = vi.hoisted(() => ({ payments: null as unknown }));
vi.mock("@/adapters", () => ({ getPayments: () => gate.payments, getInterpreter: () => ({}), getDiscovery: () => ({}) }));
import { POST as operatorRoute } from "@/app/api/operator/refund/route";
import { POST as webhookRoute } from "@/app/api/webhooks/paypal/route";

const mk = () => ({
  createOrder: vi.fn(), capture: vi.fn(), getOrder: vi.fn(), refundCapture: vi.fn(), getRefund: vi.fn(),
  getCapture: vi.fn(), verifyWebhook: vi.fn(),
});
type Mock = ReturnType<typeof mk>;
const as = (m: Mock) => m as unknown as Payments;
let n = 0;
const key = () => `k${++n}-${Date.now()}-${randomUUID().slice(0, 6)}`;

async function captured() {
  const nathan = await createTask({ title: "Cat carrier", starterRoles: ["helper", "payer"], starterLabel: "N" });
  const mum = await createInvite(nathan.taskId, nathan.token, { roles: ["requester", "chooser"], label: "M" });
  await recordOffers(nathan.taskId, [{ source: "demo", sourceOfferId: "TOP-1", route: "paypal", seller: "Demo", merchantId: "MERCH1", sku: "TOP-1", title: "Carrier", attributes: { opening: { value: "top", source: "spec" } }, unitPriceMinor: 3599, shippingMinor: 800, currency: "USD", availability: "InStock" }]);
  await setRequirement(nathan.taskId, mum.token, { key: "opening", value: "top" }, { idempotencyKey: key() });
  const cmp = await getComparison(nathan.taskId, mum.token);
  const sel = await selectOffer(nathan.taskId, mum.token, { offerId: cmp.offers[0].id, expectedVersion: cmp.version }, { idempotencyKey: key() });
  const order = await createSellerOrder(nathan.taskId, nathan.token, { selectionId: sel.selectionId });
  const att = await beginAttempt(nathan.taskId, nathan.token, order.id);
  const pp = key(), cap = `CAP${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await recordProviderOrder(att.id, pp);
  await settleCapture(att.id, { paypalOrderId: pp, captureId: cap, status: "COMPLETED", amountMinor: 4399, currency: "USD", payeeMerchantId: "MERCH1" });
  return { taskId: nathan.taskId, mum: mum.token, attemptId: att.id, pp, cap, orderId: order.id };
}
const balance = async (id: string) => { const c = await pool.connect(); try { return await refundableBalance(c, id); } finally { c.release(); } };
const op = (cap: string, amountMinor: number | "full", operationKey = key()) => ({ operator: "ops", captureId: cap, amountMinor, operationKey });
const ok = (id: string, amountMinor?: number, status = "COMPLETED") => ({ refundId: id, status, amountMinor, currency: "USD" });

describe("refund reservation", () => {
  it("rejects bad amounts, over-refund, unknown capture and bad operator", async () => {
    const s = await captured();
    for (const a of [0, -1, 1.5, Number.NaN]) await expect(requestRefund(op(s.cap, a))).rejects.toMatchObject({ code: "invalid" });
    await expect(requestRefund(op(s.cap, 4400))).rejects.toMatchObject({ code: "conflict" });
    await expect(requestRefund(op("NOPE-CAP", 100))).rejects.toMatchObject({ code: "not_found" });
    await expect(requestRefund({ ...op(s.cap, 100), operator: "bad label!" })).rejects.toMatchObject({ code: "invalid" });
    expect((await balance(s.attemptId)).remainingMinor).toBe(4399);
  });

  it("concurrent requests cannot over-refund; duplicates return the same operation", async () => {
    const s = await captured();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => requestRefund(op(s.cap, 1500))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const b = await balance(s.attemptId);
    expect(b.reservedMinor).toBe(3000);
    expect(b.remainingMinor).toBe(1399);

    const k = key();
    const [a, c] = await Promise.all([requestRefund(op(s.cap, 100, k)), requestRefund(op(s.cap, 100, k))]);
    expect(a.refund.id).toBe(c.refund.id);
    expect([a.created, c.created].filter(Boolean)).toHaveLength(1);
    await expect(requestRefund(op(s.cap, 200, k))).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("the database itself refuses an over-reservation", async () => {
    const s = await captured();
    await requestRefund(op(s.cap, 4000));
    await expect(pool.query(
      `INSERT INTO refunds (id,attempt_id,seller_order_id,capture_id,amount_minor,currency,initiated_by,operator_key,request_id)
       VALUES ($1,$2,$3,$4,500,'USD','ops',$5,$6)`, [randomUUID(), s.attemptId, s.orderId, s.cap, key(), randomUUID()],
    )).rejects.toThrow(/exceeds captured/);
  });
});

describe("refund execution", () => {
  it("one provider call per operation; same request id; partial then explicit remainder", async () => {
    const s = await captured();
    const p = mk();
    p.refundCapture.mockResolvedValueOnce(ok("R1", 1000)).mockResolvedValueOnce(ok("R2", 3399));
    const k = key();
    const a = await operatorRefund(as(p), op(s.cap, 1000, k));
    const dup = await operatorRefund(as(p), op(s.cap, 1000, k));
    expect(dup.id).toBe(a.id);
    expect(p.refundCapture).toHaveBeenCalledTimes(1);
    expect(p.refundCapture.mock.calls[0][1]).toMatchObject({ amountMinor: 1000, currency: "USD" });
    const rest = await operatorRefund(as(p), op(s.cap, "full"));
    expect(rest).toMatchObject({ amountMinor: 3399, status: "completed" });
    expect(p.refundCapture.mock.calls[1][1].amountMinor).toBe(3399);
    expect(p.refundCapture.mock.calls[0][1].requestId).not.toBe(p.refundCapture.mock.calls[1][1].requestId);
    expect((await balance(s.attemptId)).remainingMinor).toBe(0);
    const v = await getTaskView(s.taskId, s.mum);
    expect(v.receipt).toMatchObject({ totalMinor: 4399, refundedMinor: 4399, refundPendingMinor: 0 });
    expect(v.nextAction).toBe("paid");
  });

  it("an untouched full refund uses the documented empty body", async () => {
    const s = await captured();
    const p = mk();
    p.refundCapture.mockResolvedValue(ok("RF", 4399));
    await operatorRefund(as(p), op(s.cap, "full"));
    expect(p.refundCapture.mock.calls[0][1].amountMinor).toBeUndefined();
  });

  it("timeout after PayPal accepted: reservation held, resend reuses the request id once", async () => {
    const s = await captured();
    const p = mk();
    p.refundCapture.mockRejectedValueOnce(new AdapterError("timeout", "t"));
    const { refund } = await requestRefund(op(s.cap, 1200));
    await expect(executeRefund(refund.id, as(p))).rejects.toBeInstanceOf(AdapterError);
    expect((await balance(s.attemptId)).reservedMinor).toBe(1200);
    // too early: no resend
    expect((await reconcileRefunds(as(p))).resent).toBe(0);
    p.refundCapture.mockImplementation(async (cap: string) => {
      if (cap !== s.cap) throw new AdapterError("timeout", "t");
      return ok("RLATE", 1200, "PENDING");
    });
    const later = Date.now() + 3 * 60_000;
    const r = await reconcileRefunds(as(p), later);
    expect(r.resent).toBeGreaterThanOrEqual(1);
    const mine = p.refundCapture.mock.calls.filter((c) => c[0] === s.cap);
    expect(mine).toHaveLength(2);
    expect(mine[0][1].requestId).toBe(mine[1][1].requestId);
    const row = (await pool.query(`SELECT status, provider_refund_id FROM refunds WHERE id=$1`, [refund.id])).rows[0];
    expect(row).toEqual({ status: "pending", provider_refund_id: "RLATE" });
    // a still-failing resend is not retried again (policy: once)
    const s2 = await captured();
    const q = mk();
    q.refundCapture.mockRejectedValue(new AdapterError("timeout", "t"));
    const r2 = await requestRefund(op(s2.cap, 500));
    await executeRefund(r2.refund.id, as(q)).catch(() => {});
    await reconcileRefunds(as(q), Date.now() + 3 * 60_000);
    await reconcileRefunds(as(q), Date.now() + 6 * 60_000);
    expect(q.refundCapture.mock.calls.filter((c) => c[0] === s2.cap)).toHaveLength(2);
  });

  it("pending stays reserved and reconciles to completed; failure releases", async () => {
    const s = await captured();
    const p = mk();
    p.refundCapture.mockResolvedValueOnce(ok("RP", 2000, "PENDING"));
    const a = await operatorRefund(as(p), op(s.cap, 2000));
    expect(a.status).toBe("pending");
    expect((await balance(s.attemptId)).reservedMinor).toBe(2000);
    expect((await getTaskView(s.taskId, s.mum)).receipt).toMatchObject({ refundedMinor: 0, refundPendingMinor: 2000 });
    p.getRefund.mockResolvedValue(ok("RP", 2000, "COMPLETED"));
    await reconcileRefunds(as(p));
    expect((await balance(s.attemptId))).toMatchObject({ completedMinor: 2000, reservedMinor: 0 });

    p.refundCapture.mockResolvedValueOnce(ok("RF2", 2399, "PENDING"));
    const b = await operatorRefund(as(p), op(s.cap, 2399));
    p.getRefund.mockResolvedValue(ok("RF2", 2399, "FAILED"));
    await reconcileRefunds(as(p));
    expect((await balance(s.attemptId)).remainingMinor).toBe(2399);
    // terminal states never regress, and stale readings are ignored
    await settleRefund(b.id, ok("RF2", 2399, "COMPLETED"));
    await settleRefund(b.id, ok("RF2", 2399, "PENDING"));
    expect((await pool.query(`SELECT status FROM refunds WHERE id=$1`, [b.id])).rows[0].status).toBe("failed");
    await settleRefund(a.id, ok("RP", 2000, "PENDING"));
    expect((await pool.query(`SELECT status FROM refunds WHERE id=$1`, [a.id])).rows[0].status).toBe("completed");
  });

  it("a definitive provider rejection releases the reservation", async () => {
    const s = await captured();
    const p = mk();
    p.refundCapture.mockRejectedValue(new AdapterError("rejected", "422"));
    const r = await operatorRefund(as(p), op(s.cap, 700));
    expect(r.status).toBe("failed");
    expect((await balance(s.attemptId)).remainingMinor).toBe(4399);
  });

  it("amount or currency mismatch is flagged, not applied", async () => {
    const s = await captured();
    const { refund } = await requestRefund(op(s.cap, 900));
    const r = await settleRefund(refund.id, ok("RM", 800));
    expect(r.flagged).toBe(true);
    expect(r.refund.status).toBe("requested");
    expect((await settleRefund(refund.id, { refundId: "RM", status: "COMPLETED", amountMinor: 900, currency: "GBP" })).flagged).toBe(true);
    expect((await settleRefund(refund.id, { refundId: "RM", status: "COMPLETED" })).flagged).toBe(true);
  });
});

describe("operator route", () => {
  const send = async (body: object, opts: { secret?: string; ts?: string; badSig?: boolean } = {}) => {
    const text = JSON.stringify(body);
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const sig = opts.badSig ? "0".repeat(64) : sign(opts.secret ?? process.env.OPERATOR_SECRET!, ts, "POST", "/api/operator/refund", text);
    return operatorRoute(new Request("http://localhost/api/operator/refund", { method: "POST", body: text, headers: { "x-dt-timestamp": ts, "x-dt-signature": sig } }));
  };
  it("rejects unsigned, wrongly signed, stale and disabled; accepts a signed refund once", async () => {
    const s = await captured();
    const p = mk();
    gate.payments = p;
    p.refundCapture.mockResolvedValue(ok("RO123456", 500));
    const body = { operator: "nathan", captureId: s.cap, amountMinor: 500, operationKey: "op-key-0001" };
    expect((await send(body, { badSig: true })).status).toBe(403);
    expect((await send(body, { secret: "x".repeat(40) })).status).toBe(403);
    expect((await send(body, { ts: String(Math.floor(Date.now() / 1000) - 4000) })).status).toBe(403);
    expect((await operatorRoute(new Request("http://localhost/api/operator/refund", { method: "POST", body: "{}" }))).status).toBe(403);
    expect(p.refundCapture).not.toHaveBeenCalled();
    const r = await send(body);
    expect(r.status).toBe(200);
    expect((await r.json()).refund).toMatchObject({ status: "completed", providerRefundId: "3456", initiatedBy: "nathan" });
    await send(body);
    expect(p.refundCapture).toHaveBeenCalledTimes(1);
    expect((await send({ ...body, operationKey: "op-key-0002", amountMinor: 0 })).status).toBe(422);
    const saved = process.env.OPERATOR_SECRET;
    process.env.OPERATOR_SECRET = "short";
    expect((await send(body, { secret: "short" })).status).toBe(403);
    process.env.OPERATOR_SECRET = saved;
  });
});

describe("webhook", () => {
  const hdr = { "content-type": "application/json", "paypal-transmission-id": "tid", "paypal-transmission-time": "2026-11-11T10:00:00Z", "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "paypal-auth-algo": "SHA256withRSA" };
  const post = (event: object, headers: Record<string, string> = hdr) =>
    webhookRoute(new Request("http://localhost/api/webhooks/paypal", { method: "POST", body: JSON.stringify(event), headers }));
  const ev = (type: string, resource: object, id = `WH-${randomUUID()}`) => ({ id, event_type: type, resource });

  it("is disabled without PAYPAL_WEBHOOK_ID and does nothing", async () => {
    const p = mk(); gate.payments = p;
    const saved = process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_WEBHOOK_ID;
    expect((await post(ev("PAYMENT.CAPTURE.COMPLETED", {}))).status).toBe(404);
    process.env.PAYPAL_WEBHOOK_ID = saved;
    expect(p.verifyWebhook).not.toHaveBeenCalled();
  });

  it("limits size and type, and rejects a non-PayPal cert url before verifying", async () => {
    const p = mk(); gate.payments = p;
    expect((await post(ev("X", {}), { ...hdr, "content-type": "text/plain" })).status).toBe(415);
    const big = await webhookRoute(new Request("http://localhost/api/webhooks/paypal", { method: "POST", body: "x".repeat(70_000), headers: hdr }));
    expect(big.status).toBe(413);
    expect((await post(ev("X", {}), { ...hdr, "paypal-cert-url": "https://evil.example/cert" })).status).toBe(400);
    expect((await post(ev("X", {}), { ...hdr, "paypal-transmission-sig": "" })).status).toBe(400);
    expect(p.verifyWebhook).not.toHaveBeenCalled();
  });

  it("invalid signature and verification errors fail closed and persist nothing", async () => {
    const p = mk(); gate.payments = p;
    const e = ev("PAYMENT.REFUND.PENDING", { id: "RX1" });
    p.verifyWebhook.mockResolvedValueOnce(false);
    expect((await post(e)).status).toBe(400);
    p.verifyWebhook.mockRejectedValueOnce(new AdapterError("unavailable", "x"));
    expect((await post(e)).status).toBe(503);
    expect((await pool.query(`SELECT 1 FROM webhook_events WHERE provider_event_id=$1`, [e.id])).rowCount).toBe(0);
  });

  it("verification request has the documented shape, using the raw event and the fixed origin", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return String(url).includes("oauth2") ? Response.json({ access_token: "tok", expires_in: 3600 }) : Response.json({ verification_status: "SUCCESS" });
    });
    const pp = new PayPalPayments({ env: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "sec" });
    const raw = '{"id":"WH-1","event_type":"PAYMENT.REFUND.PENDING","resource":{"id":"R1","amount":{"value":"10.00"}}}';
    expect(await pp.verifyWebhook({ transmissionId: "t1", transmissionTime: "2026-11-11T10:00:00Z", transmissionSig: "sg", certUrl: "https://api.sandbox.paypal.com/c", authAlgo: "SHA256withRSA", webhookId: "WH-ID", rawEvent: raw })).toBe(true);
    f.mockRestore();
    const v = calls.find((c) => c.url.includes("verify-webhook-signature"))!;
    expect(v.url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(v.init.method).toBe("POST");
    expect(JSON.parse(v.init.body as string)).toEqual({
      auth_algo: "SHA256withRSA", cert_url: "https://api.sandbox.paypal.com/c", transmission_id: "t1",
      transmission_sig: "sg", transmission_time: "2026-11-11T10:00:00Z", webhook_id: "WH-ID", webhook_event: JSON.parse(raw),
    });
    expect((v.init.body as string).endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(calls.every((c) => c.url.startsWith("https://api-m.sandbox.paypal.com/"))).toBe(true);
  });

  it("refund events settle through the domain, dedupe, ignore unknowns, and never regress", async () => {
    const s = await captured();
    const p = mk(); gate.payments = p;
    p.verifyWebhook.mockResolvedValue(true);
    p.refundCapture.mockResolvedValueOnce(ok("RW1", 1000, "PENDING"));
    const r = await operatorRefund(as(p), op(s.cap, 1000));
    p.getRefund.mockResolvedValue(ok("RW1", 1000, "COMPLETED"));
    const e = ev("PAYMENT.REFUND.PENDING", { id: "RW1" });
    expect(await (await post(e)).json()).toMatchObject({ state: "processed" });
    expect((await pool.query(`SELECT status FROM refunds WHERE id=$1`, [r.id])).rows[0].status).toBe("completed");
    const calls = p.getRefund.mock.calls.length;
    expect(await (await post(e)).json()).toMatchObject({ duplicate: true });
    expect(p.getRefund.mock.calls.length).toBe(calls);
    // a late failed event for the same refund reads the provider and cannot undo completion
    expect((await post(ev("PAYMENT.REFUND.FAILED", { id: "RW1" }))).status).toBe(200);
    expect((await pool.query(`SELECT status FROM refunds WHERE id=$1`, [r.id])).rows[0].status).toBe("completed");
    expect(await (await post(ev("PAYMENT.REFUND.PENDING", { id: "UNKNOWN-R" }))).json()).toMatchObject({ state: "ignored" });
    expect(await (await post(ev("BILLING.SOMETHING", { id: "Z" }))).json()).toMatchObject({ state: "ignored" });
    const row = (await pool.query(`SELECT payload, state FROM webhook_events WHERE provider_event_id=$1`, [e.id])).rows[0];
    expect(row.state).toBe("processed");
    expect(Object.keys(row.payload)).toEqual(["orderId"]);
  });

  it("capture events resolve the order via the API and never capture", async () => {
    const s = await captured();
    const p = mk(); gate.payments = p;
    p.verifyWebhook.mockResolvedValue(true);
    p.getOrder.mockResolvedValue({ paypalOrderId: s.pp, captureId: s.cap, status: "COMPLETED", amountMinor: 4399, currency: "USD", payeeMerchantId: "MERCH1" });
    const res = ev("PAYMENT.CAPTURE.COMPLETED", { id: s.cap, supplementary_data: { related_ids: { order_id: s.pp } } });
    expect(await (await post(res)).json()).toMatchObject({ state: "processed" });
    expect(p.capture).not.toHaveBeenCalled();
    expect(await (await post(ev("PAYMENT.CAPTURE.COMPLETED", { id: "C9", supplementary_data: { related_ids: { order_id: "NOT-OURS" } } }))).json()).toMatchObject({ state: "ignored" });
    // out of order: PENDING after COMPLETED cannot undo paid
    p.getOrder.mockResolvedValue({ paypalOrderId: s.pp, status: "PENDING" });
    await post(ev("PAYMENT.CAPTURE.PENDING", { id: s.cap, supplementary_data: { related_ids: { order_id: s.pp } } }));
    expect((await getTaskView(s.taskId, s.mum)).nextAction).toBe("paid");
  });

  it("a reversal is recorded only when PayPal confirms it, and blocks further refunds", async () => {
    const s = await captured();
    const p = mk(); gate.payments = p;
    p.verifyWebhook.mockResolvedValue(true);
    p.getCapture.mockResolvedValueOnce({ captureId: s.cap, status: "COMPLETED", amountMinor: 4399, currency: "USD" });
    expect(await (await post(ev("PAYMENT.CAPTURE.REVERSED", { id: s.cap }))).json()).toMatchObject({ state: "ignored" });
    await expect(requestRefund(op(s.cap, 100))).resolves.toBeTruthy();
    p.getCapture.mockResolvedValue({ captureId: s.cap, status: "REVERSED", amountMinor: 4399, currency: "USD" });
    await post(ev("PAYMENT.CAPTURE.REVERSED", { id: s.cap }));
    await expect(requestRefund(op(s.cap, 100))).rejects.toMatchObject({ code: "conflict" });
    expect((await getTaskView(s.taskId, s.mum)).nextAction).toBe("paid");
  });

  it("transient DB failure is not acknowledged, and a replay after restart completes", async () => {
    const s = await captured();
    const p = mk(); gate.payments = p;
    p.verifyWebhook.mockResolvedValue(true);
    p.refundCapture.mockResolvedValueOnce(ok("RT1", 600, "PENDING"));
    await operatorRefund(as(p), op(s.cap, 600));
    const e = ev("PAYMENT.REFUND.PENDING", { id: "RT1" });
    p.getRefund.mockRejectedValueOnce(new AdapterError("unavailable", "x"));
    expect((await post(e)).status).toBe(502);
    expect((await pool.query(`SELECT state, attempts FROM webhook_events WHERE provider_event_id=$1`, [e.id])).rows[0]).toEqual({ state: "failed", attempts: 1 });
    p.getRefund.mockResolvedValue(ok("RT1", 600, "COMPLETED"));
    expect((await post(e)).status).toBe(200);
    expect((await pool.query(`SELECT state, attempts FROM webhook_events WHERE provider_event_id=$1`, [e.id])).rows[0]).toEqual({ state: "processed", attempts: 2 });

    // an insert failure means no acknowledgement at all
    const spy = vi.spyOn(pool, "connect").mockRejectedValueOnce(new Error("db down"));
    expect((await post(ev("PAYMENT.REFUND.PENDING", { id: "RT2" }))).status).toBe(500);
    spy.mockRestore();
    const f = extractFacts(ev("PAYMENT.REFUND.PENDING", { id: "RT3" }, "WH-X1"));
    const first = await recordEvent("sandbox", f);
    await processEvent(as(p), first.id, f);
    expect((await recordEvent("sandbox", f)).done).toBe(true);
  });
});

describe("review follow-ups", () => {
  const hdr = { "content-type": "application/json", "paypal-transmission-id": "tid", "paypal-transmission-time": "2026-11-11T10:00:00Z", "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "paypal-auth-algo": "SHA256withRSA" };
  const post = (event: object) => webhookRoute(new Request("http://localhost/api/webhooks/paypal", { method: "POST", body: JSON.stringify(event), headers: hdr }));

  it("a full retry cannot match a partial refund made with the same key", async () => {
    const s = await captured();
    const p = mk(); p.refundCapture.mockResolvedValue(ok("RF1", 1000));
    const k = key();
    await operatorRefund(as(p), op(s.cap, 1000, k));
    await expect(operatorRefund(as(p), op(s.cap, "full", k))).rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect((await operatorRefund(as(p), op(s.cap, 1000, k))).amountMinor).toBe(1000);
  });

  it("a refund PayPal made on its own is flagged once for a person", async () => {
    const s = await captured();
    const p = mk(); gate.payments = p; p.verifyWebhook.mockResolvedValue(true);
    p.getCapture.mockResolvedValue({ captureId: s.cap, status: "PARTIALLY_REFUNDED" });
    await post({ id: `WH-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: s.cap } });
    await post({ id: `WH-${randomUUID()}`, event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: s.cap } });
    const n = await pool.query(`SELECT count(*)::int AS n FROM payment_exceptions WHERE attempt_id=$1 AND kind='external_refund'`, [s.attemptId]);
    expect(n.rows[0].n).toBe(1);
  });

  it("the operator route stays closed in production unless enabled, and never shares a connector secret", async () => {
    const s = await captured();
    const p = mk(); gate.payments = p; p.refundCapture.mockResolvedValue(ok("RO1", 500));
    const send = (body: object) => {
      const text = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign(process.env.OPERATOR_SECRET!, ts, "POST", "/api/operator/refund", text);
      return operatorRoute(new Request("http://localhost/api/operator/refund", { method: "POST", body: text, headers: { "x-dt-timestamp": ts, "x-dt-signature": sig } }));
    };
    const body = () => ({ operator: "ops", captureId: s.cap, amountMinor: 500, operationKey: key() });
    vi.stubEnv("NODE_ENV", "production");
    expect((await send(body())).status).toBe(403);
    vi.stubEnv("OPERATOR_ENABLED", "1");
    expect((await send(body())).status).toBe(200);
    vi.stubEnv("CHANNEL_SMS_SECRET", process.env.OPERATOR_SECRET!);
    expect((await send(body())).status).toBe(403);
    vi.unstubAllEnvs();
  });

  it("the webhook only trusts sandbox certificate hosts", async () => {
    const p = mk(); gate.payments = p; p.verifyWebhook.mockResolvedValue(true);
    const live = new Request("http://localhost/api/webhooks/paypal", { method: "POST", body: "{}", headers: { ...hdr, "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1" } });
    expect((await webhookRoute(live)).status).not.toBe(200);
    expect(p.verifyWebhook).not.toHaveBeenCalled();
  });
});

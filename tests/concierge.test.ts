import "./env";
process.env.PAYPAL_MERCHANT_ID = "MERCH1";
process.env.CHANNEL_SMS_SECRET = "m".repeat(40);
process.env.CHANNEL_SMS_ALLOWED = "254700000009";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AdapterError, type Payments } from "@/adapters/types";

const gate = vi.hoisted(() => ({ payments: null as unknown }));
vi.mock("@/adapters", () => ({
  getPayments: () => gate.payments, getInterpreter: () => ({}), getDiscovery: () => ({}),
  getFx: () => ({ kesRate: async () => ({ rate: 130, date: "2026-11-11", source: "test rate" }) }),
}));

import { pool } from "@/domain/db";
import { cancelOrder, decideExtra, recordFulfilment, subscribe, usdRange } from "@/domain/concierge";
import { setDestination } from "@/domain/destination";
import { beginAttempt, recordProviderOrder, settleCapture } from "@/domain/payments";
import { createSellerOrder, createTask, getComparison, recordOffers, selectOffer } from "@/domain/tasks";
import { getTaskView } from "@/domain/view";
import { tx } from "@/domain/db";

const mk = () => ({ createOrder: vi.fn(), capture: vi.fn(), getOrder: vi.fn(), refundCapture: vi.fn(), getRefund: vi.fn(), getCapture: vi.fn(), verifyWebhook: vi.fn() });
type Mock = ReturnType<typeof mk>;
let n = 0;
const key = () => `k${++n}-${Date.now()}-${randomUUID().slice(0, 6)}`;
const specs = { weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280 };

async function paidImport(opts: { subscribe?: boolean } = {}) {
  const me = await createTask({ title: "Cat carrier", starterRoles: ["requester", "chooser", "helper", "payer"], starterLabel: "Me" });
  await recordOffers(me.taskId, [{ source: "channel3", sourceOfferId: `C-${key()}`, route: "external", seller: "amazon.com", title: "Sherpa cat carrier",
    unitPriceMinor: 3000, currency: "USD", availability: "InStock", url: "https://www.amazon.com/dp/B012345678", specs }]);
  await setDestination(me.taskId, me.token, { place: "Westlands" });
  if (opts.subscribe) await tx((c) => subscribe(c, me.taskId, "sms", "hash-1", "254700000009", false));
  const cmp = await getComparison(me.taskId, me.token);
  const sel = await selectOffer(me.taskId, me.token, { offerId: cmp.offers[0].id, expectedVersion: cmp.version }, { idempotencyKey: key() });
  const order = await createSellerOrder(me.taskId, me.token, { selectionId: sel.selectionId });
  const att = await beginAttempt(me.taskId, me.token, order.id);
  const pp = key(), cap = `CAP${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await recordProviderOrder(att.id, pp);
  await settleCapture(att.id, { paypalOrderId: pp, captureId: cap, status: "COMPLETED", amountMinor: order.totalMinor, currency: "USD", payeeMerchantId: "MERCH1" });
  return { taskId: me.taskId, token: me.token, order, cap };
}
const refunded = (p: Mock) => p.refundCapture.mock.calls.map((c) => c[1].amountMinor as number | undefined);
const ok = (amountMinor?: number) => ({ refundId: `R${++n}`, status: "COMPLETED", amountMinor, currency: "USD" });
const ev = (orderId: string, status: string, extra: object = {}) => ({ orderId, status, source: "operator" as const, key: key(), ...extra });

describe("one payment for an import (option B, sandbox)", () => {
  it("freezes the delivered total at the cap with its estimate, FX and rule", async () => {
    gate.payments = mk();
    const s = await paidImport();
    expect(s.order).toMatchObject({ kind: "concierge", currency: "USD", seller: "Dad's Typing concierge (sandbox)" });
    const co = (await pool.query(`SELECT * FROM concierge_orders WHERE seller_order_id=$1`, [s.order.id])).rows[0];
    expect(co.cap_minor).toBe(s.order.totalMinor);
    expect(co.estimate_minor).toBeLessThan(co.cap_minor);
    expect(co.fx.USD.source).toBe("test rate");
    expect(co.settlement_rule).toMatch(/refund any difference/);
    expect(usdRange(co.breakdown, co.fx)!.high).toBe(co.cap_minor);
    const v = await getTaskView(s.taskId, s.token);
    expect(v.nextAction).toBe("paid");
    expect(v.fulfilment!.done.map((d) => d.status)).toEqual(["paid"]);
    expect(v.fulfilment!.arrival).toMatch(/^about/);
    expect(v.order!.concierge!.lines.length).toBeGreaterThan(3);
  });

  it("a reweigh within the cap refunds the difference with no user step", async () => {
    const p = mk(); gate.payments = p;
    const s = await paidImport();
    p.refundCapture.mockImplementation(async (_c: string, i: { amountMinor: number }) => ok(i.amountMinor));
    await recordFulfilment(p as unknown as Payments, ev(s.order.id, "ordered"));
    await recordFulfilment(p as unknown as Payments, ev(s.order.id, "at_warehouse", { actual: { grams: 1500, lengthMm: 460, widthMm: 310, heightMm: 290, source: "Kentex invoice (fixture)" } }));
    const co = (await pool.query(`SELECT cap_minor, actual_minor, settled_at FROM concierge_orders WHERE seller_order_id=$1`, [s.order.id])).rows[0];
    expect(co.actual_minor).toBeLessThan(co.cap_minor);
    expect(refunded(p)).toEqual([co.cap_minor - co.actual_minor]);
    expect(co.settled_at).not.toBeNull();
    const cal = (await pool.query(`SELECT actual_grams, est_high_grams FROM parcel_calibration WHERE task_id=$1`, [s.taskId])).rows[0];
    expect(cal.actual_grams).toBe(1500);
    const v = await getTaskView(s.taskId, s.token);
    expect(v.fulfilment!.done.map((d) => d.status)).toEqual(["paid", "ordered", "at_warehouse", "settled"]);
    await expect(recordFulfilment(p as unknown as Payments, ev(s.order.id, "departed", { actual: { totalMinor: 100, source: "again" } })))
      .rejects.toMatchObject({ code: "conflict" });
    expect(p.refundCapture).toHaveBeenCalledTimes(1);
  });

  it("above the cap is the only re-approval, and only the payer sees money", async () => {
    const p = mk(); gate.payments = p;
    const s = await paidImport();
    await recordFulfilment(p as unknown as Payments, ev(s.order.id, "at_warehouse", { actual: { totalMinor: s.order.totalMinor + 2500, source: "Kentex invoice (fixture)" } }));
    expect(p.refundCapture).not.toHaveBeenCalled();
    const v = await getTaskView(s.taskId, s.token);
    expect(v.fulfilment!.money!.extraDueMinor).toBe(2500);
    expect(v.fulfilment!.done.at(-1)!.status).toBe("needs_approval");
    await decideExtra(s.taskId, s.token, "approved");
    await expect(decideExtra(s.taskId, s.token, "declined")).rejects.toMatchObject({ code: "not_found" });
  });

  it("duplicate events and a refund timeout never double-refund", async () => {
    const p = mk(); gate.payments = p;
    const s = await paidImport();
    const e = ev(s.order.id, "at_warehouse", { actual: { totalMinor: s.order.totalMinor - 1000, source: "fixture" } });
    p.refundCapture.mockRejectedValueOnce(new AdapterError("timeout", "t"));
    await expect(recordFulfilment(p as unknown as Payments, e)).rejects.toBeInstanceOf(AdapterError);
    // the same event again is a no-op; the reserved refund is not re-created
    await recordFulfilment(p as unknown as Payments, e);
    const r = (await pool.query(`SELECT count(*)::int n, sum(amount_minor)::int s FROM refunds WHERE seller_order_id=$1`, [s.order.id])).rows[0];
    expect(r).toEqual({ n: 1, s: 1000 });
    expect(p.refundCapture).toHaveBeenCalledTimes(1);
  });

  it("cancel before the provider is paid refunds in full; after, it is refused", async () => {
    const p = mk(); gate.payments = p;
    p.refundCapture.mockImplementation(async (_c: string, i: { amountMinor?: number }) => ok(i.amountMinor));
    const a = await paidImport();
    p.getRefund.mockResolvedValue(ok(a.order.totalMinor));
    await cancelOrder(p as unknown as Payments, a.taskId, a.token);
    expect((await pool.query(`SELECT amount_minor FROM refunds WHERE seller_order_id=$1`, [a.order.id])).rows[0].amount_minor).toBe(a.order.totalMinor);
    expect((await getTaskView(a.taskId, a.token)).fulfilment!.canCancel).toBe(false);
    const b = await paidImport();
    await recordFulfilment(p as unknown as Payments, ev(b.order.id, "ordered"));
    await expect(cancelOrder(p as unknown as Payments, b.taskId, b.token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a store stock-out refunds in full and closes the order", async () => {
    const p = mk(); gate.payments = p;
    p.refundCapture.mockImplementation(async (_c: string, i: { amountMinor?: number }) => ok(i.amountMinor));
    const s = await paidImport();
    p.getRefund.mockResolvedValue(ok(s.order.totalMinor));
    await recordFulfilment(p as unknown as Payments, ev(s.order.id, "stock_out"));
    expect((await pool.query(`SELECT amount_minor FROM refunds WHERE seller_order_id=$1`, [s.order.id])).rows[0].amount_minor).toBe(s.order.totalMinor);
    await expect(recordFulfilment(p as unknown as Payments, ev(s.order.id, "departed"))).rejects.toMatchObject({ code: "conflict" });
  });

  it("pushes one short message per status change to the sender's channel", async () => {
    gate.payments = mk();
    const s = await paidImport({ subscribe: true });
    await recordFulfilment(gate.payments as Payments, ev(s.order.id, "ordered"));
    const out = (await pool.query(`SELECT recipient, body FROM channel_outbox WHERE dedupe_key LIKE 'upd:%' AND recipient='254700000009' ORDER BY created_at`)).rows;
    expect(out.slice(-2).map((r) => r.body)).toEqual([expect.stringMatching(/^Payment received for the Sherpa cat carrier\. .*it should reach you about/),
      "I've ordered the Sherpa cat carrier from the store. Next stop: Kentex's US warehouse."]);
    const sealed = (await pool.query(`SELECT recipient_enc FROM channel_subscriptions WHERE task_id=$1`, [s.taskId])).rows[0].recipient_enc;
    expect(sealed).not.toContain("254700000009");
  });

  it("ready to collect queues the pickup message and two reminders; delivery cancels them", async () => {
    gate.payments = mk();
    const s = await paidImport({ subscribe: true });
    for (const st of ["ordered", "at_warehouse", "departed", "cleared", "ready_to_collect"]) await recordFulfilment(gate.payments as Payments, ev(s.order.id, st));
    const ready = (await pool.query(`SELECT body FROM channel_outbox WHERE recipient='254700000009' AND dedupe_key LIKE 'upd:%' ORDER BY created_at DESC LIMIT 1`)).rows[0].body;
    expect(ready).toMatch(/ready to collect at Kentex Cargo, Westlands office, 65 Muthithi Road.*maps\.google\.com/);
    const rem = async () => (await pool.query(`SELECT count(*)::int n FROM channel_outbox WHERE dedupe_key LIKE $1`, [`rem:${s.order.id}:%`])).rows[0].n;
    expect(await rem()).toBe(2);
    await recordFulfilment(gate.payments as Payments, ev(s.order.id, "delivered"));
    expect(await rem()).toBe(0);
  });

  it("only the payer can cancel or approve an extra", async () => {
    gate.payments = mk();
    const s = await paidImport();
    const { createInvite } = await import("@/domain/tasks");
    const mum = await createInvite(s.taskId, s.token, { roles: ["requester", "chooser"], label: "Mum" });
    await expect(cancelOrder(gate.payments as Payments, s.taskId, mum.token)).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideExtra(s.taskId, mum.token, "approved")).rejects.toMatchObject({ code: "forbidden" });
    const v = await getTaskView(s.taskId, mum.token);
    expect(v.fulfilment!.money).toBeUndefined();
    expect(v.fulfilment!.canCancel).toBe(false);
    expect(v.order).toBeNull();
  });

  it("refuses one payment when the delivered cost is not complete", async () => {
    gate.payments = mk();
    const me = await createTask({ title: "Kettle", starterRoles: ["requester", "chooser", "payer"], starterLabel: "Me" });
    await recordOffers(me.taskId, [{ source: "channel3", sourceOfferId: `G-${key()}`, route: "external", seller: "argos.co.uk", title: "Kettle",
      unitPriceMinor: 3000, currency: "GBP", availability: "InStock", url: "https://www.argos.co.uk/x" }]);
    const cmp = await getComparison(me.taskId, me.token);
    const sel = await selectOffer(me.taskId, me.token, { offerId: cmp.offers[0].id, expectedVersion: cmp.version }, { idempotencyKey: key() });
    await expect(createSellerOrder(me.taskId, me.token, { selectionId: sel.selectionId })).rejects.toMatchObject({ code: "not_payable" });
  });
});

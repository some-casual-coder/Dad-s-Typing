import "./env";
import { beforeAll, describe, expect, it } from "vitest";
import type { Attribute } from "@/domain/eligibility";
import { pool } from "@/domain/db";
import { addMessage, createInvite, createSellerOrder, createTask, getComparison, recordOffers, revokeGrant, selectOffer, setRequirement, confirmRequirement } from "@/domain/tasks";
import { beginAttempt, listOpenAttempts, markOperation, operationFor, recordProviderOrder, settleCapture } from "@/domain/payments";
import { getTaskView } from "@/domain/view";

const offer = (id: string, opening: string | undefined, over: object = {}) => ({
  source: "demo", sourceOfferId: id, route: "paypal" as const, seller: "Demo Pet Store", merchantId: "MERCH1", sku: id, title: `Carrier ${id}`,
  attributes: (opening ? { opening: { value: opening, source: "spec sheet" } } : {}) as Record<string, Attribute>, unitPriceMinor: 3599, shippingMinor: 800, currency: "USD", availability: "InStock", ...over,
});

async function scenario() {
  const nathan = await createTask({ title: "Cat carrier for Mum", starterRoles: ["helper", "payer"], starterLabel: "Nathan" });
  const mum = await createInvite(nathan.taskId, nathan.token, { roles: ["requester", "chooser"], label: "Mum" });
  await recordOffers(nathan.taskId, [offer("TOP-1", "top"), offer("FRONT-1", "front"), offer("UNK-1", undefined)]);
  return { taskId: nathan.taskId, nathan: nathan.token, mum: mum.token, mumGrant: mum.grantId };
}
let n = 0;
const key = () => `k${++n}-${Date.now()}`;

beforeAll(async () => { await pool.query("SELECT 1"); });

describe("clarification changes eligibility, selection and payment", () => {
  it("Mum's correction removes the front-opening offer; unknown stays unresolved; exact SKU is paid", async () => {
    const s = await scenario();
    // Before any requirement nothing is excluded.
    let cmp = await getComparison(s.taskId, s.mum);
    expect(cmp.offers.every((o) => o.status === "unchecked")).toBe(true);

    await setRequirement(s.taskId, s.mum, { key: "opening", value: "top" }, { idempotencyKey: key() });
    cmp = await getComparison(s.taskId, s.mum);
    const by = Object.fromEntries(cmp.offers.map((o) => [o.sku, o.status]));
    expect(by).toEqual({ "TOP-1": "eligible", "FRONT-1": "ineligible", "UNK-1": "unresolved" });

    await expect(selectOffer(s.taskId, s.mum, { offerId: cmp.offers.find((o) => o.sku === "FRONT-1")!.id, expectedVersion: cmp.version }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "invalid" });
    await expect(selectOffer(s.taskId, s.mum, { offerId: cmp.offers.find((o) => o.sku === "UNK-1")!.id, expectedVersion: cmp.version }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "invalid" });

    const topId = cmp.offers.find((o) => o.sku === "TOP-1")!.id;
    const k = key();
    const sel = await selectOffer(s.taskId, s.mum, { offerId: topId, expectedVersion: cmp.version, reason: "Opens from the top" }, { idempotencyKey: k });
    // same key and params replay the stored result
    expect(await selectOffer(s.taskId, s.mum, { offerId: topId, expectedVersion: cmp.version, reason: "Opens from the top" }, { idempotencyKey: k })).toEqual(sel);
    await expect(selectOffer(s.taskId, s.mum, { offerId: topId, expectedVersion: cmp.version, reason: "different" }, { idempotencyKey: k })).rejects.toMatchObject({ code: "idempotency_mismatch" });

    // Nathan (payer) sees Mum's choice and reason.
    const v = await getTaskView(s.taskId, s.nathan);
    expect(v.selection?.title).toBe("Carrier TOP-1");
    expect(v.nextAction).toBe("awaiting_payer");

    // Mum cannot pay or open the order; Nathan can.
    await expect(createSellerOrder(s.taskId, s.mum, { selectionId: sel.selectionId })).rejects.toMatchObject({ code: "forbidden" });
    const order = await createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId });
    expect(order).toMatchObject({ sku: "TOP-1", itemMinor: 3599, shippingMinor: 800, totalMinor: 4399, currency: "USD" });
    expect((await createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId })).id).toBe(order.id);

    const att = await beginAttempt(s.taskId, s.nathan, order.id);
    expect((await beginAttempt(s.taskId, s.nathan, order.id)).id).toBe(att.id); // retry resolves the existing attempt
    await recordProviderOrder(att.id, "PP-ORDER-1");

    const wrongAmount = { paypalOrderId: "PP-ORDER-1", captureId: "CAP1", status: "COMPLETED", amountMinor: 3599, currency: "USD", payeeMerchantId: "MERCH1" };
    expect((await settleCapture(att.id, wrongAmount)).flagged).toBe(true);
    expect((await settleCapture(att.id, { ...wrongAmount, amountMinor: 4399, payeeMerchantId: "OTHER" })).flagged).toBe(true);
    expect((await settleCapture(att.id, { ...wrongAmount, amountMinor: 4399, currency: "GBP" })).flagged).toBe(true);
    expect((await settleCapture(att.id, { ...wrongAmount, amountMinor: 4399, paypalOrderId: "PP-OTHER" })).flagged).toBe(true);
    const flags = await pool.query(`SELECT count(*)::int AS n FROM payment_exceptions WHERE attempt_id=$1`, [att.id]);
    expect(flags.rows[0].n).toBe(2);
    await settleCapture(att.id, wrongAmount);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payment_exceptions WHERE attempt_id=$1`, [att.id])).rows[0].n).toBe(2);
    expect((await getTaskView(s.taskId, s.mum)).receipt).toBeNull();

    const good = { paypalOrderId: "PP-ORDER-1", captureId: "CAP1", status: "COMPLETED", amountMinor: 4399, currency: "USD", payeeMerchantId: "MERCH1" };
    expect((await settleCapture(att.id, good)).order).toBe("paid");
    expect((await settleCapture(att.id, good)).order).toBe("paid"); // duplicate event
    // A later older "pending" event cannot regress the state.
    expect((await settleCapture(att.id, { ...good, status: "PENDING" })).order).toBe("paid");

    for (const t of [s.mum, s.nathan]) {
      const view = await getTaskView(s.taskId, t);
      expect(view.nextAction).toBe("paid");
      expect(view.receipt).toMatchObject({ sku: "TOP-1", totalMinor: 4399, taskId: s.taskId });
    }
    expect((await getTaskView(s.taskId, s.mum)).order).toBeNull(); // payer-only detail
  });

  it("a changed requirement makes an earlier choice stale and blocks ordering", async () => {
    const s = await scenario();
    await setRequirement(s.taskId, s.mum, { key: "opening", value: "top" }, { idempotencyKey: key() });
    const cmp = await getComparison(s.taskId, s.mum);
    const topId = cmp.offers.find((o) => o.sku === "TOP-1")!.id;
    const sel = await selectOffer(s.taskId, s.mum, { offerId: topId, expectedVersion: cmp.version }, { idempotencyKey: key() });
    await setRequirement(s.taskId, s.mum, { key: "opening", op: "neq", value: "top" }, { idempotencyKey: key() });
    expect((await getTaskView(s.taskId, s.nathan)).nextAction).toBe("ready_for_choice");
    await expect(createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId })).rejects.toMatchObject({ code: "stale" });
    // A stale device cannot select against the old version.
    await expect(selectOffer(s.taskId, s.mum, { offerId: topId, expectedVersion: cmp.version }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "stale" });
  });

  it("cancelled checkout gives no receipt; retry resumes and can still complete once", async () => {
    const s = await scenario();
    await setRequirement(s.taskId, s.mum, { key: "opening", value: "top" }, { idempotencyKey: key() });
    const cmp = await getComparison(s.taskId, s.mum);
    const sel = await selectOffer(s.taskId, s.mum, { offerId: cmp.offers.find((o) => o.sku === "TOP-1")!.id, expectedVersion: cmp.version }, { idempotencyKey: key() });
    const order = await createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId });
    const a1 = await beginAttempt(s.taskId, s.nathan, order.id);
    await settleCapture(a1.id, { paypalOrderId: "PP-X", status: "CANCELLED" });
    const v = await getTaskView(s.taskId, s.mum);
    expect(v.receipt).toBeNull();
    expect(v.nextAction).toBe("awaiting_payer");
    const a2 = await beginAttempt(s.taskId, s.nathan, order.id);
    expect(a2.id).not.toBe(a1.id);
    expect(a2.createRequestId).not.toBe(a1.createRequestId);
  });
});

async function frozenOrder() {
  const s = await scenario();
  await setRequirement(s.taskId, s.mum, { key: "opening", value: "top" }, { idempotencyKey: key() });
  const cmp = await getComparison(s.taskId, s.mum);
  const offerId = cmp.offers.find((o) => o.sku === "TOP-1")!.id;
  const sel = await selectOffer(s.taskId, s.mum, { offerId, expectedVersion: cmp.version }, { idempotencyKey: key() });
  return { ...s, offerId, sel, order: await createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId }) };
}
const completed = { paypalOrderId: "PP-T", captureId: "CAP-T", status: "COMPLETED", amountMinor: 4399, currency: "USD", payeeMerchantId: "MERCH1" };

describe("payment failure paths", () => {
  it("a changed quote needs a fresh review before an order is frozen", async () => {
    const s = await scenario();
    await setRequirement(s.taskId, s.mum, { key: "opening", value: "top" }, { idempotencyKey: key() });
    const cmp = await getComparison(s.taskId, s.mum);
    const offerId = cmp.offers.find((o) => o.sku === "TOP-1")!.id;
    const sel = await selectOffer(s.taskId, s.mum, { offerId, expectedVersion: cmp.version }, { idempotencyKey: key() });
    await recordOffers(s.taskId, [offer("TOP-1", "top", { unitPriceMinor: 3999 })]);
    await expect(createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId })).rejects.toMatchObject({ code: "stale" });
    await recordOffers(s.taskId, [offer("TOP-1", "top", { availability: "OutOfStock" })]);
    await expect(createSellerOrder(s.taskId, s.nathan, { selectionId: sel.selectionId })).rejects.toMatchObject({ code: "stale" });
  });

  it("an approved order keeps its frozen details when the catalogue changes", async () => {
    const f = await frozenOrder();
    await recordOffers(f.taskId, [offer("TOP-1", "top", { unitPriceMinor: 9999 })]);
    expect(await createSellerOrder(f.taskId, f.nathan, { selectionId: f.sel.selectionId })).toMatchObject({ id: f.order.id, totalMinor: 4399 });
  });

  it("concurrent starts create one attempt", async () => {
    const f = await frozenOrder();
    const r = await Promise.all([1, 2, 3, 4].map(() => beginAttempt(f.taskId, f.nathan, f.order.id)));
    expect(new Set(r.map((a) => a.id)).size).toBe(1);
  });

  it("each operation kind has its own request id, reused on retry", async () => {
    const f = await frozenOrder();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    const c1 = await operationFor(att.id, "capture");
    expect((await operationFor(att.id, "capture")).requestId).toBe(c1.requestId);
    expect(c1.requestId).not.toBe(att.createRequestId);
  });

  it("timeout after capture: no second attempt, reconcile later to paid after restart", async () => {
    const f = await frozenOrder();
    const pp = key();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    await recordProviderOrder(att.id, pp);
    const op = await operationFor(att.id, "capture");
    await markOperation(op.requestId, "unknown"); // response lost
    expect((await beginAttempt(f.taskId, f.nathan, f.order.id)).id).toBe(att.id);
    expect((await getTaskView(f.taskId, f.mum)).nextAction).toBe("checking_payment");
    expect((await getTaskView(f.taskId, f.mum)).receipt).toBeNull();

    // a restart keeps no memory; the open attempt comes back from the DB
    const open = (await listOpenAttempts()).find((a) => a.id === att.id)!;
    expect(open.paypalOrderId).toBe(pp);
    expect((await settleCapture(open.id, { ...completed, paypalOrderId: pp, captureId: `CAP-${pp}` })).order).toBe("paid");
    expect(await listOpenAttempts().then((l) => l.some((a) => a.id === att.id))).toBe(false);
    expect((await getTaskView(f.taskId, f.mum)).receipt).toMatchObject({ totalMinor: 4399 });
  });

  it("a stale pending event cannot undo a cancelled attempt", async () => {
    const f = await frozenOrder();
    const pp = key();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    await settleCapture(att.id, { paypalOrderId: pp, status: "CANCELLED" });
    const r = await settleCapture(att.id, { paypalOrderId: pp, status: "PENDING" });
    expect(r.order).toBe("awaiting_payer");
    expect(r.attempt.status).toBe("cancelled");
  });

  it("an order still waiting for buyer approval stays open", async () => {
    const f = await frozenOrder();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    const pp = key();
    await recordProviderOrder(att.id, pp);
    for (const status of ["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"]) {
      const r = await settleCapture(att.id, { paypalOrderId: pp, status });
      expect(r.attempt.status).toBe("created");
      expect(r.order).toBe("pending");
    }
    expect((await settleCapture(att.id, { paypalOrderId: pp, status: "DECLINED" })).order).toBe("awaiting_payer");
  });

  it("payer role is required to start or settle checkout", async () => {
    const f = await frozenOrder();
    await expect(beginAttempt(f.taskId, f.mum, f.order.id)).rejects.toMatchObject({ code: "forbidden" });
    const other = await createTask({ title: "x", starterRoles: ["payer"] });
    await expect(beginAttempt(f.taskId, other.token, f.order.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("access", () => {
  it("helper proposals do not affect eligibility until the requester confirms", async () => {
    const s = await scenario();
    const p = await setRequirement(s.taskId, s.nathan, { key: "opening", value: "top" }, { idempotencyKey: key() });
    expect(p.status).toBe("proposed");
    expect((await getComparison(s.taskId, s.mum)).offers.every((o) => o.status === "unchecked")).toBe(true);
    await expect(confirmRequirement(s.taskId, s.nathan, p.requirementId)).rejects.toMatchObject({ code: "forbidden" });
    await confirmRequirement(s.taskId, s.mum, p.requirementId);
    expect((await getComparison(s.taskId, s.mum)).offers.filter((o) => o.status === "ineligible")).toHaveLength(1);
  });

  it("unrelated, revoked and expired tokens cannot read or mutate", async () => {
    const s = await scenario();
    const other = await createTask({ title: "Someone else" });
    await expect(getTaskView(s.taskId, other.token)).rejects.toMatchObject({ code: "not_found" });
    await expect(getTaskView(s.taskId, "garbage")).rejects.toMatchObject({ code: "not_found" });
    const helper = await createInvite(s.taskId, s.mum, { roles: ["helper"] });
    expect((await getTaskView(s.taskId, helper.token)).viewer.roles).toEqual(["helper"]);
    await revokeGrant(s.taskId, s.mum, helper.grantId);
    await expect(getTaskView(s.taskId, helper.token)).rejects.toMatchObject({ code: "not_found" });
    const short = await createInvite(s.taskId, s.mum, { roles: ["helper"], ttlMinutes: 0 });
    await expect(getTaskView(s.taskId, short.token)).rejects.toMatchObject({ code: "not_found" });
    // Helpers cannot designate a payer.
    const h2 = await createInvite(s.taskId, s.mum, { roles: ["helper"] });
    await expect(createInvite(s.taskId, h2.token, { roles: ["payer"] })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("duplicate provider messages have exactly one effect", async () => {
    const s = await scenario();
    const m = { channel: "browser", providerMessageId: `m-${Date.now()}`, body: "hi" };
    const results = await Promise.all([addMessage(s.taskId, s.mum, m), addMessage(s.taskId, s.mum, m), addMessage(s.taskId, s.mum, m)]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
  });

  it("payable offers must carry merchant, sku and confirmed shipping", async () => {
    const s = await scenario();
    await expect(recordOffers(s.taskId, [offer("BAD", "top", { shippingMinor: null })])).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("invite scope", () => {
  it("the creator, a requester and a helper can each mint only what they may", async () => {
    const nathan = await createTask({ title: "x", starterRoles: ["helper", "payer"] });
    const mum = await createInvite(nathan.taskId, nathan.token, { roles: ["requester", "chooser"] });
    const helper = await createInvite(nathan.taskId, nathan.token, { roles: ["helper"] });
    for (const roles of [["requester"], ["chooser"], ["payer"]] as const) {
      await expect(createInvite(nathan.taskId, helper.token, { roles: [...roles] })).rejects.toMatchObject({ code: "forbidden" });
    }
    await createInvite(nathan.taskId, helper.token, { roles: ["helper"] });
    await createInvite(nathan.taskId, mum.token, { roles: ["payer"] });
    const payer = await createInvite(nathan.taskId, mum.token, { roles: ["payer"] });
    await expect(createInvite(nathan.taskId, payer.token, { roles: ["helper"] })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("recovery and stale orders", () => {
  it("a new attempt is refused for an order whose choice was replaced", async () => {
    const f = await frozenOrder();
    await recordOffers(f.taskId, [offer("TOP-2", "top")]);
    const cmp = await getComparison(f.taskId, f.mum);
    await selectOffer(f.taskId, f.mum, { offerId: cmp.offers.find((o) => o.sku === "TOP-2")!.id, expectedVersion: cmp.version }, { idempotencyKey: key() });
    await expect(beginAttempt(f.taskId, f.nathan, f.order.id)).rejects.toMatchObject({ code: "stale" });
    const n = await pool.query(`SELECT count(*)::int AS n FROM payment_attempts WHERE seller_order_id=$1`, [f.order.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it("a cancelled attempt whose capture may have landed is still reconciled", async () => {
    const f = await frozenOrder();
    const pp = key();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    await recordProviderOrder(att.id, pp);
    const op = await operationFor(att.id, "capture");
    await markOperation(op.requestId, "unknown");
    await settleCapture(att.id, { paypalOrderId: pp, status: "CANCELLED" });
    expect((await listOpenAttempts()).some((a) => a.id === att.id)).toBe(true);
    const r = await settleCapture(att.id, { ...completed, paypalOrderId: pp, captureId: `CAP-${pp}` });
    expect(r.order).toBe("paid");
    expect((await listOpenAttempts()).some((a) => a.id === att.id)).toBe(false);
  });
});

describe("a changed choice and payments", () => {
  async function twoOffers() {
    const f = await frozenOrder();
    await recordOffers(f.taskId, [offer("TOP-2", "top")]);
    const cmp = await getComparison(f.taskId, f.mum);
    return { ...f, other: cmp.offers.find((o) => o.sku === "TOP-2")!.id, version: cmp.version };
  }

  it("choosing again cancels an unpaid order and its open attempt", async () => {
    const f = await twoOffers();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    await selectOffer(f.taskId, f.mum, { offerId: f.other, expectedVersion: f.version }, { idempotencyKey: key() });
    const row = (await pool.query(`SELECT a.status AS a, o.status AS o FROM payment_attempts a JOIN seller_orders o ON o.id=a.seller_order_id WHERE a.id=$1`, [att.id])).rows[0];
    expect(row).toEqual({ a: "cancelled", o: "cancelled" });
  });

  it("choosing again is refused while a capture is in flight or after payment", async () => {
    const f = await twoOffers();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    await operationFor(att.id, "capture");
    await expect(selectOffer(f.taskId, f.mum, { offerId: f.other, expectedVersion: f.version }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "conflict" });
    const pp = key();
    await recordProviderOrder(att.id, pp);
    await settleCapture(att.id, { ...completed, paypalOrderId: pp, captureId: `CAP-${pp}` });
    await expect(selectOffer(f.taskId, f.mum, { offerId: f.other, expectedVersion: f.version }, { idempotencyKey: key() })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a late capture for a replaced choice is recorded and the task still shows paid", async () => {
    const f = await twoOffers();
    const pp = key();
    const att = await beginAttempt(f.taskId, f.nathan, f.order.id);
    await recordProviderOrder(att.id, pp);
    await selectOffer(f.taskId, f.mum, { offerId: f.other, expectedVersion: f.version }, { idempotencyKey: key() });
    const r = await settleCapture(att.id, { ...completed, paypalOrderId: pp, captureId: `CAP-${pp}` });
    expect(r.order).toBe("paid");
    expect((await pool.query(`SELECT kind FROM payment_exceptions WHERE attempt_id=$1`, [att.id])).rows.map((x) => x.kind)).toContain("superseded_selection");
    const v = await getTaskView(f.taskId, f.mum);
    expect(v.nextAction).toBe("paid");
    expect(v.receipt).toMatchObject({ sku: "TOP-1", totalMinor: 4399 });
  });

  it("a new attempt is refused once a requirement change made the order stale", async () => {
    const f = await frozenOrder();
    await setRequirement(f.taskId, f.mum, { key: "opening", op: "neq", value: "top" }, { idempotencyKey: key() });
    await expect(beginAttempt(f.taskId, f.nathan, f.order.id)).rejects.toMatchObject({ code: "stale" });
  });
});

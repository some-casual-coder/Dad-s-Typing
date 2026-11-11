import "./env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "@/adapters/types";
import { pool } from "@/domain/db";
import { listOpenAttempts } from "@/domain/payments";
import { reconcileOpenAttempts } from "@/payments/reconcile";

const interpret = vi.fn();
const payments = { createOrder: vi.fn(), capture: vi.fn(), getOrder: vi.fn() };

vi.mock("@/adapters", async () => ({
  getInterpreter: () => ({ interpret }),
  getPayments: () => payments,
  getDiscovery: () => ({ search: async () => [] }),
}));
vi.mock("@/catalog/demo", async () => ({
  seedDemoOffers: async (taskId: string) => {
    const { recordOffers } = await import("@/domain/tasks");
    await recordOffers(taskId, [{ source: "demo", sourceOfferId: "TOP-1", route: "paypal", seller: "Demo Store", merchantId: "M1", sku: "TOP-1", title: "Carrier", unitPriceMinor: 3599, shippingMinor: 800, currency: "USD", availability: "InStock" }]);
  },
  seedExternalOffers: async () => { throw new Error("channel3 down"); },
}));

import { POST as createTask } from "@/app/api/tasks/route";
import { GET as getTask } from "@/app/api/tasks/[id]/route";
import { GET as getComparison } from "@/app/api/tasks/[id]/comparison/route";
import { GET as listMsgs, POST as postMsg } from "@/app/api/tasks/[id]/messages/route";
import { POST as postReq } from "@/app/api/tasks/[id]/requirements/route";
import { POST as invite } from "@/app/api/tasks/[id]/invites/route";
import { DELETE as revoke } from "@/app/api/tasks/[id]/grants/[gid]/route";
import { POST as select } from "@/app/api/tasks/[id]/selection/route";
import { POST as order } from "@/app/api/tasks/[id]/order/route";
import { POST as payCreate } from "@/app/api/tasks/[id]/pay/create/route";
import { POST as payCapture } from "@/app/api/tasks/[id]/pay/capture/route";

type Call = (req: Request, ctx?: never) => Promise<Response>;
async function call(h: unknown, method: string, path: string, token: string | null, body?: unknown, params: Record<string, string> = {}) {
  const req = new Request(`http://localhost${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
  });
  const res = await (h as Call)(req, { params: Promise.resolve(params) } as never);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function setup() {
  const t = await call(createTask, "POST", "/api/tasks", null, { title: "Cat carrier", starterRoles: ["requester", "chooser"], label: "Mum" });
  const id = t.json.taskId as string;
  const p = { id };
  const inv = await call(invite, "POST", "", t.json.token, { roles: ["payer"], label: "Nathan" }, p);
  return { id, p, mum: t.json.token as string, nathan: inv.json.token as string, nathanGrant: inv.json.grantId as string };
}

async function toOrder() {
  const s = await setup();
  const cmp = await call(getComparison, "GET", "", s.mum, undefined, s.p);
  const sel = await call(select, "POST", "", s.mum, { offerId: cmp.json.offers[0].id, expectedVersion: cmp.json.version }, s.p);
  const ord = await call(order, "POST", "", s.nathan, { selectionId: sel.json.selectionId }, s.p);
  return { ...s, orderId: ord.json.id as string, ord };
}

const completed = (id: string, over: object = {}) => ({ paypalOrderId: id, captureId: `CAP-${id}`, status: "COMPLETED", amountMinor: 4399, currency: "USD", payeeMerchantId: "M1", ...over });

beforeEach(() => {
  interpret.mockReset();
  payments.createOrder.mockReset().mockImplementation(async (i: { requestId: string }) => ({ paypalOrderId: `PP-${i.requestId}`, approveUrl: "https://paypal.test/approve" }));
  payments.capture.mockReset();
  payments.getOrder.mockReset();
});

describe("auth", () => {
  it("creates a task even if external seeding fails", async () => {
    const s = await setup();
    const cmp = await call(getComparison, "GET", "", s.mum, undefined, s.p);
    expect(cmp.json.offers).toHaveLength(1);
  });

  it("missing token is 401 and reveals nothing; other task's token and revoked grants are 404", async () => {
    const a = await setup();
    const b = await setup();
    const none = await call(getTask, "GET", "", null, undefined, a.p);
    expect(none.status).toBe(401);
    expect(none.json).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect((await call(getTask, "GET", "", b.mum, undefined, a.p)).status).toBe(404);
    expect((await call(getTask, "GET", "", a.nathan, undefined, a.p)).status).toBe(200);
    expect((await call(revoke, "DELETE", "", a.mum, undefined, { ...a.p, gid: a.nathanGrant })).status).toBe(204);
    expect((await call(getTask, "GET", "", a.nathan, undefined, a.p)).status).toBe(404);
  });

  it("rejects unknown roles and malformed ids", async () => {
    expect((await call(createTask, "POST", "/api/tasks", null, { title: "x", starterRoles: ["admin"] })).status).toBe(422);
    expect((await call(getTask, "GET", "", "tokentokentokentoken", undefined, { id: "nope" })).status).toBe(404);
  });
});

describe("messages", () => {
  const body = (over: object = {}) => ({ clientMessageId: "c1", text: "needs a top opening", ...over });

  it("duplicate delivery calls the model once and replays the stored result", async () => {
    const s = await setup();
    interpret.mockResolvedValue({ observations: [], proposedRequirements: [{ key: "opening", op: "eq", value: "top", essential: true, quote: "top opening" }], clarification: null, reply: "Top opening, right?" });
    const first = await call(postMsg, "POST", "", s.mum, body(), s.p);
    const again = await call(postMsg, "POST", "", s.mum, body(), s.p);
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(first.json.proposals).toHaveLength(1);
    expect(first.json.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    // proposals are not auto-confirmed
    const v = await call(getTask, "GET", "", s.mum, undefined, s.p);
    expect(v.json.requirements).toHaveLength(0);
  });

  it("model failure gives a recoverable reply; image bytes are not stored", async () => {
    const s = await setup();
    interpret.mockRejectedValue(new AdapterError("timeout", "slow"));
    const r = await call(postMsg, "POST", "", s.mum, body({ imageBase64: Buffer.from("fake").toString("base64"), mime: "image/png" }), s.p);
    expect(r.status).toBe(200);
    expect(r.json.messages[1].body).toMatch(/could not read/);
    const list = await call(listMsgs, "GET", "", s.mum, undefined, s.p);
    expect(list.json.messages[0]).toMatchObject({ role: "user", author: "Mum", hasImage: true });
    const { rows } = await pool.query(`SELECT media_ref FROM messages WHERE task_id=$1 AND channel='browser'`, [s.id]);
    expect(rows[0].media_ref).toBe("inline:attached");
  });

  it("validates size, mime and hides messages from other tasks", async () => {
    const a = await setup();
    const b = await setup();
    interpret.mockResolvedValue({ observations: [], proposedRequirements: [], clarification: null, reply: "ok" });
    expect((await call(postMsg, "POST", "", a.mum, body({ text: "x".repeat(2001) }), a.p)).status).toBe(422);
    expect((await call(postMsg, "POST", "", a.mum, body({ imageBase64: "AAAA", mime: "image/gif" }), a.p)).status).toBe(422);
    expect((await call(postMsg, "POST", "", a.mum, body({ imageBase64: "A".repeat(5_600_000), mime: "image/png" }), a.p)).status).toBe(422);
    await call(postMsg, "POST", "", a.mum, body({ clientMessageId: "secret" }), a.p);
    expect((await call(listMsgs, "GET", "", b.mum, undefined, a.p)).status).toBe(404);
    expect((await call(listMsgs, "GET", "", b.mum, undefined, b.p)).json.messages).toHaveLength(0);
  });
});

describe("selection and order", () => {
  it("stale selection is 409; only the payer sees or creates the order", async () => {
    const s = await setup();
    const cmp = await call(getComparison, "GET", "", s.mum, undefined, s.p);
    await call(postReq, "POST", "", s.mum, { key: "colour", value: "grey" }, s.p);
    const stale = await call(select, "POST", "", s.mum, { offerId: cmp.json.offers[0].id, expectedVersion: cmp.json.version }, s.p);
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("stale");

    const o = await toOrder();
    expect((await call(order, "POST", "", o.mum, { selectionId: crypto.randomUUID() }, o.p)).status).toBe(403);
    expect((await call(getTask, "GET", "", o.mum, undefined, o.p)).json.order).toBeNull();
    expect((await call(getTask, "GET", "", o.nathan, undefined, o.p)).json.order).toMatchObject({ totalMinor: 4399 });
    expect((await call(payCreate, "POST", "", o.mum, { orderId: o.orderId }, o.p)).status).toBe(403);
  });
});

describe("payment", () => {
  it("create uses the frozen order; capture settles only a matching COMPLETED capture", async () => {
    const o = await toOrder();
    const c = await call(payCreate, "POST", "", o.nathan, { orderId: o.orderId, totalMinor: 1 }, o.p);
    expect(c.status).toBe(200);
    expect(payments.createOrder).toHaveBeenCalledWith(expect.objectContaining({ totalMinor: 4399, itemMinor: 3599, shippingMinor: 800, currency: "USD", returnUrl: `${process.env.APP_BASE_URL ?? ""}/t/${o.id}/pay/return` }));
    payments.capture.mockResolvedValue(completed(c.json.paypalOrderId));
    expect((await call(payCapture, "POST", "", o.mum, { attemptId: c.json.attemptId }, o.p)).status).toBe(403);
    const cap = await call(payCapture, "POST", "", o.nathan, { attemptId: c.json.attemptId }, o.p);
    expect(cap.status).toBe(200);
    expect(cap.json).toMatchObject({ flagged: false, attempt: { status: "captured" }, receipt: { totalMinor: 4399 } });
    expect((await call(getTask, "GET", "", o.mum, undefined, o.p)).json.nextAction).toBe("paid");
  });

  it("capture and cancel resolve the attempt from the PayPal order id", async () => {
    const o = await toOrder();
    const c = await call(payCreate, "POST", "", o.nathan, { orderId: o.orderId }, o.p);
    expect((await call(payCapture, "POST", "", o.nathan, { paypalOrderId: "NOPE-12345" }, o.p)).status).toBe(404);
    expect((await call(payCapture, "POST", "", o.mum, { paypalOrderId: c.json.paypalOrderId }, o.p)).status).toBe(403);
    payments.capture.mockResolvedValue(completed(c.json.paypalOrderId));
    const cap = await call(payCapture, "POST", "", o.nathan, { paypalOrderId: c.json.paypalOrderId }, o.p);
    expect(cap.json).toMatchObject({ attempt: { status: "captured" }, receipt: { totalMinor: 4399 } });
    expect((await call(payCapture, "POST", "", o.nathan, {}, o.p)).status).toBe(422);
  });

  it("a mismatched capture is flagged and not paid", async () => {
    const o = await toOrder();
    const c = await call(payCreate, "POST", "", o.nathan, { orderId: o.orderId }, o.p);
    payments.capture.mockResolvedValue(completed(c.json.paypalOrderId, { amountMinor: 100 }));
    const cap = await call(payCapture, "POST", "", o.nathan, { attemptId: c.json.attemptId }, o.p);
    expect(cap.json.flagged).toBe(true);
    expect((await call(getTask, "GET", "", o.nathan, undefined, o.p)).json.nextAction).toBe("checking_payment");
  });

  it("capture timeout is 202, keeps the attempt, and a restart reconciles it", async () => {
    const o = await toOrder();
    const c = await call(payCreate, "POST", "", o.nathan, { orderId: o.orderId }, o.p);
    payments.capture.mockRejectedValue(new AdapterError("timeout", "t"));
    payments.getOrder.mockResolvedValue({ paypalOrderId: c.json.paypalOrderId, status: "APPROVED" });
    const cap = await call(payCapture, "POST", "", o.nathan, { attemptId: c.json.attemptId }, o.p);
    expect(cap.status).toBe(202);
    expect(cap.json).toEqual({ status: "checking_payment" });
    const again = await call(payCreate, "POST", "", o.nathan, { orderId: o.orderId }, o.p);
    expect(again.json.attemptId).toBe(c.json.attemptId);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM payment_attempts WHERE seller_order_id=$1`, [o.orderId]);
    expect(rows[0].n).toBe(1);

    payments.getOrder.mockResolvedValue(completed(c.json.paypalOrderId));
    const r = await reconcileOpenAttempts(payments);
    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect((await listOpenAttempts()).some((x) => x.id === c.json.attemptId)).toBe(false);
    expect((await call(getTask, "GET", "", o.mum, undefined, o.p)).json.nextAction).toBe("paid");
  });

  it("provider outages are generic 502s", async () => {
    const o = await toOrder();
    payments.createOrder.mockRejectedValue(new AdapterError("unavailable", "secret detail"));
    const r = await call(payCreate, "POST", "", o.nathan, { orderId: o.orderId }, o.p);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toMatch(/secret/);
  });
});


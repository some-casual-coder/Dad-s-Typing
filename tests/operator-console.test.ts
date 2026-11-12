import "./env";
process.env.OPERATOR_SECRET = "o".repeat(40);
process.env.PAYPAL_MERCHANT_ID = "MERCH1";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/adapters", () => ({
  getPayments: () => ({}), getInterpreter: () => ({}), getDiscovery: () => ({}),
  getFx: () => ({ kesRate: async () => ({ rate: 130, date: "2026-11-11", source: "test rate" }) }),
}));
// Called outside a Next request here
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), connection: async () => {} }));

import { POST as session } from "@/app/api/operator/session/route";
import { GET as orders } from "@/app/api/operator/orders/route";
import { POST as events } from "@/app/api/operator/orders/[oid]/events/route";
import { login, requireOperator } from "@/domain/operatorSession";
import { beginAttempt, recordProviderOrder, settleCapture } from "@/domain/payments";
import { createSellerOrder, createTask, getComparison, recordOffers, selectOffer } from "@/domain/tasks";
import { getTaskView } from "@/domain/view";

type H = (req: Request, ctx?: never) => Promise<Response>;
const req = (url: string, init: RequestInit & { cookie?: string; op?: boolean } = {}) => new Request(`http://localhost${url}`, {
  ...init, headers: { "content-type": "application/json", "x-forwarded-for": `10.7.0.${Math.floor(Math.random() * 250)}`,
    ...(init.op === false ? {} : { "x-dt-operator": "1" }), ...(init.cookie ? { cookie: init.cookie } : {}) } });

async function paidOrder() {
  const me = await createTask({ title: "Cat carrier", starterRoles: ["requester", "chooser", "payer"], starterLabel: "Me" });
  await recordOffers(me.taskId, [{ source: "channel3", sourceOfferId: `OP-${randomUUID()}`, route: "external", seller: "amazon.com", title: "Sherpa cat carrier",
    unitPriceMinor: 3000, currency: "USD", availability: "InStock", url: "https://www.amazon.com/dp/B012345678", specs: { weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280 } }]);
  const cmp = await getComparison(me.taskId, me.token);
  const sel = await selectOffer(me.taskId, me.token, { offerId: cmp.offers[0].id, expectedVersion: cmp.version }, { idempotencyKey: randomUUID() });
  const order = await createSellerOrder(me.taskId, me.token, { selectionId: sel.selectionId });
  const att = await beginAttempt(me.taskId, me.token, order.id);
  const pp = `PP-${randomUUID()}`;
  await recordProviderOrder(att.id, pp);
  await settleCapture(att.id, { paypalOrderId: pp, captureId: `CAP${randomUUID().slice(0, 8)}`, status: "COMPLETED", amountMinor: order.totalMinor, currency: "USD", payeeMerchantId: "MERCH1" });
  return { ...me, order };
}

describe("operator console", () => {
  it("unlocks only with the secret, then needs the cookie and the header", async () => {
    expect((await (session as H)(req("/api/operator/session", { method: "POST", body: JSON.stringify({ secret: "wrong" }) }))).status).toBe(403);
    const ok = await (session as H)(req("/api/operator/session", { method: "POST", body: JSON.stringify({ secret: "o".repeat(40) }) }));
    const set = ok.headers.get("set-cookie")!;
    expect(set).toMatch(/^dt_op=\d+\.[\w-]+; HttpOnly; SameSite=Strict; Path=\/api\/operator; Max-Age=28800/);
    const cookie = set.split(";")[0];
    expect((await (orders as H)(req("/api/operator/orders"))).status).toBe(403);
    expect((await (orders as H)(req("/api/operator/orders", { cookie, op: false }))).status).toBe(403);
    expect((await (orders as H)(req("/api/operator/orders", { cookie }))).status).toBe(200);
    const old = login("o".repeat(40), Date.now() - 9 * 3600_000).value;
    expect(() => requireOperator(req("/x", { cookie: `dt_op=${old}` }))).toThrow();
    expect(() => requireOperator(req("/x", { cookie: `dt_op=${old.replace(/\.\S+$/, ".forged")}` }))).toThrow();
  });

  it("lists paid imports and records a status the payer then sees", async () => {
    const s = await paidOrder();
    const cookie = `dt_op=${login("o".repeat(40)).value}`;
    const list = await (await (orders as H)(req("/api/operator/orders", { cookie }))).json();
    expect(list.orders.find((o: { id: string }) => o.id === s.order.id)).toMatchObject({ title: "Sherpa cat carrier", provider: "kentex", lastStatus: "paid" });
    const call = (body: object) => (events as H)(req(`/api/operator/orders/${s.order.id}/events`, { method: "POST", cookie, body: JSON.stringify(body) }),
      { params: Promise.resolve({ oid: s.order.id }) } as never);
    expect((await call({ status: "ordered", operationKey: "console:test-1" })).status).toBe(200);
    expect((await call({ status: "ordered", operationKey: "console:test-1" })).status).toBe(200);
    expect((await call({ status: "at_warehouse", actual: { totalMinor: 100 } })).status).toBe(422);
    const v = await getTaskView(s.taskId, s.token);
    expect(v.fulfilment!.done.map((d) => d.status)).toEqual(["paid", "ordered"]);
    expect(v.fulfilment!.done[1].source).toBe("Confirmed by our operator");
  });
});

describe("R12 public-like configuration", () => {
  it("operator tools stay locked in production unless explicitly enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => login("o".repeat(40))).toThrow();
      vi.stubEnv("OPERATOR_ENABLED", "1");
      expect(login("o".repeat(40)).value).toMatch(/^\d+\./);
    } finally { vi.unstubAllEnvs(); }
  });
});

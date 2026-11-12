import "./env";
process.env.TRUST_PROXY = "1";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/catalog/demo", async () => ({
  seedDemoOffers: async (taskId: string) => {
    const { recordOffers } = await import("@/domain/tasks");
    await recordOffers(taskId, [
      { source: "demo", sourceOfferId: "TOP-1", route: "paypal", seller: "Demo Store", merchantId: "M1", sku: "TOP-1", title: "Carrier", unitPriceMinor: 3599, shippingMinor: 800, currency: "USD", availability: "InStock" },
      { source: "channel3", sourceOfferId: "EXT-1", route: "external", seller: "amazon.com", title: "Carrier", unitPriceMinor: 3000, currency: "USD", availability: "InStock", url: "https://www.amazon.com/dp/B012345678" },
    ]);
  },
  seedExternalOffers: async () => {},
}));

import { POST as createTask } from "@/app/api/tasks/route";
import { GET as getComparison } from "@/app/api/tasks/[id]/comparison/route";
import { POST as invite } from "@/app/api/tasks/[id]/invites/route";
import { GET as getDelivery, PUT as putDelivery } from "@/app/api/tasks/[id]/delivery/route";
import { POST as postQuote } from "@/app/api/tasks/[id]/delivery/quotes/route";
import { POST as postStep } from "@/app/api/tasks/[id]/delivery/steps/route";
import { PUT as putDest } from "@/app/api/tasks/[id]/destination/route";

type Call = (req: Request, ctx: never) => Promise<Response>;
let ip = 0;
async function call(h: unknown, method: string, token: string | null, id: string, body?: unknown) {
  const req = new Request("http://localhost/x", {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(ip / 250)}.${ip++ % 250}` },
  });
  const res = await (h as Call)(req, { params: Promise.resolve({ id }) } as never);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function setup() {
  const t = await call(createTask, "POST", null, "", { title: "Cat carrier", starterRoles: ["requester", "chooser"], label: "Mum" });
  const id = t.json.taskId as string;
  const inv = await call(invite, "POST", t.json.token, id, { roles: ["payer"], label: "Nathan" });
  const cmp = await call(getComparison, "GET", t.json.token, id);
  const ext = cmp.json.offers.find((o: { route: string }) => o.route === "external").id as string;
  return { id, mum: t.json.token as string, payer: inv.json.token as string, ext, local: cmp.json.offers.find((o: { route: string }) => o.route === "paypal").id as string };
}

const q = (ext: string, over: object = {}) => ({ offerId: ext, provider: "kentex", mode: "amazon_buy_ship", reference: "KQ-1", amountMinor: 9000, currency: "USD",
  includesItem: true, includesCustoms: true, includesDelivery: true, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over });

describe("delivery api", () => {
  it("saves inputs, imports a quote and compares", async () => {
    const s = await setup();
    const put = await call(putDelivery, "PUT", s.mum, s.id, { county: "Nairobi", city: "Westlands", handling: "pickup", weightGrams: 2000, lengthMm: 300, widthMm: 200, heightMm: 150 });
    expect(put.status).toBe(200);
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.ext))).status).toBe(200);
    const d = await call(getDelivery, "GET", s.mum, s.id);
    expect(d.json.input).toMatchObject({ county: "Nairobi", handling: "pickup", weightGrams: 2000 });
    const k = d.json.plans.find((p: { mode: string; offerId: string }) => p.mode === "amazon_buy_ship" && p.offerId === s.ext);
    expect(k.complete).toBe(true);
    expect(k.knownMinor).toBe(9000);
    expect(d.json.plans.find((p: { route: string }) => p.route === "local").complete).toBe(true);
    // No requirement was confirmed, yet identity evidence makes both closest matches
    const local = d.json.plans.find((p: { route: string }) => p.route === "local");
    expect(local.exact).toBe(true);
    expect(local.match.matched).toContain("carrier");
    expect(d.json.cheapestId).toBe(local.id);
    // FX carries its source and date; offline in tests, so it says so
    expect(d.json.fx.USD).toMatchObject({ stale: true, rateDate: expect.any(String), source: expect.any(String) });
    expect(d.json.fxSource).toContain("may be out of date");
  });

  it("asks the browser one destination question, then never again", async () => {
    const s = await setup();
    const first = (await call(getDelivery, "GET", s.mum, s.id)).json;
    expect(first.askDestination).toBe(true);
    expect((await call(putDest, "PUT", s.payer, s.id, { confirm: true })).status).toBe(403);
    expect((await call(putDest, "PUT", s.mum, s.id, {})).status).toBe(422);
    expect((await call(putDest, "PUT", s.mum, s.id, { place: "kilimani" })).json).toEqual({ county: "Nairobi", area: "Kilimani" });
    const after = (await call(getDelivery, "GET", s.mum, s.id)).json;
    expect(after.askDestination).toBe(false);
    expect(after.destination).toMatchObject({ county: "Nairobi", area: "Kilimani", confirmed: true });
  });

  it("fails closed for the wrong or missing access", async () => {
    const s = await setup();
    expect((await call(getDelivery, "GET", null, s.id)).status).toBeGreaterThanOrEqual(400);
    expect((await call(getDelivery, "GET", "not-a-token-not-a-token-not-a-token-xx", s.id)).status).toBe(404);
    expect((await call(putDelivery, "PUT", s.payer, s.id, { county: "a", city: "b", handling: "door" })).status).toBe(403);
    expect((await call(postQuote, "POST", s.payer, s.id, q(s.ext))).status).toBe(403);
    expect((await call(postStep, "POST", s.payer, s.id, { offerId: s.ext, provider: "kentex", mode: "forwarding", step: "purchased" })).status).toBe(403);
    expect((await call(getDelivery, "GET", s.payer, s.id)).status).toBe(200);
    const other = await setup();
    expect((await call(getDelivery, "GET", s.mum, other.id)).status).toBe(404);
  });

  it("validates inputs and rejects other tasks' offers", async () => {
    const s = await setup(); const o = await setup();
    expect((await call(putDelivery, "PUT", s.mum, s.id, { county: "x", city: "y", handling: "air" })).status).toBe(422);
    expect((await call(putDelivery, "PUT", s.mum, s.id, { county: "x", city: "y", handling: "door", weightGrams: -3 })).status).toBe(422);
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.ext, { provider: "aquantuo" }))).status).toBe(422);
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.ext, { amountMinor: 1.5 }))).status).toBe(422);
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.local))).status).toBe(404);
    expect((await call(postQuote, "POST", s.mum, s.id, q(o.ext))).status).toBe(404);
  });

  it("repeats a quote safely and refuses a changed one", async () => {
    const s = await setup();
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.ext))).status).toBe(200);
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.ext))).status).toBe(200);
    expect((await call(postQuote, "POST", s.mum, s.id, q(s.ext, { amountMinor: 9500 }))).status).toBe(409);
    const d = await call(getDelivery, "GET", s.mum, s.id);
    expect(d.json.plans.filter((p: { quote: unknown }) => p.quote)).toHaveLength(1);
  });

  it("treats an expired saved quote as no quote", async () => {
    const s = await setup();
    await call(postQuote, "POST", s.mum, s.id, q(s.ext, { expiresAt: "2020-01-01T00:00:00Z" }));
    const k = (await call(getDelivery, "GET", s.mum, s.id)).json.plans.find((p: { mode: string; offerId: string }) => p.mode === "amazon_buy_ship" && p.offerId === s.ext);
    expect(k.quote.expired).toBe(true);
    // Falls back to our modelled estimate, not the stale quote amount
    expect(k.components.find((c: { key: string }) => c.key === "freight").label).toBe("Air freight to Kenya");
  });

  it("records user-entered steps once and in the right service", async () => {
    const s = await setup();
    const st = (step: string, mode = "forwarding") => call(postStep, "POST", s.mum, s.id, { offerId: s.ext, provider: "kentex", mode, step });
    expect((await st("purchased")).status).toBe(200);
    expect((await st("purchased")).status).toBe(200);
    expect((await st("pre_alert")).status).toBe(200);
    expect((await st("quote_accepted")).status).toBe(422);
    expect((await st("nonsense")).status).toBe(422);
    const d = await call(getDelivery, "GET", s.mum, s.id);
    expect(d.json.progress).toHaveLength(1);
    expect(d.json.progress[0].done.sort()).toEqual(["pre_alert", "purchased"]);
    expect(d.json.progress[0].next.step).toBe("warehouse_verified");
    expect(d.json.plans.every((p: { components: { key: string }[] }) => p.components.length > 0)).toBe(true);
  });
});

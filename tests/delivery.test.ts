import { describe, expect, it } from "vitest";
import { withAssist } from "@/delivery/assist";
import { amazonUsListing, buildPlans, cheapestDelivered, type Inputs } from "@/delivery/compare";
import { freight, volumetricKg } from "@/delivery/estimate";
import { nextAction } from "@/delivery/steps";
import type { ImportedQuote, OfferInput, Plan } from "@/delivery/types";

const NOW = new Date("2026-11-12T10:00:00Z");
const local: OfferInput = { id: "L", title: "Carrier", seller: "Whisker & Co (demo)", route: "paypal", priceMinor: 5700, shippingMinor: 800, currency: "USD", url: null, exact: true };
const amazon: OfferInput = { id: "A", title: "Carrier", seller: "amazon.com", route: "external", priceMinor: 3000, shippingMinor: null, currency: "USD",
  url: "https://www.amazon.com/dp/B012345678", exact: true };
const other: OfferInput = { ...amazon, id: "O", seller: "petshop.com", url: "https://petshop.com/p/1" };
const uk: OfferInput = { ...amazon, id: "U", seller: "amazon.co.uk", currency: "GBP", url: "https://www.amazon.co.uk/dp/B012345678" };
const parcel = { weightGrams: 2000, lengthMm: 300, widthMm: 200, heightMm: 150 };

const base = (o: Partial<Inputs>): Inputs => ({ offers: [local, amazon], quotes: [], destination: { country: "KE", county: "Nairobi", city: "Westlands" },
  prefs: { handling: "door" }, parcel, now: NOW, ...o });
const find = (ps: Plan[], offerId: string, provider: string, mode: string) => ps.find((p) => p.offerId === offerId && p.provider === provider && p.mode === mode)!;
const quote = (o: Partial<ImportedQuote>): ImportedQuote => ({ id: "q", offerId: "A", provider: "kentex", mode: "amazon_buy_ship", reference: "KQ-1", amountMinor: 9000,
  currency: "USD", includesItem: true, includesCustoms: true, includesDelivery: true, expiresAt: "2026-11-20T00:00:00Z", ...o });

describe("delivery comparison", () => {
  it("local wins after freight even though the import item is cheaper", () => {
    const plans = buildPlans(base({ quotes: [quote({})] }));
    const k = find(plans, "A", "kentex", "amazon_buy_ship");
    expect(amazon.priceMinor).toBeLessThan(local.priceMinor);
    expect(k.complete).toBe(true);
    expect(cheapestDelivered(plans)).toBe(find(plans, "L", "demo", "local").id);
  });

  it("does not add the retailer price again when the quote includes the item", () => {
    const k = find(buildPlans(base({ quotes: [quote({})] })), "A", "kentex", "amazon_buy_ship");
    expect(k.knownMinor).toBe(9000);
    expect(k.components.find((c) => c.key === "item")!.status).toBe("included");
    const sep = find(buildPlans(base({ quotes: [quote({ includesItem: false })] })), "A", "kentex", "amazon_buy_ship");
    expect(sep.knownMinor).toBe(12000);
  });

  it("separates eligible and ineligible Kentex Amazon listings", () => {
    expect(amazonUsListing(amazon.url)).toBe(true);
    expect(amazonUsListing(uk.url)).toBe(false);
    expect(amazonUsListing("http://www.amazon.com/dp/B012345678")).toBe(false);
    expect(amazonUsListing("https://amazon.com.evil.test/dp/B012345678")).toBe(false);
    const ps = buildPlans(base({ offers: [amazon, other, uk] }));
    expect(find(ps, "A", "kentex", "amazon_buy_ship").availability).toBe("available");
    expect(find(ps, "O", "kentex", "amazon_buy_ship").availability).toBe("ineligible");
    expect(find(ps, "O", "kentex", "forwarding").availability).toBe("available");
    expect(find(ps, "U", "kentex", "forwarding").availability).toBe("ineligible");
  });

  it("keeps Aquantuo self-buy and Buy For Me apart", () => {
    const ps = buildPlans(base({ offers: [other] }));
    const self = find(ps, "O", "aquantuo", "self_buy"), bfm = find(ps, "O", "aquantuo", "buy_for_me");
    expect(self.title).toMatch(/I'll buy it/);
    expect(bfm.title).toMatch(/Buy and ship/);
    expect(bfm.components.find((c) => c.key === "buy_fee")!.minor).toBe(225);
    expect(self.components.find((c) => c.key === "buy_fee")).toBeUndefined();
    expect(self.handoff!.steps.join(" ")).toMatch(/warehouse address from your own account/);
    expect(bfm.payments).toMatch(/combined service/);
    expect(self.payments).toMatch(/Two separate payments/);
  });

  it("gives a range or unknown, never a firm price, without packed dimensions", () => {
    const noDims = freight("kentex", { weightGrams: 2000 });
    expect(noDims.status).toBe("unknown");
    expect(noDims.minor).toBeUndefined();
    expect(noDims.lowMinor).toBeGreaterThan(0);
    expect(freight("aquantuo", {}).status).toBe("unknown");
    const range = freight("kentex", parcel);
    expect([range.minor, range.highMinor]).toEqual([5000, 10000]);
    expect(freight("kentex", { ...parcel, hub: "delaware" }).minor).toBe(10000);
    const ps = buildPlans(base({ parcel: { weightGrams: 2000 }, quotes: [] }));
    const k = find(ps, "A", "kentex", "forwarding");
    expect(k.complete).toBe(false);
    expect(cheapestDelivered(ps)).toBe(find(ps, "L", "demo", "local").id);
  });

  it("charges the larger of actual and box weight", () => {
    expect(volumetricKg(parcel)).toBeCloseTo(1.795, 2);
    const big = freight("kentex", { weightGrams: 1000, lengthMm: 600, widthMm: 400, heightMm: 400, hub: "texas" });
    expect(big.minor).toBeGreaterThan(5000);
    expect(big.note).toMatch(/box size/);
  });

  it("changes the estimate when the warehouse reweighs heavier", () => {
    const a = freight("aquantuo", { ...parcel, weightGrams: 2000 }).minor!;
    const b = freight("aquantuo", { ...parcel, weightGrams: 3000 }).minor!;
    expect(b).toBeGreaterThan(a);
  });

  it("leaves Kenya delivery unknown and never zero for pickup or door", () => {
    for (const handling of ["pickup", "door"] as const) {
      const k = find(buildPlans(base({ prefs: { handling } })), "A", "kentex", "forwarding");
      const d = k.components.find((c) => c.key === "kenya_delivery")!;
      expect(d.status).toBe("unknown");
      expect(d.label).toBe(handling === "door" ? "Delivery in Kenya" : "Pickup in Kenya");
      expect(k.handoff!.fields).toContainEqual({ label: "Delivery in Kenya", value: handling === "door" ? "To my door" : "I will collect" });
    }
  });

  it("keeps unknown customs explicit and out of a total", () => {
    const aq = find(buildPlans(base({ offers: [other], quotes: [quote({ offerId: "O", provider: "aquantuo", mode: "self_buy", includesItem: false, includesCustoms: false, includesDelivery: true })] })), "O", "aquantuo", "self_buy");
    expect(aq.components.find((c) => c.key === "customs")!.status).toBe("unknown");
    expect(aq.complete).toBe(false);
    expect(cheapestDelivered([aq])).toBeNull();
    const kx = find(buildPlans(base({ offers: [other] })), "O", "kentex", "forwarding");
    expect(kx.components.find((c) => c.key === "customs")!.status).toBe("included");
  });

  it("ignores an expired quote and says so", () => {
    const ps = buildPlans(base({ quotes: [quote({ expiresAt: "2026-11-11T00:00:00Z" })] }));
    const k = find(ps, "A", "kentex", "amazon_buy_ship");
    expect(k.quote!.expired).toBe(true);
    expect(k.complete).toBe(false);
    expect(k.why).toMatch(/expired/);
    expect(cheapestDelivered(ps)).toBe(find(ps, "L", "demo", "local").id);
  });

  it("never lets an incomplete subtotal or a similar item win", () => {
    const ps = buildPlans(base({ offers: [{ ...local, exact: false }, other] }));
    expect(cheapestDelivered(ps)).toBeNull();
    const cheapIncomplete = buildPlans(base({ offers: [{ ...local, priceMinor: 90000 }, other] }));
    expect(cheapestDelivered(cheapIncomplete)).toBe(find(cheapIncomplete, "L", "demo", "local").id);
  });

  it("checks the budget honestly", () => {
    const ps = buildPlans(base({ prefs: { handling: "door", budgetKesMinor: 1_000_000, budgetIncludesDelivery: true } }));
    expect(find(ps, "L", "demo", "local").underBudget).toBe("yes");
    // The known floor alone already passes the budget
    expect(find(ps, "A", "kentex", "forwarding").underBudget).toBe("no");
    const roomy = buildPlans(base({ prefs: { handling: "door", budgetKesMinor: 5_000_000, budgetIncludesDelivery: true } }));
    expect(find(roomy, "A", "kentex", "forwarding").underBudget).toBe("unknown");
    const tight = buildPlans(base({ prefs: { handling: "door", budgetKesMinor: 100_000, budgetIncludesDelivery: true } }));
    expect(find(tight, "L", "demo", "local").underBudget).toBe("no");
  });

  it("asks Aquantuo for county and city before the estimator", () => {
    const h = find(buildPlans(base({ offers: [other], destination: null })), "O", "aquantuo", "self_buy").handoff!;
    expect(h.missing).toEqual(expect.arrayContaining(["County or state in Kenya", "City or area in Kenya"]));
    expect(h.steps[0]).toMatch(/0 is a placeholder/);
  });

  it("keeps a working handoff when browser assistance fails or is off", async () => {
    const h = find(buildPlans(base({ offers: [other] })), "O", "aquantuo", "self_buy").handoff!;
    const failing = { fill: async () => { throw new Error("boom"); } };
    const r = await withAssist(h, failing, true);
    expect(r.assisted).toBe(false);
    expect(r.error).toMatch(/copy buttons/);
    expect(r.handoff.officialUrl).toBe("https://aquantuo.com/Price-Estimator");
    expect((await withAssist(h, failing, false)).error).toBeUndefined();
    const ok = await withAssist(h, { fill: async () => {} }, true);
    expect(ok.assisted).toBe(true);
  });

  it("keeps pre-alert, warehouse receipt and Kenya delivery separate", () => {
    expect(nextAction("forwarding", []).step).toBe("warehouse_verified");
    expect(nextAction("forwarding", ["warehouse_verified", "purchased"]).step).toBe("pre_alert");
    expect(nextAction("forwarding", ["warehouse_verified", "purchased", "pre_alert"]).step).toBe("received_warehouse");
    expect(nextAction("forwarding", ["pre_alert"]).step).toBe("warehouse_verified");
    expect(nextAction("buy_for_me", ["quote_accepted"]).step).toBe("received_warehouse");
  });

  it("adds the Kentex assisted fee, tax line and insurance only over $200", () => {
    const k = find(buildPlans(base({ quotes: [] })), "A", "kentex", "amazon_buy_ship");
    expect(k.components.find((c) => c.key === "buy_fee")!.minor).toBe(300);
    expect(k.components.find((c) => c.key === "sales_tax")!.status).toBe("unknown");
    expect(k.components.find((c) => c.key === "insurance")).toBeUndefined();
    expect(k.complete).toBe(false);
    const pricey = find(buildPlans(base({ offers: [{ ...amazon, priceMinor: 25000 }], quotes: [] })), "A", "kentex", "amazon_buy_ship");
    expect(pricey.components.find((c) => c.key === "insurance")!.minor).toBe(1250);
    const edge = find(buildPlans(base({ offers: [{ ...amazon, priceMinor: 20000 }], quotes: [] })), "A", "kentex", "forwarding");
    expect(edge.components.find((c) => c.key === "insurance")).toBeUndefined();
  });

  it("prices the Aquantuo UK lane at its own flagged rate", () => {
    const uk2 = find(buildPlans(base({ offers: [uk], quotes: [] })), "U", "aquantuo", "self_buy");
    const us2 = find(buildPlans(base({ offers: [other], quotes: [] })), "O", "aquantuo", "self_buy");
    const fu = uk2.components.find((c) => c.key === "freight")!, fs = us2.components.find((c) => c.key === "freight")!;
    expect(fu.status).toBe("estimated");
    expect(fu.minor).toBe(2800);
    expect(fs.minor).toBe(3600);
    expect(fu.note).toMatch(/UK rate is unconfirmed/);
    expect(uk2.complete).toBe(false);
  });
});

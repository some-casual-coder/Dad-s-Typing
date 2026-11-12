import { describe, expect, it } from "vitest";
import { withAssist } from "@/delivery/assist";
import { amazonUsListing, buildPlans, cheapestDelivered, type Inputs } from "@/delivery/compare";
import { freight, kenyaDelivery } from "@/delivery/estimate";
import { chargeableKg, estimateParcel, KENTEX_CM3_PER_KG } from "@/delivery/packaging";
import { nextAction } from "@/delivery/steps";
import { addWorkingDays, estimateArrival, formatRange, kentexDeparture, nairobiDate } from "@/delivery/eta";
import { FALLBACK_FX, fxLabel, toKes } from "@/delivery/fx";
import { closestMatch, identity } from "@/delivery/identity";
import { difference, present, priceText } from "@/delivery/present";
import type { ImportedQuote, OfferInput, Plan } from "@/delivery/types";

const NOW = new Date("2026-11-12T10:00:00Z");
const local: OfferInput = { id: "L", title: "Carrier", seller: "Whisker & Co (demo)", route: "paypal", priceMinor: 5700, shippingMinor: 800, currency: "USD", url: null, exact: true };
const amazon: OfferInput = { id: "A", title: "Carrier", seller: "amazon.com", route: "external", priceMinor: 3000, shippingMinor: null, currency: "USD",
  url: "https://www.amazon.com/dp/B012345678", exact: true };
const other: OfferInput = { ...amazon, id: "O", seller: "petshop.com", url: "https://petshop.com/p/1" };
const uk: OfferInput = { ...amazon, id: "U", seller: "amazon.co.uk", currency: "GBP", url: "https://www.amazon.co.uk/dp/B012345678" };
const parcel = {};
const measuredParcel = { weightGrams: 2000, lengthMm: 300, widthMm: 200, heightMm: 150 };

const base = (o: Partial<Inputs>): Inputs => ({ offers: [local, amazon], quotes: [], destination: { country: "KE", county: "Nairobi", city: "Westlands" },
  prefs: { handling: "door" }, parcel, fx: FALLBACK_FX, now: NOW, ...o });
const find = (ps: Plan[], offerId: string, provider: string, mode: string) => ps.find((p) => p.offerId === offerId && p.provider === provider && p.mode === mode)!;
const quote = (o: Partial<ImportedQuote>): ImportedQuote => ({ id: "q", offerId: "A", provider: "kentex", mode: "amazon_buy_ship", reference: "KQ-1", amountMinor: 9000,
  currency: "USD", includesItem: true, includesCustoms: true, includesDelivery: true, expiresAt: "2026-11-20T00:00:00Z", ...o });

describe("delivery comparison", () => {
  const listed = { weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280, dimsSource: "Channel3" };

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

  it("recognises only real Amazon.com product links", () => {
    expect(amazonUsListing(amazon.url)).toBe(true);
    expect(amazonUsListing(uk.url)).toBe(false);
    expect(amazonUsListing("http://www.amazon.com/dp/B012345678")).toBe(false);
    expect(amazonUsListing("https://amazon.com.evil.test/dp/B012345678")).toBe(false);
  });

  it("picks one method per offer without asking: Amazon tool, else buy-for-me", () => {
    const ps = buildPlans(base({ offers: [amazon, other, uk] }));
    const primary = (id: string) => ps.filter((p) => p.offerId === id && p.primary).map((p) => `${p.provider}:${p.mode}`);
    expect(primary("A")).toEqual(["kentex:amazon_buy_ship"]);
    expect(primary("O")).toEqual(["kentex:buy_for_me"]);
    expect(primary("U")).toEqual(["aquantuo:buy_for_me"]);
    expect(ps.filter((p) => p.offerId === "U" && p.provider === "kentex")).toHaveLength(0);
  });

  it("a representative item gets a complete delivered range with sources and no user input", () => {
    const carrier = { ...amazon, specs: listed };
    for (const handling of ["door", "pickup"] as const) {
      const k = find(buildPlans(base({ offers: [carrier], prefs: { handling } })), "A", "kentex", "amazon_buy_ship");
      expect(k.complete).toBe(true);
      expect(k.kes!.high).toBeGreaterThan(k.kes!.low);
      expect(k.components.every((c) => c.source)).toBe(true);
      expect(k.components.map((c) => c.key)).toEqual(["item", "sales_tax", "buy_fee", "freight", "insurance", "customs", "kenya_delivery"]);
      expect(k.parcel!.basis).toBe("listed");
    }
    const ps = buildPlans(base({ offers: [carrier] }));
    expect(cheapestDelivered(ps)).toBe(find(ps, "A", "kentex", "amazon_buy_ship").id);
    expect(find(ps, "A", "kentex", "amazon_buy_ship").confidence).toBe("low");
  });

  it("uses Kentex Amazon terms: 8.25% tax, 5% fee, insurance only over $200", () => {
    const k = find(buildPlans(base({ quotes: [] })), "A", "kentex", "amazon_buy_ship");
    expect(k.components.find((c) => c.key === "sales_tax")!.minor).toBe(248);
    expect(k.components.find((c) => c.key === "buy_fee")!.minor).toBe(150);
    expect(k.components.find((c) => c.key === "insurance")!.status).toBe("not_applicable");
    const pricey = find(buildPlans(base({ offers: [{ ...amazon, priceMinor: 25000 }] })), "A", "kentex", "amazon_buy_ship");
    expect(pricey.components.find((c) => c.key === "insurance")!.minor).toBe(1250);
    const assisted = find(buildPlans(base({ offers: [other] })), "O", "kentex", "buy_for_me");
    expect(assisted.components.find((c) => c.key === "buy_fee")!.minor).toBe(300);
  });

  it("widens the range when weight and size come from category priors", () => {
    const listedEst = estimateParcel({ title: "cat carrier", specs: listed });
    const prior = estimateParcel({ title: "cat carrier" });
    expect(prior.basis).toBe("category");
    expect(prior.confidence).toBe("low");
    expect(prior.kind).toBe("pet carrier");
    expect(prior.high.grams / prior.low.grams).toBeGreaterThan(listedEst.high.grams / listedEst.low.grams);
    expect(estimateParcel({ title: "x", specs: { weightGrams: 900 } }).basis).toBe("weight_only");
    expect(estimateParcel({ title: "x" }, { grams: 2000, lengthMm: 300, widthMm: 200, heightMm: 150 }).basis).toBe("measured");
  });

  it("packed weight is never below the item weight at the high end", () => {
    const e = estimateParcel({ title: "kettle", specs: listed });
    expect(e.high.grams).toBeGreaterThan(listed.weightGrams);
    expect(e.high.lengthMm).toBeGreaterThan(listed.lengthMm);
  });

  it("charges the larger of actual and box weight, with Kentex minimums", () => {
    const box = { grams: 1000, lengthMm: 600, widthMm: 400, heightMm: 400 };
    expect(chargeableKg(box, KENTEX_CM3_PER_KG)).toBeCloseTo(19.15, 1);
    const est = estimateParcel({ title: "x" }, { ...box });
    const f = freight("kentex", est, "us", "texas");
    expect(f.minor).toBe(Math.round(chargeableKg(box, KENTEX_CM3_PER_KG) * 1799));
    const tiny = estimateParcel({ title: "x" }, { grams: 200, lengthMm: 100, widthMm: 100, heightMm: 50 });
    expect([freight("kentex", tiny, "us", "texas").minor, freight("kentex", tiny, "us", "texas").highMinor]).toEqual([5000, 5000]);
    expect([freight("kentex", tiny, "us").minor, freight("kentex", tiny, "us").highMinor]).toEqual([5000, 10000]);
  });

  it("pickup at Kentex is free; door is modelled and never zero", () => {
    const e = estimateParcel({ title: "cat carrier", specs: listed });
    const pick = kenyaDelivery("kentex", "pickup", e), door = kenyaDelivery("kentex", "door", e);
    expect([pick.status, pick.minor]).toEqual(["known", 0]);
    expect(door.status).toBe("estimated");
    expect(door.minor).toBeGreaterThan(0);
    expect(door.confidence).toBe("low");
    expect(kenyaDelivery("aquantuo", "door", e).status).toBe("unknown");
  });

  it("keeps unknown customs explicit and out of a total", () => {
    const aq = find(buildPlans(base({ offers: [uk] })), "U", "aquantuo", "buy_for_me");
    expect(aq.components.find((c) => c.key === "customs")!.status).toBe("unknown");
    expect(aq.complete).toBe(false);
    expect(cheapestDelivered([aq])).toBeNull();
    expect(find(buildPlans(base({ offers: [other] })), "O", "kentex", "buy_for_me").components.find((c) => c.key === "customs")!.status).toBe("included");
  });

  it("ignores an expired quote and says so", () => {
    const ps = buildPlans(base({ quotes: [quote({ expiresAt: "2026-11-11T00:00:00Z" })] }));
    const k = find(ps, "A", "kentex", "amazon_buy_ship");
    expect(k.quote!.expired).toBe(true);
    expect(k.why).toMatch(/expired/);
  });

  it("never lets an incomplete subtotal or a similar item win", () => {
    const ps = buildPlans(base({ offers: [{ ...local, exact: false }, { ...uk }] }));
    expect(cheapestDelivered(ps)).toBeNull();
    const similar = buildPlans(base({ offers: [{ ...amazon, exact: false, specs: listed }] }));
    expect(cheapestDelivered(similar)).toBeNull();
  });

  it("ranks on the high end so a wide modelled range cannot win on its floor", () => {
    const ps = buildPlans(base({ offers: [{ ...local, priceMinor: 9000 }, { ...amazon, specs: listed }] }));
    const winner = ps.find((p) => p.id === cheapestDelivered(ps))!;
    const others = ps.filter((p) => p.exact && p.complete && p.id !== winner.id);
    for (const o of others) expect(winner.kes!.high).toBeLessThanOrEqual(o.kes!.high);
  });

  it("uses a measured parcel when one exists", () => {
    const ps = buildPlans(base({ offers: [amazon], parcel: measuredParcel }));
    expect(find(ps, "A", "kentex", "amazon_buy_ship").parcel!.basis).toBe("measured");
  });

  it("checks the budget honestly", () => {
    const ps = buildPlans(base({ prefs: { handling: "door", budgetKesMinor: 1_000_000, budgetIncludesDelivery: true } }));
    expect(find(ps, "L", "demo", "local").underBudget).toBe("yes");
    const tight = buildPlans(base({ prefs: { handling: "door", budgetKesMinor: 100_000, budgetIncludesDelivery: true } }));
    expect(find(tight, "L", "demo", "local").underBudget).toBe("no");
  });

  it("gives tracking links and estimated parcel fields in the handoff", () => {
    const h = find(buildPlans(base({ offers: [amazon] })), "A", "kentex", "amazon_buy_ship").handoff!;
    expect(h.trackingUrl).toBe("https://kentexcargo.com/tracking");
    expect(h.fields.map((f) => f.label)).toContain("Packed weight (estimate)");
    expect(h.missing).toEqual([]);
  });

  it("keeps a working handoff when browser assistance fails or is off", async () => {
    const h = find(buildPlans(base({ offers: [other] })), "O", "kentex", "forwarding").handoff!;
    const failing = { fill: async () => { throw new Error("boom"); } };
    const r = await withAssist(h, failing, true);
    expect(r.assisted).toBe(false);
    expect(r.error).toMatch(/copy buttons/);
    expect((await withAssist(h, failing, false)).error).toBeUndefined();
    expect((await withAssist(h, { fill: async () => {} }, true)).assisted).toBe(true);
  });

  it("keeps pre-alert, warehouse receipt and Kenya delivery separate", () => {
    expect(nextAction("forwarding", []).step).toBe("warehouse_verified");
    expect(nextAction("forwarding", ["warehouse_verified", "purchased"]).step).toBe("pre_alert");
    expect(nextAction("buy_for_me", ["quote_accepted"]).step).toBe("received_warehouse");
  });
});

describe("identity and fx", () => {
  it("scores identity by the words the AI named, ignoring filler", () => {
    const m = identity("Top-opening cat carrier for Mum", { title: "Sherpa top opening pet carrier", category: ["cat-carriers"] });
    expect(m.score).toBe(1);
    expect(identity("cat carrier", { title: "Dog bed" }).score).toBe(0);
  });
  it("an item with no confirmed requirements can still be the best closest match", () => {
    expect(closestMatch("unchecked", 0.8, 0.8)).toBe(true);
    expect(closestMatch("unchecked", 0.5, 0.9)).toBe(false);
    expect(closestMatch("unresolved", 1, 1)).toBe(false);
    const ps = buildPlans(base({ offers: [{ ...local, exact: closestMatch("unchecked", 1, 1) }], quotes: [] }));
    expect(cheapestDelivered(ps)).toBe(ps[0].id);
  });
  it("converts in integer minor units with a buffer and keeps provenance", () => {
    const fx = { USD: { ...FALLBACK_FX.USD, kesPerUnitMicro: 129_950_000, stale: false, source: "CBK" } };
    expect(toKes(5700, "USD", fx)).toEqual({ low: 740_715, high: 777_751 });
    expect(toKes(100, "EUR", fx)).toBeNull();
    expect(fxLabel(fx)).toContain("1 USD = KSh 129.95 (CBK");
  });
});

describe("packaging priors", () => {
  it("lets the title decide the kind before the category", () => {
    expect(estimateParcel({ title: "Top opening cat carrier", specs: { category: ["dog-crates-kennels"] } }).kind).toBe("pet carrier");
    expect(estimateParcel({ title: "Something", specs: { category: ["dog-crates"] } }).kind).toBe("crate");
  });
  it("lets a folding crate ship flat at the low end only", () => {
    const e = estimateParcel({ title: "Wire dog crate", specs: { weightGrams: 9000, lengthMm: 760, widthMm: 480, heightMm: 530 } });
    expect(e.low.heightMm).toBeLessThanOrEqual(110);
    expect(e.high.heightMm).toBeGreaterThan(480);
  });
});

describe("arrival dates", () => {
  // 2026-11-12 is a Thursday; 2026-11-16 a Monday
  const at = (iso: string) => new Date(`${iso}T09:00:00+03:00`);

  it("counts working days and skips weekends", () => {
    const fri = nairobiDate(at("2026-11-13"));
    expect(addWorkingDays(fri, 1).toISOString().slice(0, 10)).toBe("2026-11-16");
    expect(addWorkingDays(fri, 5).toISOString().slice(0, 10)).toBe("2026-11-20");
  });

  it("uses the Nairobi date, not UTC, near midnight", () => {
    expect(nairobiDate(new Date("2026-11-12T22:30:00Z")).toISOString().slice(0, 10)).toBe("2026-11-13");
  });

  it("makes the Wednesday flight when in by Monday, and the next one when after", () => {
    const mon = nairobiDate(at("2026-11-16")), tue = nairobiDate(at("2026-11-17"));
    expect(kentexDeparture(mon, "low").toISOString().slice(0, 10)).toBe("2026-11-18");
    expect(kentexDeparture(mon, "high").toISOString().slice(0, 10)).toBe("2026-11-25");
    expect(kentexDeparture(tue, "low").toISOString().slice(0, 10)).toBe("2026-11-25");
    const sun = nairobiDate(at("2026-11-15"));
    expect(kentexDeparture(sun, "high").toISOString().slice(0, 10)).toBe("2026-11-18");
  });

  it("gives an Amazon order placed Thursday a range from the flight", () => {
    const e = estimateArrival("kentex_amazon", at("2026-11-12"), { area: "nairobi", handling: "door" });
    // Fast: Fri at warehouse, Wed 18 flight, +7 working days = 27 Nov, +1 = 30 Nov
    expect(e.earliest).toBe("2026-11-30");
    // Slow: Wed 18 at warehouse, Wed 25 flight, +14 = 15 Dec, +2 = 17 Dec
    expect(e.latest).toBe("2026-12-17");
    expect(e.assumptions.join(" ")).toMatch(/from the Wednesday flight/);
  });

  it("widens the range when a leg is our default", () => {
    const amazon = estimateArrival("kentex_amazon", at("2026-11-12"));
    const store = estimateArrival("kentex_store", at("2026-11-12"));
    expect(store.latest > amazon.latest).toBe(true);
    expect(store.confidence).toBe("low");
    const up = estimateArrival("kentex_amazon", at("2026-11-12"), { area: "upcountry" });
    const nbo = estimateArrival("kentex_amazon", at("2026-11-12"), { area: "nairobi" });
    expect(up.latest > nbo.latest).toBe(true);
  });

  it("formats a short range", () => {
    expect(formatRange("2026-12-02", "2026-12-09")).toBe("about 2 to 9 December");
    expect(formatRange("2026-11-30", "2026-12-17")).toBe("about 30 November to 17 December");
  });

  it("puts a date on every priced import card and none on an unconfirmed store route", () => {
    const ps = buildPlans(base({ offers: [amazon, uk] }));
    expect(ps.filter((p) => p.primary).every((p) => p.eta)).toBe(true);
    expect(find(ps, "A", "store", "direct").eta).toBeNull();
  });
});

describe("cards", () => {
  const listed = { weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280, brand: "Sherpa", imageUrl: "https://img.test/a.jpg" };
  const a = { ...amazon, id: "A", specs: listed };
  const b = { ...amazon, id: "B", priceMinor: 9000, specs: { ...listed, brand: "Petmate", lengthMm: 540 } };

  it("shows one card per listing with its chosen method, a price and a date", () => {
    const ps = buildPlans(base({ offers: [a, b, { ...uk, exact: false }] }));
    const c = present(ps, cheapestDelivered(ps));
    expect(c.closest.map((x) => x.offerId)).toEqual(["A", "B"]);
    expect(c.closest[0].winner).toBe(true);
    expect(c.closest[0].method).toBe("We buy it on Amazon and ship it");
    expect(c.closest[0].price).toMatch(/^KSh [\d,]+( to [\d,]+)?$|^about KSh/);
    expect(c.closest[0].arrival).toMatch(/^about \d+/);
    expect(c.closest[0].others.length).toBeGreaterThan(0);
    expect(c.similar.map((x) => x.offerId)).toEqual(["U"]);
    expect(c.similar[0].price).toBeNull();
  });

  it("computes the difference line from facts, never from the model", () => {
    const ps = buildPlans(base({ offers: [a, b] }));
    const c = present(ps, cheapestDelivered(ps));
    expect(c.closest[0].difference).toBe("Closest to what you sent.");
    expect(c.closest[1].difference).toMatch(/^Different brand, 9 cm bigger, KSh [\d,]+ dearer\.$/);
  });

  it("recommends with a reason only when the first card has a full price", () => {
    const ps = buildPlans(base({ offers: [a, b] }));
    expect(present(ps, cheapestDelivered(ps)).recommendation).toMatch(/^I'd get the first one: closest match, arrives about .*, KSh [\d,]+ cheaper than the next one\.$/);
    const inc = buildPlans(base({ offers: [uk] }));
    expect(present(inc, cheapestDelivered(inc)).recommendation).toMatch(/None of these has a full delivered price yet/);
  });

  it("shows one figure when the range is narrow and a range when it matters", () => {
    expect(priceText({ low: 1_000_000, high: 1_050_000 })).toBe("about KSh 10,500");
    expect(priceText({ low: 1_000_000, high: 2_000_000 })).toBe("KSh 10,000 to 20,000");
  });

  it("caps each group at three and puts the rest behind more", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...a, id: `M${i}`, priceMinor: 3000 + i * 100 }));
    const c = present(buildPlans(base({ offers: many })), null);
    expect(c.closest).toHaveLength(3);
    expect(c.more).toHaveLength(2);
  });
});

describe("card wording with overlapping ranges", () => {
  it("does not call an overlapping range cheaper", () => {
    const mk = (id: string, low: number, high: number) => ({ id, exact: true, complete: true, kes: { low, high }, eta: null,
      item: { title: id, seller: "s", imageUrl: null, brand: null, priceMinor: 1, currency: "USD", longestMm: null } }) as unknown as Plan;
    expect(difference(mk("B", 1_350_000, 6_580_000), mk("A", 3_020_000, 4_160_000))).toBe("Up to KSh 24,200 more.");
    expect(difference(mk("B", 5_000_000, 6_000_000), mk("A", 3_000_000, 4_000_000))).toBe("KSh 20,000 dearer.");
  });
});

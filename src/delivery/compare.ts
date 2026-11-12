import { amazonTax, customs, fee, freight, isPriced, kentexInsurance, kenyaDelivery, overallConfidence, storeTaxAndDelivery, sumKnown } from "./estimate";
import { estimateArrival, type Area, type Lane } from "./eta";
import type { FxTable } from "./fx";
import { handoffFor } from "./handoff";
import { estimateParcel, type ParcelEstimate } from "./packaging";
import { comp, RULES, RULES_AS_OF } from "./rules";
import type { Component, Destination, ImportedQuote, Mode, OfferInput, Parcel, Plan, Prefs, Provider, RouteKind } from "./types";

export interface Inputs {
  offers: OfferInput[];
  quotes: ImportedQuote[];
  destination: Destination | null;
  prefs: Prefs;
  // A measured packed parcel overrides the estimate when present
  parcel: Parcel;
  fx: FxTable;
  now: Date;
}

export function amazonUsListing(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^(www\.)?amazon\.com$/.test(u.hostname) && /\/(dp|gp\/product)\/[A-Z0-9]{10}/.test(u.pathname);
  } catch {
    return false;
  }
}

const itemPart = (o: OfferInput): Component => comp({ key: "item", label: "Item price", status: "known", currency: o.currency,
  minor: o.priceMinor, confidence: "high", source: `${o.seller} listing, ${RULES_AS_OF}` });

const domestic = (o: OfferInput): Component => o.shippingMinor !== null
  ? comp({ key: "domestic", label: "Shipping to the warehouse", status: "known", currency: o.currency, minor: o.shippingMinor, source: `${o.seller} listing` })
  : comp({ key: "domestic", label: "Shipping to the warehouse", status: "unknown", currency: o.currency,
      note: "Retailer shipping and sales tax are set at its checkout.", source: `${o.seller} listing` });

const PAYMENTS: Record<string, string> = {
  local: "One payment to this seller.",
  direct: "You pay the store at its own checkout.",
  forwarding: "Two payments: the store for the item, then the forwarder's freight invoice.",
  self_buy: "Two payments: the store for the item, then the forwarder's freight invoice.",
  buy_for_me: "One payment covers the item, fees, freight and delivery.",
  amazon_buy_ship: "One payment covers the item, tax, fees, freight and delivery.",
};

const TITLES: Record<string, string> = {
  local: "From a seller who delivers", direct: "The store ships it", forwarding: "You buy, we forward it", self_buy: "You buy, we forward it",
  buy_for_me: "We buy and ship it", amazon_buy_ship: "We buy it on Amazon and ship it",
};

interface Draft {
  offer: OfferInput; route: RouteKind; provider: Plan["provider"]; mode: Plan["mode"]; primary: boolean;
  parts: Component[]; availability: Plan["availability"]; why: string; parcel: ParcelEstimate | null;
}

function quotedParts(o: OfferInput, q: ImportedQuote, provider: Provider, p: ParcelEstimate, handling: Prefs["handling"]): Component[] {
  const src = `${provider} quote ${q.reference}`;
  const cur = q.currency;
  return [
    q.includesItem
      ? comp({ key: "item", label: "Item price", status: "included", currency: cur, note: "In the provider quote. Not added again.", source: src })
      : itemPart(o),
    comp({ key: "freight", label: "Provider quote", status: "known", currency: cur, minor: q.amountMinor, confidence: "high", note: `Quote ${q.reference}`, source: src }),
    q.includesCustoms
      ? comp({ key: "customs", label: "Customs and import tax", status: "included", currency: cur, note: "The quote says it covers these.", source: src })
      : customs(provider),
    q.includesDelivery
      ? comp({ key: "kenya_delivery", label: "Delivery in Kenya", status: "included", currency: cur, note: "The quote says it covers this.", source: src })
      : kenyaDelivery(provider, handling, p),
  ];
}

const measured = (p: Parcel) => (p.weightGrams ? { grams: p.weightGrams, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm } : undefined);

// One primary method per offer, chosen so the shopper never runs a forwarder
// account: local seller, then Amazon tool, then a buy-for-me service
function drafts(i: Inputs): Draft[] {
  const out: Draft[] = [];
  const h = i.prefs.handling;
  for (const o of i.offers) {
    if (o.route === "paypal") {
      const priced = o.shippingMinor !== null;
      out.push({ offer: o, route: "local", provider: "demo", mode: "local", availability: "available", primary: true, parcel: null,
        why: priced ? "The seller prices delivery." : "Delivery is not priced yet.",
        parts: [itemPart(o), priced
          ? comp({ key: "kenya_delivery", label: "Delivery", status: "known", currency: o.currency, minor: o.shippingMinor!, confidence: "high", source: `${o.seller} listing` })
          : comp({ key: "kenya_delivery", label: "Delivery", status: "unknown", currency: o.currency, source: `${o.seller} listing` })] });
      continue;
    }
    const us = o.currency === "USD", uk = o.currency === "GBP";
    const p = estimateParcel(o, measured(i.parcel));
    const add = (d: Omit<Draft, "offer" | "parcel">) => out.push({ ...d, offer: o, parcel: p });
    const amazon = us && amazonUsListing(o.url);

    if (amazon) add({ route: "forward", provider: "kentex", mode: "amazon_buy_ship", availability: "available", primary: true,
      why: "Amazon.com listing: Kentex buys it and flies it from Texas.",
      parts: [itemPart(o), amazonTax(o.priceMinor), fee("Kentex purchase fee", o.priceMinor, "USD", RULES.kentex.amazonFeePct, RULES.kentex.amazonSource, "5% of the item price."),
        freight("kentex", p, "us", "texas"), kentexInsurance(o.priceMinor, RULES.kentex.amazonSource), customs("kentex"), kenyaDelivery("kentex", h, p)] });
    if (us) add({ route: "forward", provider: "kentex", mode: "buy_for_me", availability: "available", primary: !amazon,
      why: "Kentex buys it from the US store and flies it to Kenya.",
      parts: [itemPart(o), storeTaxAndDelivery(o.priceMinor), fee("Kentex service fee", o.priceMinor, "USD", RULES.kentex.assistedFeePct, RULES.kentex.assistedSource, "10% of the item price only."),
        freight("kentex", p, "us"), kentexInsurance(o.priceMinor, RULES.kentex.assistedSource), customs("kentex"), kenyaDelivery("kentex", h, p)] });
    if (us || uk) add({ route: "forward", provider: "aquantuo", mode: "buy_for_me", availability: "available", primary: uk,
      why: uk ? "Aquantuo buys it from the UK store and flies it to Kenya." : "Aquantuo buys it from the US store and flies it to Kenya.",
      parts: [itemPart(o), fee("Aquantuo Buy For Me fee", o.priceMinor, o.currency, RULES.aquantuo.buyForMeFeePct, RULES.aquantuo.source, "7.5% of the item price (search summary)."),
        freight("aquantuo", p, uk ? "uk" : "us"), customs("aquantuo"), kenyaDelivery("aquantuo", h, p)] });
    if (us) add({ route: "forward", provider: "kentex", mode: "forwarding", availability: "available", primary: false,
      why: "You buy it yourself and ship it to your Kentex US address.",
      parts: [itemPart(o), domestic(o), freight("kentex", p, "us"), kentexInsurance(o.priceMinor, RULES.kentex.source), customs("kentex"), kenyaDelivery("kentex", h, p)] });
    const store = i.quotes.find((q) => q.offerId === o.id && q.provider === "store");
    add({ route: "direct", provider: "store", mode: "direct", availability: store ? "available" : "needs_quote", primary: !us && !uk,
      why: store ? "Store shipping quote." : "Only if the store ships to Kenya; Channel3 does not say.",
      parts: store ? [itemPart(o), comp({ key: "kenya_delivery", label: "Shipping and import charges", status: "known", currency: store.currency, minor: store.amountMinor,
        note: `Quote ${store.reference}`, source: `${o.seller} quote` }),
        comp({ key: "customs", label: "Customs and import tax", status: store.includesCustoms ? "included" : "unknown", currency: store.currency, source: `${o.seller} quote` })]
        : [itemPart(o), comp({ key: "kenya_delivery", label: "Shipping to Kenya", status: "unknown", currency: o.currency, source: `${o.seller} listing` }),
          comp({ key: "customs", label: "Customs and import tax", status: "unknown", currency: o.currency, source: `${o.seller} listing` })] });
  }
  return out;
}

function underBudget(parts: Component[], kes: Plan["kes"], complete: boolean, prefs: Prefs, fx: FxTable): Plan["underBudget"] {
  const budget = prefs.budgetKesMinor;
  if (budget === undefined) return "unknown";
  // A budget that excludes delivery is compared with the item alone
  const counted = prefs.budgetIncludesDelivery === false ? parts.filter((c) => c.key === "item") : parts;
  const k = prefs.budgetIncludesDelivery === false ? sumKnown(counted, fx).kes : kes;
  if (!k) return "unknown";
  if (k.low > budget) return "no";
  const all = prefs.budgetIncludesDelivery === false ? counted.every(isPriced) : complete;
  return all && k.high <= budget ? "yes" : "unknown";
}

function laneOf(d: Draft): Lane | null {
  if (d.route === "local") return "local_demo";
  if (d.provider === "kentex") return d.mode === "amazon_buy_ship" ? "kentex_amazon" : "kentex_store";
  if (d.provider === "aquantuo") return d.offer.currency === "GBP" ? "aquantuo_uk" : "aquantuo_us";
  return null;
}

const areaOf = (dest: Destination | null): Area =>
  !dest?.county ? "unknown" : /nairobi/i.test(dest.county) ? "nairobi" : "upcountry";

export function buildPlans(i: Inputs): Plan[] {
  return drafts(i).map((d) => {
    const provider = d.provider;
    const q = provider === "aquantuo" || provider === "kentex"
      ? i.quotes.find((x) => x.offerId === d.offer.id && x.provider === provider && x.mode === d.mode) : undefined;
    const expired = !!q?.expiresAt && new Date(q.expiresAt) <= i.now;
    const usable = q && !expired;
    const parts = usable && d.parcel ? quotedParts(d.offer, q, provider as Provider, d.parcel, i.prefs.handling) : d.parts;
    const complete = d.availability === "available" && parts.every(isPriced);
    const sums = sumKnown(parts, i.fx);
    const kes = sums.kes ? { low: sums.kes.low, high: sums.kes.high } : null;
    const info = (provider === "aquantuo" || provider === "kentex") && d.availability === "available"
      ? handoffFor(provider, d.mode as Mode, d.offer, i.destination, d.parcel, i.prefs) : null;
    return {
      id: `${d.offer.id}:${provider}:${d.mode}`, offerId: d.offer.id, route: d.route, provider, mode: d.mode,
      title: TITLES[d.mode as string] ?? `Buy at ${d.offer.seller}`,
      exact: d.offer.exact, match: d.offer.match ?? null, availability: d.availability,
      why: usable ? `Uses your ${provider} quote.` : q && expired ? "Your saved quote has expired. Get a fresh one." : d.why,
      components: parts, complete, primary: d.primary, confidence: overallConfidence(parts), parcel: d.parcel,
      eta: laneOf(d) ? estimateArrival(laneOf(d)!, i.now, { area: areaOf(i.destination), handling: i.prefs.handling }) : null,
      knownMinor: sums.single?.low ?? null, knownHighMinor: sums.single?.high ?? null,
      knownCurrency: sums.single?.cur ?? null, kes, underBudget: underBudget(parts, kes, complete, i.prefs, i.fx),
      quote: q ? { reference: q.reference, expired, expiresAt: q.expiresAt } : null,
      handoff: info, payments: PAYMENTS[d.mode as string] ?? PAYMENTS.direct,
    } satisfies Plan;
  });
}

// The only way to be called cheapest: closest match, available, fully priced.
// Ranked on the high end, so a wide modelled range cannot win on its low end.
export function cheapestDelivered(plans: Plan[]): string | null {
  const ok = plans.filter((p) => p.exact && p.availability === "available" && p.complete && p.kes);
  ok.sort((a, b) => a.kes!.high - b.kes!.high || a.kes!.low - b.kes!.low);
  return ok[0]?.id ?? null;
}

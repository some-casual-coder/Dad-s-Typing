import { buyForMeFee, customs, freight, isPriced, kentexInsurance, kentexServiceFee, kenyaDelivery, salesTax, sumKnown } from "./estimate";
import { handoffFor } from "./handoff";
import { comp, RULES, RULES_AS_OF, toKes } from "./rules";
import type { Component, Destination, ImportedQuote, Mode, OfferInput, Parcel, Plan, Prefs, Provider, RouteKind } from "./types";

export interface Inputs {
  offers: OfferInput[];
  quotes: ImportedQuote[];
  destination: Destination | null;
  prefs: Prefs;
  parcel: Parcel;
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
  minor: o.priceMinor, source: `${o.seller} listing, ${RULES_AS_OF}` });

const domestic = (o: OfferInput): Component => o.shippingMinor !== null
  ? comp({ key: "domestic", label: "Shipping to the warehouse", status: "known", currency: o.currency, minor: o.shippingMinor, source: `${o.seller} listing` })
  : comp({ key: "domestic", label: "Shipping to the warehouse", status: "unknown", currency: o.currency,
      note: "Retailer shipping and sales tax are set at its checkout.", source: `${o.seller} listing` });

const PAYMENTS: Record<string, string> = {
  local: "You pay this seller in one step. Dad's Typing PayPal checkout applies only to the demo seller.",
  direct: "You pay the store at its own checkout. Dad's Typing takes no payment.",
  self_buy: "Two separate payments: the retailer for the item, then the forwarder's freight invoice. Dad's Typing takes neither.",
  forwarding: "Two separate payments: the retailer for the item, then the forwarder's freight invoice. Dad's Typing takes neither.",
  buy_for_me: "The provider sells a combined service and bills you on its own site. Dad's Typing takes no payment.",
  amazon_buy_ship: "The provider sells a combined service and bills you on its own site. Dad's Typing takes no payment.",
};

const TITLES: Record<string, string> = {
  self_buy: "I'll buy it; ship it for me", buy_for_me: "Buy and ship it for me",
  amazon_buy_ship: "Buy from Amazon and ship it for me", forwarding: "I'll buy it; ship it for me",
};

interface Draft {
  offer: OfferInput; route: RouteKind; provider: Plan["provider"]; mode: Plan["mode"];
  parts: Component[]; availability: Plan["availability"]; why: string; quoteKey?: string;
}

function quotedParts(o: OfferInput, q: ImportedQuote, provider: Provider): Component[] {
  const src = `${provider} quote ${q.reference}`;
  const cur = q.currency;
  const parts: Component[] = [
    q.includesItem
      ? comp({ key: "item", label: "Item price", status: "included", currency: cur, note: "In the provider quote. Not added again.", source: src })
      : itemPart(o),
    comp({ key: "freight", label: "Provider quote", status: "known", currency: cur, minor: q.amountMinor, note: `Quote ${q.reference}`, source: src }),
    q.includesCustoms
      ? comp({ key: "customs", label: "Customs and import tax", status: "included", currency: cur, note: "The quote says it covers these.", source: src })
      : customs(provider),
    q.includesDelivery
      ? comp({ key: "kenya_delivery", label: "Delivery in Kenya", status: "included", currency: cur, note: "The quote says it covers this.", source: src })
      : kenyaDelivery(provider, "door"),
  ];
  return parts;
}

const compact = (cs: (Component | null)[]) => cs.filter((c): c is Component => c !== null);

function drafts(i: Inputs): Draft[] {
  const out: Draft[] = [];
  for (const o of i.offers) {
    if (o.route === "paypal") {
      const priced = o.shippingMinor !== null;
      out.push({ offer: o, route: "local", provider: "demo", mode: "local", availability: "available",
        why: priced ? "Delivery is priced by the seller." : "Delivery is not priced yet.",
        parts: [itemPart(o), priced
          ? comp({ key: "kenya_delivery", label: "Delivery", status: "known", currency: o.currency, minor: o.shippingMinor!, source: `${o.seller} listing` })
          : kenyaDelivery("kentex", i.prefs.handling)] });
      continue;
    }
    const store = i.quotes.find((q) => q.offerId === o.id && q.provider === "store");
    out.push({ offer: o, route: "direct", provider: "store", mode: "direct", availability: store ? "available" : "needs_quote", quoteKey: "store:direct",
      why: store ? "Store shipping quote you added." : "Ask the store whether it ships to Kenya; Channel3 does not say.",
      parts: store ? [itemPart(o), comp({ key: "kenya_delivery", label: "Shipping and import charges", status: "known", currency: store.currency, minor: store.amountMinor,
        note: `Quote ${store.reference}`, source: `${o.seller} quote` }),
        store.includesCustoms ? comp({ key: "customs", label: "Customs and import tax", status: "included", currency: store.currency, source: `${o.seller} quote` })
          : comp({ key: "customs", label: "Customs and import tax", status: "unknown", currency: o.currency, note: "Not stated by the store.", source: `${o.seller} quote` })]
        : [itemPart(o), comp({ key: "kenya_delivery", label: "Shipping to Kenya", status: "unknown", currency: o.currency, source: `${o.seller} listing` }),
          comp({ key: "customs", label: "Customs and import tax", status: "unknown", currency: o.currency, source: `${o.seller} listing` })] });

    const us = o.currency === "USD";
    const uk = o.currency === "GBP";
    const forward = (provider: Provider, mode: Mode, avail: Plan["availability"], why: string, parts: Component[]) =>
      out.push({ offer: o, route: "forward", provider, mode, availability: avail, why, parts, quoteKey: `${provider}:${mode}` });

    if (!us && !uk) continue;
    const aq = (mode: "self_buy" | "buy_for_me") => {
      const fp = freight("aquantuo", i.parcel, uk ? "uk" : "us");
      const parts = mode === "buy_for_me" ? [itemPart(o), buyForMeFee(o.priceMinor, o.currency), fp, customs("aquantuo"), kenyaDelivery("aquantuo", i.prefs.handling)]
        : [itemPart(o), domestic(o), fp, customs("aquantuo"), kenyaDelivery("aquantuo", i.prefs.handling)];
      forward("aquantuo", mode, "available", uk ? "UK to Kenya lane; the rate is unconfirmed." : "US to Kenya lane.", parts);
    };
    aq("self_buy"); aq("buy_for_me");

    const amazon = amazonUsListing(o.url);
    if (us) {
      if (amazon) forward("kentex", "amazon_buy_ship", "available", "Eligible Amazon.com listing. Use Kentex's Amazon quote with this exact link and variant.",
        compact([itemPart(o), salesTax(o.currency), kentexServiceFee(o.priceMinor), freight("kentex", i.parcel), kentexInsurance(o.priceMinor), customs("kentex"), kenyaDelivery("kentex", i.prefs.handling)]));
      else forward("kentex", "amazon_buy_ship", "ineligible", "Kentex's Amazon tool needs an amazon.com product link. This listing is not one.", [itemPart(o)]);
      forward("kentex", "forwarding", "available", "US warehouse forwarding. Quote first, then buy.",
        compact([itemPart(o), domestic(o), freight("kentex", i.parcel), kentexInsurance(o.priceMinor), customs("kentex"), kenyaDelivery("kentex", i.prefs.handling)]));
    } else {
      forward("kentex", "forwarding", "ineligible", "Kentex ships from US warehouses only; this is a UK listing.", [itemPart(o)]);
    }
  }
  return out;
}

function underBudget(parts: Component[], kes: Plan["kes"], complete: boolean, prefs: Prefs): Plan["underBudget"] {
  const budget = prefs.budgetKesMinor;
  if (budget === undefined) return "unknown";
  // A budget that excludes delivery is compared with the item alone
  const counted = prefs.budgetIncludesDelivery === false ? parts.filter((c) => c.key === "item") : parts;
  const k = prefs.budgetIncludesDelivery === false ? sumKnown(counted).kes : kes;
  if (!k) return "unknown";
  if (k.low > budget) return "no";
  const all = prefs.budgetIncludesDelivery === false ? counted.every(isPriced) : complete;
  return all && k.high <= budget ? "yes" : "unknown";
}

export function buildPlans(i: Inputs): Plan[] {
  return drafts(i).map((d) => {
    const provider = d.provider;
    const q = d.quoteKey && provider !== "store"
      ? i.quotes.find((x) => x.offerId === d.offer.id && x.provider === provider && x.mode === d.mode) : undefined;
    const expired = !!q?.expiresAt && new Date(q.expiresAt) <= i.now;
    const usable = q && !expired && (provider === "aquantuo" || provider === "kentex");
    const parts = usable ? quotedParts(d.offer, q, provider as Provider) : d.parts;
    const complete = d.availability === "available" && parts.every(isPriced);
    const sums = sumKnown(parts);
    const kes = sums.kes ? { low: sums.kes.low, high: sums.kes.high } : null;
    const under = underBudget(parts, kes, complete, i.prefs);
    const info = (d.provider === "aquantuo" || d.provider === "kentex") && d.availability === "available"
      ? handoffFor(d.provider, d.mode as Mode, d.offer, i.destination, i.parcel, i.prefs) : null;
    return {
      id: `${d.offer.id}:${d.provider}:${d.mode}`, offerId: d.offer.id, route: d.route, provider: d.provider, mode: d.mode,
      title: TITLES[d.mode] ?? (d.route === "local" ? `Buy from ${d.offer.seller}` : `Buy at ${d.offer.seller}`),
      exact: d.offer.exact, availability: d.availability, why: usable ? `Uses your ${provider} quote.` : q && expired ? "Your saved quote has expired. Get a fresh one." : d.why,
      components: parts, complete, knownMinor: sums.single?.low ?? null, knownHighMinor: sums.single?.high ?? null,
      knownCurrency: sums.single?.cur ?? null, kes, underBudget: under,
      quote: q ? { reference: q.reference, expired, expiresAt: q.expiresAt } : null,
      handoff: info, payments: PAYMENTS[d.mode as string] ?? PAYMENTS.direct,
    } satisfies Plan;
  });
}

// The only way to be called cheapest: exact, available, fully priced
export function cheapestDelivered(plans: Plan[]): string | null {
  const ok = plans.filter((p) => p.exact && p.availability === "available" && p.complete && p.kes);
  ok.sort((a, b) => a.kes!.high - b.kes!.high || a.kes!.low - b.kes!.low);
  return ok[0]?.id ?? null;
}

export const kesFor = toKes;
export const fxSource = RULES.fx.source;

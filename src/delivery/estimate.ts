import { toKes, type FxTable } from "./fx";
import { AQUANTUO_CM3_PER_KG, AQUANTUO_CM3_PER_KG_LOW, chargeableKg, KENTEX_CM3_PER_KG, type ParcelEstimate } from "./packaging";
import { comp, RULES } from "./rules";
import type { Component, Handling } from "./types";

const pct = (minor: number, p: number) => Math.round((minor * p) / 100);
const bp = (minor: number, b: number) => Math.round((minor * b) / 10_000);
const kg = (n: number) => `${n.toFixed(1)} kg`;

export type Hub = "texas" | "delaware" | "unknown";

// Freight range from the packed parcel estimate; the high end is what we
// would charge up front, the low end what a tight repack could cost
export function freight(provider: "aquantuo" | "kentex", p: ParcelEstimate, lane: "us" | "uk", hub: Hub = "unknown"): Component {
  const uk = provider === "aquantuo" && lane === "uk";
  const rate = uk ? RULES.aquantuo.ukAirUsdPerKgMinor : RULES[provider].airUsdPerKgMinor;
  const div = provider === "kentex" ? KENTEX_CM3_PER_KG : AQUANTUO_CM3_PER_KG;
  const lo = chargeableKg(p.low, provider === "kentex" ? div : AQUANTUO_CM3_PER_KG_LOW), hi = chargeableKg(p.high, div);
  let low = Math.round(lo * rate), high = Math.round(hi * rate);
  const notes = [`${kg(lo)} to ${kg(hi)} billed weight. ${p.note}`];
  if (provider === "kentex") {
    const m = RULES.kentex.minimumUsdMinor;
    low = Math.max(low, hub === "delaware" ? m.delaware : m.texas);
    high = Math.max(high, hub === "texas" ? m.texas : m.delaware);
    if (hub === "unknown") notes.push("Minimum is $50 from Texas or $100 from Delaware; we assume the higher until the warehouse is known.");
  } else notes.push("Aquantuo's pages give two volume divisors (6,000 and 5,000 cm3 per kg); the range covers both until Aquantuo confirms.");
  return comp({ key: "freight", label: "Air freight to Kenya", status: "estimated", currency: "USD", minor: low, highMinor: Math.max(low, high),
    confidence: p.confidence, note: notes.join(" "), source: uk ? RULES.aquantuo.ukSource : RULES[provider].source });
}

export const fee = (label: string, itemMinor: number, currency: string, p: number, source: string, note: string): Component =>
  comp({ key: "buy_fee", label, status: "estimated", currency, minor: pct(itemMinor, p), confidence: "high", note, source });

export const amazonTax = (itemMinor: number): Component =>
  comp({ key: "sales_tax", label: "Texas sales tax", status: "estimated", currency: "USD", minor: bp(itemMinor, RULES.kentex.texasSalesTaxBp),
    confidence: "high", note: "8.25% of the item price.", source: RULES.kentex.amazonSource });

export const storeTaxAndDelivery = (itemMinor: number): Component => {
  const r = RULES.usStore;
  return comp({ key: "sales_tax", label: "US sales tax and store delivery", status: "estimated", currency: "USD",
    minor: bp(itemMinor, r.taxBp[0]) + r.deliveryUsdMinor[0], highMinor: bp(itemMinor, r.taxBp[1]) + r.deliveryUsdMinor[1],
    confidence: "low", note: "Set at the store's checkout; this is a typical range.", source: r.source });
};

// Kentex insurance: required over $200; optional at or below on the Amazon tool
export function kentexInsurance(itemMinor: number, source: string): Component {
  if (itemMinor > RULES.kentex.insuranceThresholdMinor)
    return comp({ key: "insurance", label: "Freight insurance", status: "estimated", currency: "USD", minor: pct(itemMinor, RULES.kentex.insurancePct),
      confidence: "high", note: "5% of the item price, required over $200.", source });
  return comp({ key: "insurance", label: "Freight insurance", status: "not_applicable", currency: "USD",
    note: "Optional at $200 or less (5% of the item price).", source });
}

export const customs = (provider: "aquantuo" | "kentex", lane: "us" | "uk" = "us"): Component => provider === "aquantuo" && lane === "us"
  ? comp({ key: "customs", label: "Customs and import tax", status: RULES.aquantuo.usCustoms, currency: "USD", confidence: "medium",
      note: RULES.aquantuo.usCustomsNote, source: "aquantuo.com/faq/price-change-in-kenya, per Nathan 2026-11-12 (N)" })
  : comp({ key: "customs", label: "Customs and import tax", status: RULES[provider].customs, currency: "USD",
      confidence: provider === "kentex" ? "medium" : undefined, note: RULES[provider].customsNote, source: RULES[provider].source });

export function kenyaDelivery(provider: "aquantuo" | "kentex", handling: Handling, p: ParcelEstimate): Component {
  if (provider === "aquantuo")
    return comp({ key: "kenya_delivery", label: handling === "door" ? "Delivery in Kenya" : "Pickup in Kenya", status: "unknown", currency: "KES",
      note: "Aquantuo's Kenya delivery terms are not confirmed.", source: RULES.aquantuo.source });
  if (handling === "pickup")
    return comp({ key: "kenya_delivery", label: "Pickup in Nairobi", status: "known", currency: "KES", minor: 0, confidence: "high",
      note: RULES.kentex.pickupNote, source: RULES.kentex.source });
  const d = RULES.door, k = chargeableKg(p.high, KENTEX_CM3_PER_KG);
  return comp({ key: "kenya_delivery", label: "Delivery to your door", status: "estimated", currency: "KES",
    minor: d.kesBaseMinor[0] + Math.round(chargeableKg(p.low, KENTEX_CM3_PER_KG) * d.kesPerKgMinor[0]),
    highMinor: d.kesBaseMinor[1] + Math.round(k * d.kesPerKgMinor[1]), confidence: "low",
    note: "Kentex bills door delivery by weight and publishes no fee. This is our estimate.", source: d.source });
}

export function sumKnown(cs: Component[], fx: FxTable) {
  const parts = cs.flatMap((c) => {
    if ((c.status === "known" || c.status === "estimated") && c.minor !== undefined) return [{ cur: c.currency, low: c.minor, high: c.highMinor ?? c.minor }];
    if (c.status === "unknown" && c.lowMinor !== undefined) return [{ cur: c.currency, low: c.lowMinor, high: c.lowMinor }];
    return [];
  });
  if (!parts.length) return { single: null, kes: null };
  const curs = new Set(parts.map((p) => p.cur));
  const cur = [...curs][0];
  const single = curs.size === 1
    ? { cur, low: parts.reduce((a, p) => a + p.low, 0), high: parts.reduce((a, p) => a + p.high, 0) } : null;
  let low = 0, high = 0;
  for (const p of parts) {
    const lo = toKes(p.low, p.cur, fx), hi = toKes(p.high, p.cur, fx);
    if (!lo || !hi) return { single, kes: null };
    low += lo.low; high += hi.high;
  }
  return { single, kes: { low, high } };
}

export const isPriced = (c: Component) => c.status !== "unknown";

// Weakest confidence among priced parts decides the label
export function overallConfidence(cs: Component[]): "high" | "medium" | "low" {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return cs.reduce<"high" | "medium" | "low">((w, c) => (c.confidence && rank[c.confidence] > rank[w] ? c.confidence : w), "high");
}

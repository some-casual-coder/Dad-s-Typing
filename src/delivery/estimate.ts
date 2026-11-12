import { comp, RULES, toKes } from "./rules";
import type { Component, Parcel } from "./types";

const MM_PER_INCH = 25.4;
const SRC = { aquantuo: RULES.aquantuo.source, kentex: RULES.kentex.source };

export function volumetricKg(p: Parcel): number | null {
  if (!p.lengthMm || !p.widthMm || !p.heightMm) return null;
  const cubicInches = (p.lengthMm / MM_PER_INCH) * (p.widthMm / MM_PER_INCH) * (p.heightMm / MM_PER_INCH);
  return cubicInches / RULES.kentex.volumetricInchesDivisor;
}

const missingDims = (p: Parcel) => !p.lengthMm || !p.widthMm || !p.heightMm;

// Freight in USD from a dated rate; never a firm number without packed data
export function freight(provider: "aquantuo" | "kentex", p: Parcel, lane: "us" | "uk" = "us"): Component {
  const rate = provider === "aquantuo" && lane === "uk" ? RULES.aquantuo.ukAirUsdPerKgMinor : RULES[provider].airUsdPerKgMinor;
  const unconfirmed = provider === "aquantuo" && lane === "uk" ? " UK rate is unconfirmed." : "";
  const base = { key: "freight" as const, label: "International freight", currency: "USD", source: SRC[provider] };
  if (!p.weightGrams) {
    return comp({ ...base, status: "unknown", note: "Needs the packed weight and box size." });
  }
  const actualKg = p.weightGrams / 1000;
  const mins = provider === "kentex" ? RULES.kentex.minimumUsdMinor : {};
  const floorMin = Math.min(...Object.values(mins), 0);
  if (missingDims(p)) {
    return comp({ ...base, status: "unknown", lowMinor: Math.max(Math.round(actualKg * rate), floorMin),
      note: `From the actual weight only. Box size can raise it.${unconfirmed}` });
  }
  const volKg = volumetricKg(p) ?? 0;
  const kg = Math.max(actualKg, volKg);
  const raw = Math.round(kg * rate);
  const note = `${kg.toFixed(2)} kg billed (${volKg > actualKg ? "box size" : "actual weight"}). Warehouse reweigh can change it.`;
  if (provider === "aquantuo") return comp({ ...base, status: "estimated", minor: raw, note: `${note} Aquantuo's volume divisor is unconfirmed.${unconfirmed}` });
  const m = RULES.kentex.minimumUsdMinor;
  const hub = p.hub ? m[p.hub] : undefined;
  if (hub !== undefined) return comp({ ...base, status: "estimated", minor: Math.max(raw, hub), note });
  return comp({ ...base, status: "estimated", minor: Math.max(raw, m.texas), highMinor: Math.max(raw, m.delaware),
    note: `${note} Minimum depends on the warehouse: $50 Texas, $100 Delaware.` });
}

export const kentexServiceFee = (itemMinor: number): Component =>
  comp({ key: "buy_fee", label: "Kentex service fee", status: "estimated", currency: "USD", minor: Math.round(itemMinor * RULES.kentex.assistedFeePct / 100),
    note: `${RULES.kentex.assistedFeePct}% of the item price only. A $5 minimum was reported but is not in the terms.`, source: SRC.kentex });

export const salesTax = (currency: string): Component =>
  comp({ key: "sales_tax", label: "US sales tax and store delivery", status: "unknown", currency,
    note: "Shown as a separate line in the provider's quote.", source: SRC.kentex });

export const kentexInsurance = (itemMinor: number): Component | null =>
  itemMinor > RULES.kentex.insuranceThresholdMinor
    ? comp({ key: "insurance", label: "Freight insurance", status: "estimated", currency: "USD", minor: Math.round(itemMinor * RULES.kentex.insurancePct / 100),
        note: `${RULES.kentex.insurancePct}% of item value, charged when items total over $200.`, source: SRC.kentex })
    : null;

export const buyForMeFee = (itemMinor: number, currency: string): Component =>
  comp({ key: "buy_fee", label: "Buy For Me fee", status: "estimated", currency, minor: Math.round(itemMinor * RULES.aquantuo.buyForMeFeePct / 100),
    note: `${RULES.aquantuo.buyForMeFeePct}% of the item price, from a second-hand source.`, source: SRC.aquantuo });

export const customs = (provider: "aquantuo" | "kentex"): Component =>
  comp({ key: "customs", label: "Customs and import tax", status: RULES[provider].customs, currency: "USD",
    note: RULES[provider].customsNote, source: SRC[provider] });

export const kenyaDelivery = (provider: "aquantuo" | "kentex", handling: "pickup" | "door"): Component =>
  comp({ key: "kenya_delivery", label: handling === "door" ? "Delivery in Kenya" : "Pickup in Kenya", status: "unknown", currency: "USD",
    note: handling === "door" ? "The provider has not published a fee we can use." : "Pickup point and any fee are not confirmed.", source: SRC[provider] });

export function sumKnown(cs: Component[]) {
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
    const lo = toKes(p.low, p.cur), hi = toKes(p.high, p.cur);
    if (!lo || !hi) return { single, kes: null };
    low += lo.low; high += hi.high;
  }
  return { single, kes: { low, high } };
}

export const isPriced = (c: Component) => c.status !== "unknown";

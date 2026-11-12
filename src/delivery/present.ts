import { formatRange } from "./eta";
import type { Plan } from "./types";

// What the shopper sees: one card per listing, its chosen method, a delivered
// KES figure, a date and one line on how it differs. Facts are computed here;
// nothing in a sentence comes from the model.
export interface Card {
  planId: string; offerId: string; title: string; seller: string; imageUrl: string | null;
  price: string | null; arrival: string | null; difference: string; method: string; provider: string;
  confidence: Plan["confidence"]; complete: boolean; winner: boolean; closest: boolean; quoteRequired: boolean;
  underBudget: Plan["underBudget"];
  // Other ways to get the same listing, for "other ways"
  others: string[];
}
export interface Cards { closest: Card[]; similar: Card[]; more: Card[]; recommendation: string | null;
  // Listings no route can take, with the rule that stopped them
  blocked: { title: string; reason: string }[] }

const MAX_SHOWN = 3;
const roundKes = (minor: number) => Math.round(minor / 10_000) * 100;
const ksh = (minor: number) => `KSh ${roundKes(minor).toLocaleString("en-KE")}`;

// One number unless the range is wide enough to matter
export function priceText(kes: Plan["kes"]): string | null {
  if (!kes) return null;
  if (kes.high <= kes.low * 1.15) return `about ${ksh(kes.high)}`;
  return `${ksh(kes.low)} to ${roundKes(kes.high).toLocaleString("en-KE")}`;
}

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime() / 86_400_000;

export function difference(p: Plan, ref: Plan | null): string {
  if (p.provider === "demo") return "Demo inventory for the sandbox, not a verified Kenyan shop.";
  if (p.availability === "needs_quote" && p.route === "forward") return p.why;
  if (!p.complete) return "Delivery cost to Kenya is not confirmed yet.";
  if (!ref || ref.id === p.id) return p.exact ? "Closest to what you sent." : "Similar to what you sent.";
  const bits: string[] = [];
  if (p.item.brand && ref.item.brand && p.item.brand.toLowerCase() !== ref.item.brand.toLowerCase()) bits.push("Different brand");
  if (p.item.longestMm && ref.item.longestMm) {
    const cm = Math.round((p.item.longestMm - ref.item.longestMm) / 10);
    if (Math.abs(cm) >= 2) bits.push(`${Math.abs(cm)} cm ${cm < 0 ? "smaller" : "bigger"}`);
  }
  if (p.kes && ref.kes) {
    const d = roundKes(p.kes.high) - roundKes(ref.kes.high);
    // Overlapping ranges only differ in their worst case, so say so
    const overlap = p.kes.low <= ref.kes.high && ref.kes.low <= p.kes.high;
    const amt = `KSh ${Math.abs(d).toLocaleString("en-KE")}`;
    if (Math.abs(d) >= 500) bits.push(overlap ? `up to ${amt} ${d < 0 ? "less" : "more"}` : `${amt} ${d < 0 ? "cheaper" : "dearer"}`);
  }
  if (p.eta && ref.eta) {
    const d = day(p.eta.latest) - day(ref.eta.latest);
    if (Math.abs(d) >= 3) bits.push(`${Math.abs(d)} days ${d < 0 ? "sooner" : "later"}`);
  }
  if (!bits.length) return p.exact ? "Same kind of item, similar price." : "Similar item, similar price.";
  const line = bits.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

const rank = (a: Plan, b: Plan) =>
  Number(b.complete) - Number(a.complete) || (a.kes?.high ?? 9e15) - (b.kes?.high ?? 9e15) || (a.eta?.latest ?? "9").localeCompare(b.eta?.latest ?? "9");

export function present(plans: Plan[], cheapestId: string | null): Cards {
  const byOffer = new Map<string, Plan[]>();
  for (const p of plans) if (p.availability !== "ineligible") byOffer.set(p.offerId, [...(byOffer.get(p.offerId) ?? []), p]);
  // The winner's own method leads its listing; otherwise the auto-chosen one
  const lead = [...byOffer.values()].map((ps) => ps.find((p) => p.id === cheapestId) ?? ps.find((p) => p.primary) ?? ps[0]);
  const closest = lead.filter((p) => p.exact).sort((a, b) => Number(b.id === cheapestId) - Number(a.id === cheapestId) || rank(a, b));
  const similar = lead.filter((p) => !p.exact).sort(rank);
  const ref = closest[0] ?? similar[0] ?? null;
  const card = (p: Plan): Card => ({
    planId: p.id, offerId: p.offerId, title: p.item.title, seller: p.item.seller, imageUrl: p.item.imageUrl,
    price: p.complete ? priceText(p.kes) : null, arrival: p.eta ? formatRange(p.eta.earliest, p.eta.latest) : null,
    difference: difference(p, ref), method: p.title, provider: p.provider, confidence: p.confidence, complete: p.complete,
    winner: p.id === cheapestId, closest: p.exact, quoteRequired: p.availability === "needs_quote", underBudget: p.underBudget,
    others: (byOffer.get(p.offerId) ?? []).filter((x) => x.id !== p.id && x.availability === "available").map((x) => x.id),
  });
  const shownC = closest.slice(0, MAX_SHOWN), shownS = similar.slice(0, MAX_SHOWN);
  const blocked = [...new Set(plans.map((p) => p.offerId))].filter((id) => !byOffer.has(id)).map((id) => {
    const p = plans.find((x) => x.offerId === id)!;
    return { title: p.item.title, reason: p.why };
  });
  return {
    blocked,
    closest: shownC.map(card), similar: shownS.map(card),
    more: [...closest.slice(MAX_SHOWN), ...similar.slice(MAX_SHOWN)].map(card),
    recommendation: recommend(shownC, shownS, cheapestId),
  };
}

function recommend(closest: Plan[], similar: Plan[], cheapestId: string | null): string | null {
  const first = closest[0];
  if (!first) return similar.length ? "I couldn't find the exact item. These are similar; check the differences before choosing." : null;
  if (first.id !== cheapestId || !first.kes) return "None of these has a full delivered price yet. The first one is the closest match.";
  const why = ["closest match"];
  if (first.eta) why.push(`arrives ${formatRange(first.eta.earliest, first.eta.latest)}`);
  const next = closest.slice(1).find((p) => p.complete && p.kes);
  if (next?.kes) {
    const d = roundKes(next.kes.high) - roundKes(first.kes.high);
    if (d >= 500) why.push(next.kes.low < first.kes.high ? "the lowest worst-case price"
      : `KSh ${d.toLocaleString("en-KE")} cheaper than the next one`);
  }
  return `I'd get the first one: ${why.join(", ")}.`;
}

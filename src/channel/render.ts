import type { Card, Cards } from "@/delivery/present";
import { evaluate, type Attribute, type Requirement } from "@/domain/eligibility";

// Text renderings of engine state for chat channels: numbered replies and a
// signed link. Buttons can replace the numbers when a connector supports them.
const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g;
const shortDates = (s: string) => s.replace(MONTH, (m) => m.slice(0, 3)).replace(/^about /, "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// Chat can't confirm a requirement, so what the shopper just asked for (still
// only proposed) filters the numbered options: a clear mismatch is never offered,
// and an offer with unknown details only when nothing is known to match
export function menuCards(c: Cards, max: number, proposed: Requirement[] = [], attrs: Map<string, Record<string, Attribute>> = new Map()): Card[] {
  const all = [...c.closest, ...c.similar];
  const reqs = proposed.filter((r) => r.essential);
  if (!reqs.length) return all.slice(0, max);
  const status = (x: Card) => evaluate(reqs, attrs.get(x.offerId) ?? {}).status;
  const fit = all.filter((x) => status(x) === "eligible");
  return (fit.length ? fit : all.filter((x) => status(x) === "unresolved")).slice(0, max);
}

// Clipped titles that come out the same keep the words that tell them apart
// ("…Skylift… 45 cm" and "…Skylift… 55 cm"), so a numbered choice is never a guess
export function optionLabels(titles: string[], n: number): string[] {
  const out = titles.map((t) => clip(t, n));
  return out.map((l, i) => {
    const twin = out.findIndex((o, j) => j !== i && o === l);
    if (twin < 0) return l;
    const a = titles[i].split(" "), b = titles[twin].split(" ");
    let k = 0;
    while (k < a.length && a[k] === b[k]) k++;
    const tail = clip(a.slice(k).join(" "), n - 9);
    return tail ? `${clip(a.slice(0, k).join(" "), n - tail.length - 1)} ${tail}` : l;
  });
}

// With a budget, each option says whether it fits, and the list says so when none does
export function renderOptions(cards: Card[], head: string, compact: boolean, budgetKes?: number): string {
  if (!cards.length) return "";
  const names = optionLabels(cards.map((c) => c.title), compact ? 28 : 48);
  const lines = cards.map((c, i) => {
    const price = c.price ? c.price.replace(/^about /, "") : c.quoteRequired ? "quote required" : "delivery cost not confirmed";
    const date = c.arrival ? `, arrives ${shortDates(c.arrival)}` : "";
    const note = compact ? "" : ` ${c.winner ? "Best delivered price." : c.difference}`;
    const demo = c.provider === "demo" ? " (demo seller)" : "";
    const fit = budgetKes && c.underBudget === "yes" ? " Within your budget." : budgetKes && c.underBudget === "no" ? " Over your budget." : "";
    return `${i + 1}) ${names[i]}${demo}: ${price}${date}.${note}${fit}`;
  });
  if (budgetKes && !cards.some((c) => c.underBudget === "yes"))
    head = `Nothing I found fits KSh ${budgetKes.toLocaleString("en-KE")} once delivery to Kenya is added. The closest:\n${head}`;
  const pick = cards.length === 1 ? "Reply 1 to choose it." : `Reply ${cards.map((_, i) => i + 1).join(", ").replace(/, (\d)$/, " or $1")} to choose.`;
  return [head, ...lines, pick].join("\n");
}

export function renderChosen(o: { title: string; totalMinor: number; currency: string; concierge: boolean; arrival: string | null; kes: string | null }, link: string): string {
  const amt = `${o.currency} ${(o.totalMinor / 100).toFixed(2)}`;
  const pay = o.concierge
    ? `One payment of up to ${amt}${o.kes ? ` (${o.kes})` : ""} covers the item, fees, flight and delivery. We refund any difference after it is weighed.`
    : `One payment of ${amt} covers the item and delivery.`;
  return [`You chose ${clip(o.title, 60)}.`, pay, o.arrival ? `Arrives ${o.arrival}.` : "", `Pay securely here: ${link}`].filter(Boolean).join("\n");
}

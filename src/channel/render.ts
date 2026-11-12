import type { Card, Cards } from "@/delivery/present";

// Text renderings of engine state for chat channels: numbered replies and a
// signed link. Buttons can replace the numbers when a connector supports them.
const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g;
const shortDates = (s: string) => s.replace(MONTH, (m) => m.slice(0, 3)).replace(/^about /, "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function menuCards(c: Cards, max: number): Card[] {
  return [...c.closest, ...c.similar].slice(0, max);
}

export function renderOptions(cards: Card[], where: string | null, compact: boolean): string {
  if (!cards.length) return "";
  const head = where ? `Delivered to ${where}:` : "Delivered to Kenya:";
  const lines = cards.map((c, i) => {
    const price = c.price ? c.price.replace(/^about /, "") : "delivery cost not confirmed";
    const date = c.arrival ? `, arrives ${shortDates(c.arrival)}` : "";
    const note = compact ? "" : ` ${c.winner ? "Best delivered price." : c.difference}`;
    const demo = c.provider === "demo" ? " (demo seller)" : "";
    return `${i + 1}) ${clip(c.title, compact ? 28 : 48)}${demo}: ${price}${date}.${note}`;
  });
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

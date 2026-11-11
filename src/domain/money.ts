// Integer minor units; decimal strings only at the edges
const EXP: Record<string, number> = { USD: 2, GBP: 2, EUR: 2, KES: 2 };

export function exponent(currency: string): number {
  const e = EXP[currency];
  if (e === undefined) throw new Error(`unsupported currency ${currency}`);
  return e;
}

export function toDecimalString(minor: number, currency: string): string {
  const e = exponent(currency);
  const neg = minor < 0 ? "-" : "";
  const s = String(Math.abs(minor)).padStart(e + 1, "0");
  return `${neg}${s.slice(0, -e)}.${s.slice(-e)}`;
}

export function fromDecimalString(value: string, currency: string): number {
  const e = exponent(currency);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m || (m[2]?.length ?? 0) > e) throw new Error(`invalid amount ${value}`);
  return Number(m[1]) * 10 ** e + Number((m[2] ?? "").padEnd(e, "0") || 0);
}

export const orderTotal = (itemMinor: number, shippingMinor: number) => itemMinor + shippingMinor;

interface Quote { unitPriceMinor: number; shippingMinor: number | null; currency: string }
interface LiveOffer { unit_price_minor: number; shipping_minor: number | null; currency: string; availability: string }

export const quoteUnchanged = (snap: Quote, live: LiveOffer | undefined) =>
  !!live && live.availability === "InStock" && live.unit_price_minor === snap.unitPriceMinor &&
  live.shipping_minor === snap.shippingMinor && live.currency === snap.currency;

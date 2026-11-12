export interface FxRate {
  currency: string;
  // KES per one unit of currency, times 1,000,000
  kesPerUnitMicro: number;
  source: string;
  rateDate: string;
  fetchedAt: string;
  // True when the live source failed and an older or fallback rate is used
  stale: boolean;
}

export type FxTable = Record<string, FxRate>;

export const FX_SOURCE = "Central Bank of Kenya indicative rate via api.frankfurter.dev";

// Buffer for card conversion and movement before payment; second-hand figures
// from docs/RESEARCH_FOLLOWUP_FX_DELIVERY.md, to be replaced by observed spread
export const FX_BUFFER_PCT: Record<string, number> = { USD: 5, GBP: 7 };

// Used only when no live or stored rate exists; never presented as current
export const FALLBACK_FX: FxTable = {
  USD: { currency: "USD", kesPerUnitMicro: 129_000_000, source: "Offline fallback, not a market rate", rateDate: "2026-11-11", fetchedAt: "2026-11-12T00:00:00Z", stale: true },
  GBP: { currency: "GBP", kesPerUnitMicro: 168_000_000, source: "Offline fallback, not a market rate", rateDate: "2026-11-11", fetchedAt: "2026-11-12T00:00:00Z", stale: true },
};

const KES: FxRate = { currency: "KES", kesPerUnitMicro: 1_000_000, source: "same currency", rateDate: "", fetchedAt: "", stale: false };

// Minor units on both sides are hundredths, so the micro-rate applies directly
export function convertMinor(minor: number, rate: FxRate): number {
  const v = (BigInt(minor) * BigInt(rate.kesPerUnitMicro) + BigInt(500_000)) / BigInt(1_000_000);
  return Number(v);
}

export function toKes(minor: number, currency: string, fx: FxTable): { low: number; high: number } | null {
  const rate = currency === "KES" ? KES : fx[currency];
  if (!rate) return null;
  const low = convertMinor(minor, rate);
  const buffer = currency === "KES" ? 0 : FX_BUFFER_PCT[currency] ?? 10;
  return { low, high: Math.round(low * (1 + buffer / 100)) };
}

export const fxLabel = (fx: FxTable) => {
  const rs = Object.values(fx);
  if (!rs.length) return "No exchange rate";
  const stale = rs.some((r) => r.stale);
  const parts = rs.map((r) => `1 ${r.currency} = KSh ${(r.kesPerUnitMicro / 1e6).toFixed(2)}`).join(", ");
  return `${parts} (${rs[0].source}, ${rs[0].rateDate})${stale ? ", may be out of date" : ""}`;
};

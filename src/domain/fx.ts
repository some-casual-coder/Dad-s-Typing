import { getFx } from "@/adapters";
import { FALLBACK_FX, type FxRate, type FxTable } from "@/delivery/fx";
import { pool } from "./db";

const FRESH_MS = 6 * 3600_000;
const CURRENCIES = ["USD", "GBP"] as const;

async function stored(currency: string): Promise<FxRate | null> {
  const r = (await pool.query(
    `SELECT rate_micro, source, rate_date::text AS rate_date, fetched_at FROM fx_rates WHERE currency=$1 AND quote='KES' ORDER BY fetched_at DESC LIMIT 1`,
    [currency],
  )).rows[0];
  if (!r) return null;
  return { currency, kesPerUnitMicro: Number(r.rate_micro), source: r.source, rateDate: r.rate_date,
    fetchedAt: new Date(r.fetched_at).toISOString(), stale: false };
}

async function fresh(currency: "USD" | "GBP", now: Date): Promise<FxRate> {
  const last = await stored(currency);
  if (last && now.getTime() - new Date(last.fetchedAt).getTime() < FRESH_MS) return last;
  try {
    const live = await getFx().kesRate(currency);
    const micro = Math.round(live.rate * 1e6);
    await pool.query(
      `INSERT INTO fx_rates (currency,quote,rate_micro,source,rate_date,fetched_at) VALUES ($1,'KES',$2,$3,$4,$5)
       ON CONFLICT (currency,quote,source,rate_date) DO UPDATE SET rate_micro=EXCLUDED.rate_micro, fetched_at=EXCLUDED.fetched_at`,
      [currency, micro, live.source, live.date, now.toISOString()],
    );
    return { currency, kesPerUnitMicro: micro, source: live.source, rateDate: live.date, fetchedAt: now.toISOString(), stale: false };
  } catch {
    console.warn("fx_unavailable");
    return last ? { ...last, stale: true } : FALLBACK_FX[currency];
  }
}

// Rates with source and date, so every quote can record what it used
export async function currentFx(now = new Date()): Promise<FxTable> {
  const rs = await Promise.all(CURRENCIES.map((c) => fresh(c, now)));
  return Object.fromEntries(rs.map((r) => [r.currency, r]));
}

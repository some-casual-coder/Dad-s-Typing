import { randomUUID } from "node:crypto";
import { AQUANTUO_CM3_PER_KG, chargeableKg, KENTEX_CM3_PER_KG, type ParcelEstimate } from "@/delivery/packaging";
import type { Tx } from "./db";

const div = (p: "kentex" | "aquantuo") => (p === "kentex" ? KENTEX_CM3_PER_KG : AQUANTUO_CM3_PER_KG);

// Logged when a parcel estimate is relied on for money; first write wins
export async function recordEstimate(c: Tx, taskId: string, offerId: string, provider: "kentex" | "aquantuo", e: ParcelEstimate, itemGrams?: number) {
  await c.query(
    `INSERT INTO parcel_calibration (id,task_id,offer_id,provider,kind,basis,item_grams,est_low_grams,est_high_grams,est_chargeable_low_grams,est_chargeable_high_grams)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (task_id,offer_id,provider) DO NOTHING`,
    [randomUUID(), taskId, offerId, provider, e.kind.slice(0, 40), e.basis, itemGrams ?? null, e.low.grams, e.high.grams,
      Math.round(chargeableKg(e.low, div(provider)) * 1000), Math.round(chargeableKg(e.high, div(provider)) * 1000)],
  );
}

// From a provider invoice or the operator; overwrites an earlier actual
export async function recordActual(c: Tx, taskId: string, offerId: string, provider: "kentex" | "aquantuo",
  actual: { grams: number; chargeableGrams: number; source: string }) {
  const r = await c.query(
    `UPDATE parcel_calibration SET actual_grams=$4, actual_chargeable_grams=$5, actual_source=$6, actual_at=now()
      WHERE task_id=$1 AND offer_id=$2 AND provider=$3`,
    [taskId, offerId, provider, actual.grams, actual.chargeableGrams, actual.source.slice(0, 120)],
  );
  return r.rowCount === 1;
}

// Share of orders whose actual chargeable weight landed within the estimate
export async function calibrationSummary(c: Tx, kind?: string) {
  const r = await c.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE actual_chargeable_grams <= est_chargeable_high_grams)::int AS within_high,
            avg(actual_chargeable_grams::float / est_chargeable_high_grams) AS ratio_to_high
       FROM parcel_calibration WHERE actual_chargeable_grams IS NOT NULL AND ($1::text IS NULL OR kind=$1)`,
    [kind ?? null],
  );
  return r.rows[0] as { n: number; within_high: number; ratio_to_high: number | null };
}

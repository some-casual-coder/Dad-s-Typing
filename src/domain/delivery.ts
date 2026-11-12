import { randomUUID } from "node:crypto";
import { buildPlans, cheapestDelivered, fxSource } from "@/delivery/compare";
import { RULES_AS_OF } from "@/delivery/rules";
import { isStep, nextAction, stepsFor } from "@/delivery/steps";
import type { Destination, ImportedQuote, Mode, OfferInput, Parcel, Prefs, Provider } from "@/delivery/types";
import { authorize } from "./access";
import { tx } from "./db";
import { DomainError } from "./errors";
import { logEvent } from "./events";
import { getComparison } from "./tasks";

export interface DeliveryInput {
  county: string; city: string; handling: "pickup" | "door";
  budgetKesMinor?: number | null; budgetIncludesDelivery?: boolean | null;
  weightGrams?: number | null; lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null;
  hub?: "texas" | "delaware" | null;
}

const PROVIDER_MODES: Record<string, string[]> = {
  aquantuo: ["self_buy", "buy_for_me"], kentex: ["amazon_buy_ship", "forwarding"], store: ["direct"],
};

const posInt = (v: unknown, max: number, name: string) => {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new DomainError("invalid", `${name} is invalid`);
  return v as number;
};

export async function saveDelivery(taskId: string, token: string, b: DeliveryInput) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    const text = (v: unknown, n: string) => {
      if (typeof v !== "string" || v.length > 80) throw new DomainError("invalid", `${n} is invalid`);
      return v.trim();
    };
    if (b.handling !== "pickup" && b.handling !== "door") throw new DomainError("invalid", "handling is invalid");
    if (b.hub != null && b.hub !== "texas" && b.hub !== "delaware") throw new DomainError("invalid", "hub is invalid");
    const bud = posInt(b.budgetKesMinor, 1e11, "budget");
    const incl = b.budgetIncludesDelivery ?? null;
    if (incl !== null && typeof incl !== "boolean") throw new DomainError("invalid", "budgetIncludesDelivery is invalid");
    await c.query(
      `INSERT INTO delivery_plans (task_id,county,city,handling,budget_kes_minor,budget_includes_delivery,weight_grams,length_mm,width_mm,height_mm,hub,updated_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (task_id) DO UPDATE SET county=$2,city=$3,handling=$4,budget_kes_minor=$5,budget_includes_delivery=$6,weight_grams=$7,
         length_mm=$8,width_mm=$9,height_mm=$10,hub=$11,updated_by=$12,updated_at=now()`,
      [taskId, text(b.county, "county"), text(b.city, "city"), b.handling, bud, incl, posInt(b.weightGrams, 100_000, "weight"),
        posInt(b.lengthMm, 3000, "length"), posInt(b.widthMm, 3000, "width"), posInt(b.heightMm, 3000, "height"), b.hub ?? null, g.id],
    );
    await logEvent(c, taskId, g.id, "delivery.updated", {});
    return { ok: true };
  });
}

export async function importQuote(taskId: string, token: string, b: {
  offerId: string; provider: string; mode: string; reference: string; amountMinor: number; currency: string;
  includesItem?: boolean; includesCustoms?: boolean; includesDelivery?: boolean; expiresAt?: string | null;
}) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    if (!PROVIDER_MODES[b.provider]?.includes(b.mode)) throw new DomainError("invalid", "That provider does not offer that service");
    if (typeof b.reference !== "string" || !b.reference.trim() || b.reference.length > 80) throw new DomainError("invalid", "reference is invalid");
    if (!Number.isInteger(b.amountMinor) || b.amountMinor < 0 || b.amountMinor > 1e9) throw new DomainError("invalid", "amount is invalid");
    if (typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)) throw new DomainError("invalid", "currency is invalid");
    let exp: string | null = null;
    if (b.expiresAt) {
      const d = new Date(b.expiresAt);
      if (Number.isNaN(d.getTime())) throw new DomainError("invalid", "expiry is invalid");
      exp = d.toISOString();
    }
    const o = (await c.query(`SELECT route FROM offers WHERE id=$1 AND task_id=$2`, [b.offerId, taskId])).rows[0];
    if (!o || o.route !== "external") throw new DomainError("not_found", "Offer not found");
    const flag = (v: unknown) => v === true;
    const id = randomUUID();
    const ins = await c.query(
      `INSERT INTO delivery_quotes (id,task_id,offer_id,provider,mode,reference,amount_minor,currency,includes_item,includes_customs,includes_delivery,expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (offer_id,provider,mode,reference) DO NOTHING RETURNING id`,
      [id, taskId, b.offerId, b.provider, b.mode, b.reference.trim(), b.amountMinor, b.currency, flag(b.includesItem), flag(b.includesCustoms), flag(b.includesDelivery), exp, g.id],
    );
    if (!ins.rowCount) {
      const same = await c.query(`SELECT 1 FROM delivery_quotes WHERE offer_id=$1 AND provider=$2 AND mode=$3 AND reference=$4 AND amount_minor=$5 AND currency=$6`,
        [b.offerId, b.provider, b.mode, b.reference.trim(), b.amountMinor, b.currency]);
      if (!same.rowCount) throw new DomainError("conflict", "That reference is already saved with different details");
    } else await logEvent(c, taskId, g.id, "delivery.quote_added", { provider: b.provider, mode: b.mode });
    return { ok: true };
  });
}

export async function markStep(taskId: string, token: string, b: { offerId: string; provider: string; mode: string; step: string; note?: string }) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    if (!PROVIDER_MODES[b.provider]?.includes(b.mode) || b.provider === "store") throw new DomainError("invalid", "That service has no steps");
    if (!isStep(b.step) || !stepsFor(b.mode)?.includes(b.step)) throw new DomainError("invalid", "That step is not part of this service");
    const o = (await c.query(`SELECT route FROM offers WHERE id=$1 AND task_id=$2`, [b.offerId, taskId])).rows[0];
    if (!o || o.route !== "external") throw new DomainError("not_found", "Offer not found");
    const note = typeof b.note === "string" ? b.note.slice(0, 200) : "";
    const r = await c.query(`INSERT INTO delivery_steps (task_id,offer_id,provider,mode,step,note,entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING RETURNING step`, [taskId, b.offerId, b.provider, b.mode, b.step, note, g.id]);
    if (r.rowCount) await logEvent(c, taskId, g.id, "delivery.step", { step: b.step, provider: b.provider });
    return { ok: true };
  });
}

export async function getDelivery(taskId: string, token: string, now = new Date()) {
  const cmp = await getComparison(taskId, token);
  return tx(async (c) => {
    await authorize(c, taskId, token, "view");
    const row = (await c.query(`SELECT * FROM delivery_plans WHERE task_id=$1`, [taskId])).rows[0];
    const input: DeliveryInput = {
      county: row?.county ?? "", city: row?.city ?? "", handling: row?.handling ?? "door",
      budgetKesMinor: row?.budget_kes_minor ?? null, budgetIncludesDelivery: row?.budget_includes_delivery ?? null,
      weightGrams: row?.weight_grams ?? null, lengthMm: row?.length_mm ?? null, widthMm: row?.width_mm ?? null,
      heightMm: row?.height_mm ?? null, hub: row?.hub ?? null,
    };
    const qs = (await c.query(`SELECT * FROM delivery_quotes WHERE task_id=$1`, [taskId])).rows;
    const quotes: ImportedQuote[] = qs.map((q) => ({
      id: q.id, offerId: q.offer_id, provider: q.provider as Provider | "store", mode: q.mode as Mode | "direct", reference: q.reference,
      amountMinor: q.amount_minor, currency: q.currency, includesItem: q.includes_item, includesCustoms: q.includes_customs,
      includesDelivery: q.includes_delivery, expiresAt: q.expires_at ? new Date(q.expires_at).toISOString() : null,
    }));
    const steps = (await c.query(`SELECT offer_id,provider,mode,step FROM delivery_steps WHERE task_id=$1`, [taskId])).rows;

    const offers: OfferInput[] = cmp.offers.filter((o) => o.status !== "ineligible" && o.availability === "InStock").map((o) => ({
      id: o.id, title: o.title, seller: o.seller, route: o.route, priceMinor: o.priceMinor, shippingMinor: o.shippingMinor,
      currency: o.currency, url: o.url, exact: o.status === "eligible",
    }));
    const destination: Destination | null = input.county || input.city ? { country: "KE", county: input.county, city: input.city } : null;
    const prefs: Prefs = { handling: input.handling, ...(input.budgetKesMinor ? { budgetKesMinor: input.budgetKesMinor } : {}),
      ...(input.budgetIncludesDelivery !== null && input.budgetIncludesDelivery !== undefined ? { budgetIncludesDelivery: input.budgetIncludesDelivery } : {}) };
    const parcel: Parcel = {
      ...(input.weightGrams ? { weightGrams: input.weightGrams } : {}), ...(input.lengthMm ? { lengthMm: input.lengthMm } : {}),
      ...(input.widthMm ? { widthMm: input.widthMm } : {}), ...(input.heightMm ? { heightMm: input.heightMm } : {}),
      ...(input.hub ? { hub: input.hub } : {}),
    };
    const plans = buildPlans({ offers, quotes, destination, prefs, parcel, now });
    const done = (p: { offerId: string; provider: string; mode: string }) =>
      steps.filter((s) => s.offer_id === p.offerId && s.provider === p.provider && s.mode === p.mode).map((s) => s.step as string);
    const progress = plans.filter((p) => p.route === "forward").flatMap((p) => {
      const d = done(p);
      return d.length ? [{ planId: p.id, done: d, next: nextAction(p.mode, d) }] : [];
    });
    return { input, plans, cheapestId: cheapestDelivered(plans), progress, asOf: RULES_AS_OF, fxSource };
  });
}

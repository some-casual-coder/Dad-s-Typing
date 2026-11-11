import { randomUUID } from "node:crypto";
import { authorize, can, canMint, hashToken, newToken, type Role } from "./access";
import { tx, type Tx } from "./db";
import { DomainError } from "./errors";
import { evaluate, type Attribute, type Op, type Requirement } from "./eligibility";
import { logEvent } from "./events";
import { idempotent } from "./idempotency";
import { orderTotal, quoteUnchanged } from "./money";

const bump = (c: Tx, taskId: string) =>
  c.query(`UPDATE tasks SET version = version + 1 WHERE id = $1 RETURNING version`, [taskId]).then((r) => r.rows[0].version as number);

const ROLES: Role[] = ["requester", "helper", "chooser", "payer"];

export async function createTask(input: {
  title: string; purpose?: string; market?: string; currency?: string; starterRoles?: Role[]; starterLabel?: string;
  deriveToken?: (grantId: string) => string;
  grantTtlDays?: number;
  inTx?: (c: Tx, ids: { taskId: string; grantId: string }) => Promise<void>;
}) {
  if (!input.title?.trim()) throw new DomainError("invalid", "Title required");
  const roles = input.starterRoles ?? ["requester", "chooser"];
  if (!roles.length || roles.some((r) => !ROLES.includes(r))) throw new DomainError("invalid", "Bad roles");
  return tx(async (c) => {
    const taskId = randomUUID();
    await c.query(`INSERT INTO tasks (id,title,purpose,market,currency) VALUES ($1,$2,$3,$4,$5)`, [
      taskId, input.title.trim(), input.purpose ?? "", input.market ?? "US", input.currency ?? "USD",
    ]);
    const grantId = randomUUID();
    const token = input.deriveToken ? input.deriveToken(grantId) : newToken();
    await c.query(
      `INSERT INTO grants (id,task_id,token_hash,roles,label,can_delegate,expires_at)
       VALUES ($1,$2,$3,$4,$5,true, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)`,
      [grantId, taskId, hashToken(token), roles, input.starterLabel ?? "", input.grantTtlDays ?? null],
    );
    await logEvent(c, taskId, grantId, "task.created", { roles });
    await input.inTx?.(c, { taskId, grantId });
    return { taskId, token };
  });
}

export async function createInvite(taskId: string, token: string, input: {
  roles: Role[]; label?: string; ttlMinutes?: number;
}) {
  return tx(async (c) => {
    const issuer = await authorize(c, taskId, token, "invite");
    if (!input.roles.length || input.roles.some((r) => !ROLES.includes(r))) throw new DomainError("invalid", "Bad roles");
    if (input.roles.some((r) => !canMint(issuer, r))) throw new DomainError("forbidden", "You cannot give that role");
    const t = newToken();
    const id = randomUUID();
    const ttl = input.ttlMinutes ?? 60 * 24;
    await c.query(
      `INSERT INTO grants (id,task_id,token_hash,roles,label,issued_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
      [id, taskId, hashToken(t), input.roles, input.label ?? "", issuer.id, String(ttl)],
    );
    await logEvent(c, taskId, issuer.id, "invite.created", { grantId: id, roles: input.roles });
    return { grantId: id, token: t };
  });
}

export async function revokeGrant(taskId: string, token: string, grantId: string) {
  return tx(async (c) => {
    const actor = await authorize(c, taskId, token, "revoke");
    const r = await c.query(`UPDATE grants SET revoked_at = now() WHERE id=$1 AND task_id=$2 AND revoked_at IS NULL`, [grantId, taskId]);
    if (!r.rowCount) throw new DomainError("not_found", "Grant not found");
    await logEvent(c, taskId, actor.id, "grant.revoked", { grantId });
  });
}

export async function addMessage(taskId: string, token: string, m: {
  channel: string; providerMessageId: string; body?: string; mediaRef?: string;
}) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    const r = await c.query(
      `INSERT INTO messages (id,task_id,grant_id,channel,provider_message_id,body,media_ref) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (channel,provider_message_id) DO NOTHING`,
      [randomUUID(), taskId, g.id, m.channel, m.providerMessageId, m.body ?? "", m.mediaRef ?? null],
    );
    if (r.rowCount) await logEvent(c, taskId, g.id, "message.received", { channel: m.channel });
    return { duplicate: r.rowCount === 0 };
  });
}

export interface RequirementInput { key: string; op?: Op; value: string | number; unit?: string; essential?: boolean; source?: string }

// Helper input stays proposed; a confirmed change bumps the task version
export async function setRequirement(taskId: string, token: string, input: RequirementInput, opts: { idempotencyKey: string }) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "propose_requirement");
    return idempotent(c, g.id, opts.idempotencyKey, "setRequirement", { taskId, input }, async () => {
      if (!input.key || input.value === undefined || input.value === "") throw new DomainError("invalid", "Requirement needs key and value");
      const confirmed = can(g.roles, "confirm_requirement");
      const id = randomUUID();
      if (confirmed) {
        await c.query(`UPDATE requirements SET superseded_at=now() WHERE task_id=$1 AND key=$2 AND superseded_at IS NULL AND status='confirmed'`, [taskId, input.key]);
      }
      await c.query(
        `INSERT INTO requirements (id,task_id,key,op,value,unit,essential,status,proposed_by,confirmed_by,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, taskId, input.key, input.op ?? "eq", JSON.stringify(input.value), input.unit ?? null, input.essential ?? true,
         confirmed ? "confirmed" : "proposed", g.id, confirmed ? g.id : null, input.source ?? "user"],
      );
      const version = confirmed ? await bump(c, taskId) : (await c.query(`SELECT version FROM tasks WHERE id=$1`, [taskId])).rows[0].version;
      await logEvent(c, taskId, g.id, confirmed ? "requirement.confirmed" : "requirement.proposed", { key: input.key, op: input.op ?? "eq", value: input.value });
      return { requirementId: id, status: confirmed ? "confirmed" : "proposed", version };
    });
  });
}

export async function confirmRequirement(taskId: string, token: string, requirementId: string) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "confirm_requirement");
    const { rows } = await c.query(`SELECT key FROM requirements WHERE id=$1 AND task_id=$2 AND status='proposed' AND superseded_at IS NULL FOR UPDATE`, [requirementId, taskId]);
    if (!rows[0]) throw new DomainError("not_found", "No such proposed requirement");
    await c.query(`UPDATE requirements SET superseded_at=now() WHERE task_id=$1 AND key=$2 AND status='confirmed' AND superseded_at IS NULL`, [taskId, rows[0].key]);
    await c.query(`UPDATE requirements SET status='confirmed', confirmed_by=$2 WHERE id=$1`, [requirementId, g.id]);
    const version = await bump(c, taskId);
    await logEvent(c, taskId, g.id, "requirement.confirmed", { requirementId });
    return { version };
  });
}

export async function recordOffers(taskId: string, offers: Array<{
  source: string; sourceOfferId: string; route: "paypal" | "external"; seller: string; merchantId?: string; sku?: string;
  title: string; variant?: object; attributes?: Record<string, Attribute>; unitPriceMinor: number; shippingMinor?: number | null;
  currency: string; availability: string; url?: string;
}>) {
  return tx(async (c) => {
    for (const o of offers) {
      if (o.route === "paypal" && (!o.merchantId || !o.sku || o.shippingMinor == null))
        throw new DomainError("invalid", "A payable offer needs merchant, sku and confirmed shipping");
      await c.query(
        `INSERT INTO offers (id,task_id,source,source_offer_id,route,seller,merchant_id,sku,title,variant,attributes,unit_price_minor,shipping_minor,currency,availability,url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (task_id,source,source_offer_id) DO UPDATE SET unit_price_minor=EXCLUDED.unit_price_minor, shipping_minor=EXCLUDED.shipping_minor,
           availability=EXCLUDED.availability, attributes=EXCLUDED.attributes, url=EXCLUDED.url, observed_at=now()`,
        [randomUUID(), taskId, o.source, o.sourceOfferId, o.route, o.seller, o.merchantId ?? null, o.sku ?? null, o.title,
         JSON.stringify(o.variant ?? {}), JSON.stringify(o.attributes ?? {}), o.unitPriceMinor, o.shippingMinor ?? null, o.currency, o.availability, o.url ?? null],
      );
    }
  });
}

async function confirmedRequirements(c: Tx, taskId: string): Promise<Requirement[]> {
  const { rows } = await c.query(`SELECT key,op,value,unit,essential FROM requirements WHERE task_id=$1 AND status='confirmed' AND superseded_at IS NULL ORDER BY created_at`, [taskId]);
  return rows.map((r) => ({ key: r.key, op: r.op, value: r.value, unit: r.unit, essential: r.essential }));
}

export async function getComparison(taskId: string, token: string) {
  return tx(async (c) => {
    await authorize(c, taskId, token, "view");
    const t = (await c.query(`SELECT version FROM tasks WHERE id=$1`, [taskId])).rows[0];
    const reqs = await confirmedRequirements(c, taskId);
    const anyEssential = reqs.some((r) => r.essential);
    const { rows } = await c.query(`SELECT * FROM offers WHERE task_id=$1 ORDER BY unit_price_minor`, [taskId]);
    const offers = rows.map((o) => {
      const e = evaluate(reqs, o.attributes);
      const stocked = o.availability === "InStock";
      return {
        id: o.id, title: o.title, seller: o.seller, route: o.route, sku: o.sku, variant: o.variant,
        priceMinor: o.unit_price_minor, shippingMinor: o.shipping_minor, currency: o.currency, availability: o.availability,
        url: o.route === "external" ? o.url : null, observedAt: o.observed_at, source: o.source,
        status: e.status === "eligible" && !stocked ? "ineligible" : e.status === "eligible" && !anyEssential ? "unchecked" : e.status,
        checks: e.checks,
      };
    });
    const rank = { eligible: 0, unchecked: 0, unresolved: 1, ineligible: 2 } as const;
    const pay = (r: string) => (r === "paypal" ? 0 : 1);
    offers.sort((a, b) => rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank] || pay(a.route) - pay(b.route));
    return { version: t.version as number, requirements: reqs, offers };
  });
}

// A new choice cancels unpaid orders; a payment already being captured blocks it
async function releasePayment(c: Tx, taskId: string) {
  const paid = await c.query(`SELECT 1 FROM seller_orders WHERE task_id=$1 AND status='paid'`, [taskId]);
  if (paid.rowCount) throw new DomainError("conflict", "This task is already paid");
  const open = await c.query(
    `SELECT a.id, EXISTS (SELECT 1 FROM payment_operations p WHERE p.attempt_id=a.id AND p.kind='capture' AND p.status IN ('started','unknown','succeeded')) AS capturing
       FROM payment_attempts a JOIN seller_orders o ON o.id=a.seller_order_id
      WHERE o.task_id=$1 AND a.status IN ('created','approved','pending') FOR UPDATE OF a`,
    [taskId],
  );
  if (open.rows.some((r) => r.capturing)) throw new DomainError("conflict", "A payment is being checked; try again when it finishes");
  await c.query(`UPDATE payment_attempts SET status='cancelled', updated_at=now() WHERE id = ANY($1::uuid[])`, [open.rows.map((r) => r.id)]);
  await c.query(`UPDATE seller_orders SET status='cancelled' WHERE task_id=$1 AND status IN ('awaiting_payer','pending')`, [taskId]);
}

export async function selectOffer(taskId: string, token: string, input: { offerId: string; expectedVersion: number; reason?: string }, opts: { idempotencyKey: string }) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "choose");
    return idempotent(c, g.id, opts.idempotencyKey, "selectOffer", { taskId, input }, async () => {
      const t = (await c.query(`SELECT version, cancelled_at FROM tasks WHERE id=$1 FOR UPDATE`, [taskId])).rows[0];
      if (t.cancelled_at) throw new DomainError("conflict", "Task is cancelled");
      if (t.version !== input.expectedVersion) throw new DomainError("stale", "The options changed; review the current list");
      const o = (await c.query(`SELECT * FROM offers WHERE id=$1 AND task_id=$2`, [input.offerId, taskId])).rows[0];
      if (!o) throw new DomainError("not_found", "Offer not found");
      const e = evaluate(await confirmedRequirements(c, taskId), o.attributes);
      if (e.status !== "eligible" || o.availability !== "InStock") throw new DomainError("invalid", "That option does not meet the confirmed requirements");
      await releasePayment(c, taskId);
      await c.query(`UPDATE selections SET superseded_at=now() WHERE task_id=$1 AND superseded_at IS NULL`, [taskId]);
      const id = randomUUID();
      const snapshot = { offerId: o.id, seller: o.seller, merchantId: o.merchant_id, sku: o.sku, title: o.title, variant: o.variant, route: o.route,
        unitPriceMinor: o.unit_price_minor, shippingMinor: o.shipping_minor, currency: o.currency, url: o.url };
      await c.query(`INSERT INTO selections (id,task_id,task_version,offer_id,offer_snapshot,chosen_by,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, taskId, t.version, o.id, JSON.stringify(snapshot), g.id, input.reason ?? ""]);
      await logEvent(c, taskId, g.id, "selection.made", { selectionId: id, offerId: o.id });
      return { selectionId: id };
    });
  });
}

export async function createSellerOrder(taskId: string, token: string, input: { selectionId: string }) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "review_order");
    const t = (await c.query(`SELECT version, cancelled_at FROM tasks WHERE id=$1 FOR UPDATE`, [taskId])).rows[0];
    const s = (await c.query(`SELECT * FROM selections WHERE id=$1 AND task_id=$2`, [input.selectionId, taskId])).rows[0];
    if (!s) throw new DomainError("not_found", "Selection not found");
    const existing = (await c.query(`SELECT * FROM seller_orders WHERE selection_id=$1`, [s.id])).rows[0];
    if (existing) return orderView(existing);
    if (t.cancelled_at || s.superseded_at || s.task_version !== t.version)
      throw new DomainError("stale", "The choice changed; it needs a fresh review");
    const snap = s.offer_snapshot;
    if (snap.route !== "paypal") throw new DomainError("not_payable", "This offer is bought at the retailer");
    const live = (await c.query(`SELECT unit_price_minor, shipping_minor, currency, availability FROM offers WHERE id=$1`, [s.offer_id])).rows[0];
    if (!quoteUnchanged(snap, live)) throw new DomainError("stale", "The price or stock changed; review again");
    const item = snap.unitPriceMinor, ship = snap.shippingMinor;
    if (!Number.isInteger(item) || !Number.isInteger(ship)) throw new DomainError("not_payable", "Delivery or price not confirmed");
    const id = randomUUID();
    const row = (await c.query(
      `INSERT INTO seller_orders (id,task_id,selection_id,created_by,merchant_id,seller,sku,title,quantity,currency,item_minor,shipping_minor,total_minor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12) RETURNING *`,
      [id, taskId, s.id, g.id, snap.merchantId, snap.seller, snap.sku, snap.title, snap.currency, item, ship, orderTotal(item, ship)],
    )).rows[0];
    await logEvent(c, taskId, g.id, "order.frozen", { orderId: id, totalMinor: orderTotal(item, ship) });
    return orderView(row);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const orderView = (o: Record<string, any>) => ({
  id: o.id, taskId: o.task_id, selectionId: o.selection_id, merchantId: o.merchant_id, seller: o.seller, sku: o.sku, title: o.title,
  quantity: o.quantity, currency: o.currency, itemMinor: o.item_minor, shippingMinor: o.shipping_minor, totalMinor: o.total_minor, status: o.status,
});

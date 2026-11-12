import { randomUUID } from "node:crypto";
import type { Eta } from "@/delivery/eta";
import { hubFor } from "@/delivery/hubs";
import type { Tx } from "@/domain/db";
import { compose, reminder, type Notice, type NoticeCtx, type NoticeStatus } from "./compose";

// The engine records every notice once; each channel renders it. The browser
// reads them from the task view, chat channels get them through the outbox.
export type Deliver = (c: Tx, taskId: string, n: Notice & { id: string; notBefore: Date | null; key: string }) => Promise<void>;
const deliverers: Deliver[] = [];
export const addDeliverer = (d: Deliver) => { if (!deliverers.includes(d)) deliverers.push(d); };

const EAT = 3 * 3600_000;
// Quiet hours 21:00 to 07:00 in Nairobi: chat messages wait until 07:30
export function deliverAt(now: Date): Date | null {
  const local = new Date(now.getTime() + EAT);
  const h = local.getUTCHours();
  if (h >= 7 && h < 21) return null;
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 7, 30) - EAT);
  return h >= 21 ? new Date(d.getTime() + 86_400_000) : d;
}

const morning = (now: Date, days: number) => {
  const local = new Date(now.getTime() + EAT + days * 86_400_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 10, 0) - EAT);
};
const shortTitle = (t: string) => (t.length > 50 ? `${t.slice(0, 49).trimEnd()}…` : t);

export async function publish(c: Tx, e: { eventId: string; orderId: string; taskId: string; status: NoticeStatus; eta: Eta | null }, now = new Date()) {
  const o = (await c.query(
    `SELECT o.title, o.currency, co.provider, co.cap_minor, co.actual_minor, co.extra_due_minor FROM seller_orders o
       JOIN concierge_orders co ON co.seller_order_id=o.id WHERE o.id=$1`, [e.orderId])).rows[0];
  if (!o) return;
  if (["delivered", "cancelled", "stock_out", "out_for_delivery"].includes(e.status)) {
    await c.query(`DELETE FROM notifications WHERE task_id=$1 AND kind='reminder' AND not_before > now()`, [e.taskId]);
    await c.query(`DELETE FROM channel_outbox WHERE dedupe_key LIKE $1 AND state='pending'`, [`rem:${e.orderId}:%`]);
  }
  const x: NoticeCtx = { item: shortTitle(o.title), provider: o.provider, eta: e.eta, currency: o.currency, capMinor: o.cap_minor,
    actualMinor: o.actual_minor, extraMinor: o.extra_due_minor, link: `${process.env.APP_BASE_URL ?? ""}/t/${e.taskId}` };
  const hub = e.status === "ready_to_collect" ? hubFor(o.provider) : null;
  const items: { n: Notice; kind: "update" | "reminder"; at: Date | null; key: string }[] =
    compose(e.status, x, hub).map((n, i) => ({ n, kind: "update", at: deliverAt(now), key: `upd:${e.eventId}:${i}` }));
  if (hub) for (const d of [2, 5]) items.push({ n: reminder(x, hub), kind: "reminder", at: morning(now, d), key: `rem:${e.orderId}:${d}` });
  for (const it of items) {
    const id = randomUUID();
    const r = await c.query(
      `INSERT INTO notifications (id,task_id,audience,kind,status,body,place,contact,not_before,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, e.taskId, it.n.audience, it.kind, e.status, it.n.body, it.n.place ? JSON.stringify(it.n.place) : null,
        it.n.contact ? JSON.stringify(it.n.contact) : null, it.kind === "reminder" ? it.at : now, it.key]);
    if (!r.rowCount) continue;
    for (const d of deliverers) await d(c, e.taskId, { ...it.n, id, notBefore: it.at, key: it.key });
  }
}

// What the browser shows: notices for this viewer that are due; someone who
// can pay sees the payer version of a notice instead of the general one
export async function noticesFor(c: Tx, taskId: string, canPay: boolean) {
  const rows = (await c.query(
    `SELECT body, place, contact, created_at FROM notifications n WHERE task_id=$1 AND not_before <= now()
       AND ((audience='payer' AND $2) OR (audience='all' AND NOT ($2 AND EXISTS (
         SELECT 1 FROM notifications p WHERE p.task_id=n.task_id AND p.audience='payer' AND p.status=n.status))))
      ORDER BY not_before, created_at`, [taskId, canPay])).rows;
  return rows.map((r) => ({ body: r.body as string, place: (r.place as Notice["place"]) ?? null, contact: (r.contact as Notice["contact"]) ?? null,
    at: new Date(r.created_at).toISOString() }));
}

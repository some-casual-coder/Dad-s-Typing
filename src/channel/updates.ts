import { randomUUID } from "node:crypto";
import { formatRange, type Eta } from "@/delivery/eta";
import { hubFor, mapsLink, type Hub } from "@/delivery/hubs";
import type { Tx } from "@/domain/db";
import { openRecipient } from "./bridge";
import { getChannel } from "./registry";

// Status updates written like an assistant would: what happened, what is
// next, when. Facts come from the order; nothing here is model-written.
export type UpdateStatus = "paid" | "ordered" | "at_warehouse" | "departed" | "cleared" | "ready_to_collect" | "out_for_delivery" | "delivered"
  | "cancelled" | "stock_out" | "needs_approval" | "settled";

interface Ctx {
  item: string; provider: string; eta: Eta | null; currency: string; capMinor: number; actualMinor: number | null; extraMinor: number | null; link: string;
}
type Msg = { kind: "text"; body: string } | { kind: "location"; body: string; payload: object } | { kind: "contact"; body: string; payload: object };

const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toFixed(2)}`;
const who = (p: string) => (p === "kentex" ? "Kentex" : p === "aquantuo" ? "Aquantuo" : "the forwarder");
const when = (eta: Eta | null) => (eta ? formatRange(eta.earliest, eta.latest) : null);

export function compose(status: UpdateStatus, x: Ctx, canPay: boolean, rich: boolean, hub: Hub | null): Msg[] {
  const arrive = when(x.eta);
  const t = (body: string): Msg[] => [{ kind: "text", body }];
  switch (status) {
    case "paid": return t(`Payment received for the ${x.item}. I'm placing the order now${arrive ? `; it should reach you ${arrive}` : ""}.`);
    case "ordered": return t(`I've ordered the ${x.item} from the store. Next stop: ${who(x.provider)}'s US warehouse.`);
    case "at_warehouse": return t(`The ${x.item} has arrived at ${who(x.provider)}'s US warehouse. It flies to Nairobi next${arrive ? `, arriving ${arrive}` : ""}.`);
    case "departed": return t(`The ${x.item} is on the plane to Nairobi${arrive ? `. Expected ${arrive}` : ""}.`);
    case "cleared": return t(`The ${x.item} has cleared customs in Nairobi. I'll tell you as soon as it's ready.`);
    case "out_for_delivery": return t(`The ${x.item} is out for delivery today.`);
    case "delivered": return t(`Delivered. I hope the ${x.item} is just right. Reply here if anything is wrong.`);
    case "stock_out": return t(`Sorry, the store ran out of the ${x.item}. The payment is being refunded in full. Reply and I'll find a similar one.`);
    case "cancelled": return t(canPay ? `Cancelled. The full ${money(x.capMinor, x.currency)} is being refunded to your PayPal.` : "Cancelled, and the payment is being refunded in full.");
    case "needs_approval": return canPay && x.extraMinor
      ? t(`The final shipping bill for the ${x.item} is ${money(x.extraMinor, x.currency)} above what you paid. Please approve or decline here: ${x.link}`) : [];
    case "settled": return canPay && x.actualMinor !== null && x.actualMinor < x.capMinor
      ? t(`Final cost settled at ${money(x.actualMinor, x.currency)}. ${money(x.capMinor - x.actualMinor, x.currency)} is on its way back to your PayPal.`) : [];
    case "ready_to_collect": return readyMessages(x, rich, hub);
  }
}

function readyMessages(x: Ctx, rich: boolean, hub: Hub | null): Msg[] {
  if (!hub) return [{ kind: "text", body: `Good news: the ${x.item} is ready to collect in Nairobi. ${who(x.provider)} will confirm the pickup point with you.` }];
  const where = hub.address ? `${hub.name}, ${hub.address}` : hub.name;
  const lines = [`Good news: the ${x.item} is ready to collect at ${where}.`, hub.bring];
  if (hub.hours) lines.push(`Open ${hub.hours}.`);
  if (hub.pin && !rich) lines.push(`Map${hub.pin.approximate ? " (street, approximate)" : ""}: ${mapsLink(hub.pin)}`);
  if (hub.phone && !rich) lines.push(`Call ${hub.phone}.`);
  const out: Msg[] = [{ kind: "text", body: lines.join(" ") }];
  if (rich && hub.pin) out.push({ kind: "location", body: hub.name,
    payload: { lat: hub.pin.lat, lon: hub.pin.lon, name: hub.pin.approximate ? `${hub.name} (street, approximate)` : hub.name, address: hub.address ?? "" } });
  if (rich && hub.phone) out.push({ kind: "contact", body: hub.name, payload: { name: hub.name, phone: hub.phone } });
  return out;
}

const EAT = 3 * 3600_000;
// Quiet hours 21:00 to 07:00 in Nairobi: hold until 07:30
export function deliverAt(now: Date): Date | null {
  const local = new Date(now.getTime() + EAT);
  const h = local.getUTCHours();
  if (h >= 7 && h < 21) return null;
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 7, 30) - EAT);
  return h >= 21 ? new Date(d.getTime() + 86_400_000) : d;
}

// 10:00 Nairobi time, n days after now
const morning = (now: Date, days: number) => {
  const local = new Date(now.getTime() + EAT + days * 86_400_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 10, 0) - EAT);
};

export async function queueUpdates(c: Tx, e: { eventId: string; orderId: string; taskId: string; status: UpdateStatus; eta: Eta | null }, now = new Date()) {
  const o = (await c.query(
    `SELECT o.title, o.currency, co.provider, co.cap_minor, co.actual_minor, co.extra_due_minor FROM seller_orders o
       JOIN concierge_orders co ON co.seller_order_id=o.id WHERE o.id=$1`, [e.orderId])).rows[0];
  if (!o) return;
  if (["delivered", "cancelled", "stock_out", "out_for_delivery"].includes(e.status))
    await c.query(`DELETE FROM channel_outbox WHERE dedupe_key LIKE $1 AND state='pending'`, [`rem:${e.orderId}:%`]);
  const subs = (await c.query(`SELECT channel, sender_hash, recipient_enc, can_pay FROM channel_subscriptions WHERE task_id=$1`, [e.taskId])).rows;
  const base = process.env.APP_BASE_URL ?? "";
  const hub = e.status === "ready_to_collect" ? hubFor(o.provider) : null;
  const x: Ctx = { item: shortTitle(o.title), provider: o.provider, eta: e.eta, currency: o.currency, capMinor: o.cap_minor,
    actualMinor: o.actual_minor, extraMinor: o.extra_due_minor, link: `${base}/t/${e.taskId}` };
  const at = deliverAt(now);
  for (const s of subs) {
    const to = openRecipient(s.channel, s.recipient_enc);
    if (!to) continue;
    const rich = !!getChannel(s.channel).rich;
    const msgs = compose(e.status, x, s.can_pay, rich, hub);
    const put = (m: Msg, key: string, when: Date | null) => c.query(
      `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key,kind,payload,not_before) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [randomUUID(), s.channel, to, m.body, key, m.kind, m.kind === "text" ? null : JSON.stringify(m.payload), when]);
    for (const [i, m] of msgs.entries()) await put(m, `upd:${e.eventId}:${s.sender_hash.slice(0, 16)}:${i}`, at);
    if (e.status === "ready_to_collect" && hub) {
      const nudge = `Reminder: the ${x.item} is waiting for you at ${hub.name}${hub.address ? `, ${hub.address}` : ""}. ${hub.bring}`;
      for (const d of [2, 5]) await put({ kind: "text", body: nudge }, `rem:${e.orderId}:${s.sender_hash.slice(0, 16)}:${d}`, morning(now, d));
    }
  }
}

const shortTitle = (t: string) => (t.length > 50 ? `${t.slice(0, 49).trimEnd()}…` : t);

import { randomUUID } from "node:crypto";
import { addDeliverer, type Deliver } from "@/notify";
import { asText } from "@/notify/compose";
import { deriveChannelToken, openRecipient } from "./bridge";
import { getChannel } from "./registry";

// Chat rendering of an engine notice: WhatsApp gets text, then a pin and a
// contact card; channels without them get the same facts as text.
const toChannels: Deliver = async (c, taskId, n) => {
  const subs = (await c.query(`SELECT channel, sender_hash, recipient_enc, can_pay FROM channel_subscriptions WHERE task_id=$1`, [taskId])).rows;
  // Someone who can pay gets the payer version instead of the general one
  const payerVersion = n.audience === "all" && (await c.query(
    `SELECT 1 FROM notifications WHERE task_id=$1 AND audience='payer' AND status=(SELECT status FROM notifications WHERE id=$2)`, [taskId, n.id])).rowCount;
  const status = (await c.query(`SELECT status FROM notifications WHERE id=$1`, [n.id])).rows[0]?.status as string | undefined;
  for (const s of subs) {
    if (n.audience === "payer" && !s.can_pay) continue;
    if (payerVersion && s.can_pay) continue;
    const to = openRecipient(s.channel, s.recipient_enc);
    if (!to) continue;
    const rich = !!getChannel(s.channel).rich;
    const rows: { kind: string; body: string; payload: object | null }[] = rich ? [{ kind: "text", body: n.body, payload: null }] : [{ kind: "text", body: asText(n), payload: null }];
    if (rich && n.place?.pin) rows.push({ kind: "location", body: n.place.name, payload: {
      lat: n.place.pin.lat, lon: n.place.pin.lon, name: n.place.pin.approximate ? `${n.place.name} (approximate)` : n.place.name, address: n.place.address ?? "" } });
    else if (rich && n.place?.mapsUrl) rows[0].body = `${n.body} Map: ${n.place.mapsUrl}`;
    if (rich && n.contact) rows.push({ kind: "contact", body: n.contact.name, payload: n.contact });
    // Once paid, the chat gets the receipt link and a nudge to keep it handy or
    // let the person it's for follow along (Share on the page gives them a view link)
    if (rich && status === "paid") {
      const g = (await c.query(`SELECT grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2 AND task_id=$3`, [s.channel, s.sender_hash, taskId])).rows[0];
      if (g) rows.push(
        { kind: "text", body: `Your receipt and tracking: ${process.env.APP_BASE_URL ?? "http://localhost:3000"}/t/${taskId}#k=${deriveChannelToken(s.channel, g.grant_id)}`, payload: null },
        { kind: "text", body: "Tip: pin this chat so updates are easy to find. Buying for someone? Open the link, tap *Share* and send them their own view so they can follow along too.", payload: null });
    }
    // In order, a moment apart, so a chat reads them top to bottom
    for (const [i, r] of rows.entries()) {
      await c.query(
        `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key,kind,payload,not_before)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $9::int = 0 THEN $8::timestamptz ELSE COALESCE($8::timestamptz, now()) + make_interval(secs => 1.5 * $9::int) END)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [randomUUID(), s.channel, to, r.body, `${n.key}:${s.sender_hash.slice(0, 16)}:${i}`, r.kind, r.payload ? JSON.stringify(r.payload) : null, n.notBefore, i]);
    }
  }
};

addDeliverer(toChannels);
export {};

import { createHash, randomInt } from "node:crypto";
import { authorize, can } from "@/domain/access";
import { pool, tx, type Tx } from "@/domain/db";
import { subscribe } from "@/domain/concierge";
import { logEvent } from "@/domain/events";
import { senderHash } from "./bridge";

// The payer (or anyone with the link) opts in to WhatsApp updates by sending a
// one-time code from their own phone: consent, a verified number, no typing it
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const hash = (code: string) => createHash("sha256").update(`dt-join:${code.toUpperCase()}`).digest("hex");

export async function createJoinCode(taskId: string, token: string) {
  return tx(async (c) => {
    const g = await authorize(c, taskId, token, "view");
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    await c.query(`INSERT INTO channel_join_codes (code_hash,task_id,can_pay,expires_at) VALUES ($1,$2,$3, now() + interval '7 days')`,
      [hash(code), taskId, can(g.roles, "pay")]);
    await logEvent(c, taskId, g.id, "channel.join_code", {});
    const bot = (process.env.WHATSAPP_BOT_NUMBER ?? "").replace(/\D/g, "");
    return { code, whatsappLink: /^\d{8,15}$/.test(bot) ? `https://wa.me/${bot}?text=${encodeURIComponent(`JOIN ${code}`)}` : null };
  });
}

const JOIN = /^\s*join\s+([A-Za-z0-9]{6})\s*$/i;

// Beyond the env allowlist: someone already admitted by a code, or sending a
// live JOIN code now (it is consumed when processed). Others stay ignored.
export async function admitted(channel: string, sender: string, text?: string): Promise<boolean> {
  const h = senderHash(channel, sender);
  if ((await pool.query(`SELECT 1 FROM channel_admitted_senders WHERE channel=$1 AND sender_hash=$2`, [channel, h])).rowCount) return true;
  const m = text ? JOIN.exec(text) : null;
  return !!m && !!(await pool.query(`SELECT 1 FROM channel_join_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()`, [hash(m[1])])).rowCount;
}

// Unsent work for this person stops now, a later retry of it is dropped at send
// time, and no new update subscription starts until they JOIN again
export async function optOut(c: Tx, channel: string, hashed: string, sender: string) {
  await c.query(`INSERT INTO channel_opt_outs (channel,sender_hash) VALUES ($1,$2) ON CONFLICT (channel,sender_hash) DO UPDATE SET opted_out_at=now()`, [channel, hashed]);
  const r = await c.query(`DELETE FROM channel_subscriptions WHERE channel=$1 AND sender_hash=$2`, [channel, hashed]);
  await c.query(`UPDATE channel_outbox SET state='suppressed', body='', recipient='', payload=NULL, lease_until=NULL, updated_at=now()
    WHERE channel=$1 AND recipient=$2 AND (state='pending' OR (state='leased' AND lease_until < now()))`, [channel, sender]);
  return (r.rowCount ?? 0) > 0;
}

export const optedOut = async (c: Tx, channel: string, hashed: string) =>
  !!(await c.query(`SELECT 1 FROM channel_opt_outs WHERE channel=$1 AND sender_hash=$2`, [channel, hashed])).rowCount;

// "JOIN ABC123" subscribes this sender; "STOP" unsubscribes them everywhere
export async function handleJoinOrStop(c: Tx, channel: string, hashed: string, sender: string, text: string): Promise<string | null> {
  if (/^\s*stop\s*$/i.test(text)) {
    return (await optOut(c, channel, hashed, sender))
      ? "Okay, no more order updates here. Send JOIN and a code from the order page to start again." : "You're not getting any order updates here.";
  }
  const m = JOIN.exec(text);
  if (!m) return null;
  const row = (await c.query(
    `UPDATE channel_join_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING task_id, can_pay`,
    [hash(m[1])])).rows[0];
  if (!row) return "That code didn't work. It may have expired or been used; make a new one on the order page.";
  await c.query(`DELETE FROM channel_opt_outs WHERE channel=$1 AND sender_hash=$2`, [channel, hashed]);
  await subscribe(c, row.task_id, channel, hashed, sender, row.can_pay);
  await c.query(`INSERT INTO channel_admitted_senders (channel,sender_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [channel, hashed]);
  const t = (await c.query(`SELECT title FROM tasks WHERE id=$1`, [row.task_id])).rows[0];
  await logEvent(c, row.task_id, null, "channel.joined", { channel });
  return `You're in. I'll message you here as "${t?.title ?? "your order"}" moves: paid, ordered, arrived, and ready to collect. Reply STOP any time.`;
}

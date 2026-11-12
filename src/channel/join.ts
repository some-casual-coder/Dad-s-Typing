import { createHash, randomInt } from "node:crypto";
import { authorize, can } from "@/domain/access";
import { tx, type Tx } from "@/domain/db";
import { subscribe } from "@/domain/concierge";
import { logEvent } from "@/domain/events";

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

// "JOIN ABC123" subscribes this sender; "STOP" unsubscribes them everywhere
export async function handleJoinOrStop(c: Tx, channel: string, senderHash: string, sender: string, text: string): Promise<string | null> {
  if (/^\s*stop\s*$/i.test(text)) {
    const r = await c.query(`DELETE FROM channel_subscriptions WHERE channel=$1 AND sender_hash=$2`, [channel, senderHash]);
    await c.query(`DELETE FROM channel_outbox WHERE channel=$1 AND recipient=$2 AND state='pending' AND (dedupe_key LIKE 'upd:%' OR dedupe_key LIKE 'rem:%')`, [channel, sender]);
    return r.rowCount ? "Okay, no more order updates here. Send JOIN and a code from the order page to start again." : "You're not getting any order updates here.";
  }
  const m = /^\s*join\s+([A-Za-z0-9]{6})\s*$/i.exec(text);
  if (!m) return null;
  const row = (await c.query(
    `UPDATE channel_join_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING task_id, can_pay`,
    [hash(m[1])])).rows[0];
  if (!row) return "That code didn't work. It may have expired or been used; make a new one on the order page.";
  await subscribe(c, row.task_id, channel, senderHash, sender, row.can_pay);
  const t = (await c.query(`SELECT title FROM tasks WHERE id=$1`, [row.task_id])).rows[0];
  await logEvent(c, row.task_id, null, "channel.joined", { channel });
  return `You're in. I'll message you here as "${t?.title ?? "your order"}" moves: paid, ordered, arrived, and ready to collect. Reply STOP any time.`;
}

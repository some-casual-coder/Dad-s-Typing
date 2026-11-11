import { tx } from "@/domain/db";
import { DomainError } from "@/domain/errors";

const CHANNEL = "whatsapp";
const MAX_ATTEMPTS = 5;

export async function claimOutbox(limit = 5, leaseSeconds = 120) {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 10);
  const lease = Math.min(Math.max(Math.trunc(leaseSeconds) || 120, 30), 300);
  return tx(async (c) => {
    // out of attempts with no ack: it may have been sent, so never resend
    await c.query(`UPDATE channel_outbox SET state='unknown', body='', recipient='', updated_at=now() WHERE channel=$1 AND state='leased' AND lease_until < now() AND attempts >= $2`, [CHANNEL, MAX_ATTEMPTS]);
    const r = await c.query(
      `UPDATE channel_outbox SET state='leased', attempts=attempts+1, lease_until=now() + ($3 || ' seconds')::interval, updated_at=now()
        WHERE id IN (SELECT id FROM channel_outbox WHERE channel=$1 AND (state='pending' OR (state='leased' AND lease_until < now()))
                     ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, recipient, body, attempts`,
      [CHANNEL, n, String(lease)],
    );
    return r.rows.map((x) => ({ id: x.id as string, recipient: x.recipient as string, body: x.body as string, attempt: x.attempts as number }));
  });
}

const FINAL = new Set(["sent", "failed", "unknown"]);

// Idempotent: the first final state wins and the message text is dropped
export async function ackOutbox(id: string, ack: { state: string; providerMessageId?: string; error?: string }) {
  if (!FINAL.has(ack.state)) throw new DomainError("invalid", "state");
  if (ack.providerMessageId !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(ack.providerMessageId)) throw new DomainError("invalid", "providerMessageId");
  if (ack.error !== undefined && !/^[a-z0-9_.-]{1,60}$/i.test(ack.error)) throw new DomainError("invalid", "error");
  return tx(async (c) => {
    const cur = (await c.query(`SELECT state FROM channel_outbox WHERE id=$1 AND channel=$2 FOR UPDATE`, [id, CHANNEL])).rows[0];
    if (!cur) throw new DomainError("not_found", "Unknown outbox item");
    if (FINAL.has(cur.state)) return { state: cur.state as string };
    await c.query(`UPDATE channel_outbox SET state=$2, provider_message_id=$3, error=$4, body='', recipient='', lease_until=NULL, updated_at=now() WHERE id=$1`,
      [id, ack.state, ack.providerMessageId ?? null, ack.error ?? null]);
    return { state: ack.state };
  });
}

export async function reportHealth(h: { connected: boolean; paired: boolean; loggedOut: boolean; version: string; at: string }) {
  await tx((c) => c.query(
    `INSERT INTO channel_status (channel,connected,paired,logged_out,version,reported_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (channel) DO UPDATE SET connected=EXCLUDED.connected, paired=EXCLUDED.paired, logged_out=EXCLUDED.logged_out,
       version=EXCLUDED.version, reported_at=EXCLUDED.reported_at, updated_at=now()`,
    [CHANNEL, h.connected, h.paired, h.loggedOut, h.version, h.at]));
}

// Stale reports count as down so the UI never shows a dead connector as live
export async function publicStatus() {
  const r = (await tx((c) => c.query(`SELECT connected, reported_at FROM channel_status WHERE channel=$1`, [CHANNEL]))).rows[0];
  const fresh = r && Date.now() - new Date(r.reported_at).getTime() < 120_000;
  return { connected: !!(r && fresh && r.connected), updatedAt: r ? (r.reported_at as Date).toISOString() : null };
}

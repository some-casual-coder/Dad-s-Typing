import { randomUUID } from "node:crypto";
import { seedDemoOffers, seedExternalOffers } from "@/catalog/demo";
import { postExchange } from "@/chat/exchange";
import { tx } from "@/domain/db";
import { DomainError } from "@/domain/errors";
import { createTask } from "@/domain/tasks";
import { getTaskView } from "@/domain/view";
import { allowedSenders, deriveChannelToken, senderHash } from "./bridge";

const CHANNEL = "whatsapp";
const MAX_ATTEMPTS = 5;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_B64 = Math.ceil(4 * 1024 * 1024 * 1.4);

export interface InboundInput {
  providerMessageId: string; sender: string; text?: string;
  image?: { mime: string; base64: string }; receivedAt: string;
}

export function parseInbound(b: Record<string, unknown>): InboundInput {
  const id = b.providerMessageId, sender = b.sender, text = b.text, image = b.image, at = b.receivedAt;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new DomainError("invalid", "providerMessageId");
  if (typeof sender !== "string" || !/^\d{6,15}$/.test(sender)) throw new DomainError("invalid", "sender");
  if (text !== undefined && (typeof text !== "string" || text.length > 4000)) throw new DomainError("invalid", "text");
  const when = typeof at === "string" ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) throw new DomainError("invalid", "receivedAt");
  let img: InboundInput["image"];
  if (image !== undefined) {
    const o = image as Record<string, unknown>;
    if (typeof o !== "object" || o === null || typeof o.mime !== "string" || !MIMES.has(o.mime)) throw new DomainError("invalid", "image mime");
    if (typeof o.base64 !== "string" || o.base64.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.base64)) throw new DomainError("invalid", "image data");
    img = { mime: o.mime, base64: o.base64 };
  }
  if (!text?.trim() && !img) throw new DomainError("invalid", "empty message");
  return { providerMessageId: id, sender, text: text?.trim() || undefined, image: img, receivedAt: when.toISOString() };
}

// Persist first, process later: a restart or retry can never lose or repeat a message
export async function enqueueInbound(m: InboundInput): Promise<"accepted" | "duplicate" | "ignored"> {
  if (!allowedSenders().has(m.sender)) return "ignored";
  return tx(async (c) => {
    const r = await c.query(
      `INSERT INTO channel_inbox (id,channel,provider_message_id,sender,body,image_mime,image_b64,received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (channel, provider_message_id) DO NOTHING`,
      [randomUUID(), CHANNEL, m.providerMessageId, m.sender, m.text ?? "", m.image?.mime ?? null, m.image?.base64 ?? null, m.receivedAt],
    );
    return r.rowCount ? "accepted" : "duplicate";
  });
}

type Row = Record<string, unknown>;

// Finished rows keep no phone number or text and are dropped after a week
async function purgeOld() {
  await tx(async (c) => {
    await c.query(`DELETE FROM channel_inbox WHERE state IN ('done','failed') AND created_at < now() - interval '7 days'`);
    await c.query(`DELETE FROM channel_outbox WHERE state IN ('sent','failed','unknown') AND updated_at < now() - interval '7 days'`);
  });
}

async function claimInbox(): Promise<Row | null> {
  return tx(async (c) => {
    await c.query(`UPDATE channel_inbox SET state='failed', image_b64=NULL, sender='', body='' WHERE state='processing' AND locked_until < now() AND attempts >= $1`, [MAX_ATTEMPTS]);
    const r = await c.query(
      `UPDATE channel_inbox SET state='processing', attempts=attempts+1, locked_until=now()+interval '3 minutes'
        WHERE id = (SELECT id FROM channel_inbox WHERE channel=$1 AND (state='received' OR (state='processing' AND locked_until < now()))
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [CHANNEL],
    );
    return (r.rows[0] as Row | undefined) ?? null;
  });
}

export function composeReply(o: { reply: string; proposals: { key: string; op: string; value: string | number; unit?: string }[]; link: string; fresh: boolean }) {
  const lines = [o.reply.trim().slice(0, 600)];
  if (o.proposals.length) {
    lines.push("I understood: " + o.proposals.map((p) => `${p.key.replace(/_/g, " ")} ${p.op} ${p.value}${p.unit ?? ""}`).join("; ") + ". Please confirm on the page.");
  }
  lines.push(o.fresh ? `Your task is ready: ${o.link}` : `Your task: ${o.link}`);
  return lines.join("\n\n").slice(0, 3000);
}

const link = (taskId: string, token: string) => `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/t/${taskId}#k=${token}`;

// An image starts a new task; text continues the latest open one, else starts one
async function resolveTask(row: Row, hasImage: boolean) {
  const hash = senderHash(row.sender as string);
  const existing = !hasImage ? (await tx((c) => c.query(`SELECT task_id, grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2`, [CHANNEL, hash]))).rows[0] : undefined;
  if (existing) {
    const token = deriveChannelToken(existing.grant_id);
    const v = await getTaskView(existing.task_id, token).catch(() => null);
    if (v && v.nextAction !== "paid" && v.nextAction !== "cancelled") return { taskId: existing.task_id as string, token, fresh: false };
  }
  if (row.task_id) {
    // a previous attempt already created this message's task
    const g = (await tx((c) => c.query(`SELECT grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2 AND task_id=$3`, [CHANNEL, hash, row.task_id]))).rows[0];
    if (g) return { taskId: row.task_id as string, token: deriveChannelToken(g.grant_id), fresh: true };
  }
  const title = ((row.body as string) || "Photo from WhatsApp").replace(/\s+/g, " ").slice(0, 80);
  const made = await createTask({
    title, starterRoles: ["helper", "payer"], starterLabel: "WhatsApp", deriveToken: (id) => deriveChannelToken(id),
    inTx: async (c, ids) => {
      await c.query(
        `INSERT INTO channel_identities (channel,sender_hash,task_id,grant_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (channel,sender_hash) DO UPDATE SET task_id=EXCLUDED.task_id, grant_id=EXCLUDED.grant_id, updated_at=now()`,
        [CHANNEL, hash, ids.taskId, ids.grantId],
      );
      await c.query(`UPDATE channel_inbox SET task_id=$2 WHERE id=$1`, [row.id, ids.taskId]);
    },
  });
  await seedDemoOffers(made.taskId).catch(() => console.error("channel_error", "seed_demo"));
  await seedExternalOffers(made.taskId, title).catch(() => console.error("channel_error", "seed_external"));
  return { taskId: made.taskId, token: made.token, fresh: true };
}

async function processRow(row: Row) {
  const image = row.image_b64 ? { mime: row.image_mime as string, base64: row.image_b64 as string } : undefined;
  const { taskId, token, fresh } = await resolveTask(row, !!image);
  const ex = await postExchange(taskId, token, { channel: CHANNEL, key: `wa:${row.provider_message_id}`, text: (row.body as string) || undefined, image });
  const reply = ex.messages.find((m) => m.role === "assistant")?.body ?? "";
  const body = composeReply({ reply, proposals: ex.proposals as never, link: link(taskId, token), fresh });
  await tx(async (c) => {
    await c.query(
      `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [randomUUID(), CHANNEL, row.sender, body, `inbox:${row.id}`],
    );
    await c.query(`UPDATE channel_inbox SET state='done', image_b64=NULL, sender='', locked_until=NULL WHERE id=$1`, [row.id]);
  });
}

// Returns how many messages were handled; safe to call concurrently
export async function processInboxOnce(max = 10): Promise<number> {
  await purgeOld();
  let n = 0;
  for (; n < max; n++) {
    const row = await claimInbox();
    if (!row) break;
    try {
      await processRow(row);
    } catch (e) {
      console.error("channel_error", "inbox_failed", (e as { code?: string }).code ?? (e as Error)?.name);
    }
  }
  return n;
}

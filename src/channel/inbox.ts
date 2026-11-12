import { randomUUID } from "node:crypto";
import { seedDemoOffers, seedExternalOffers } from "@/catalog/demo";
import { postExchange } from "@/chat/exchange";
import { validateImage } from "@/chat/image";
import { placeFromPin } from "@/delivery/places";
import { tx } from "@/domain/db";
import { answerFromText, askLine, getDestination, inferForSender, placeLabel, putDestination, saveProfile } from "@/domain/destination";
import { DomainError } from "@/domain/errors";
import { createTask } from "@/domain/tasks";
import { getTaskView } from "@/domain/view";
import { deriveChannelToken, senderHash } from "./bridge";
import { allowedSenders, channelIds, getChannel, isConfigured, type ChannelDef } from "./registry";

const MAX_ATTEMPTS = 5;
const GRANT_DAYS = 14;
const CONSENT = "Photos and messages you send are read by an AI service to help with this task.";
const SORRY = "Sorry, I could not process that message. Please send it again.";
const MAX_IMAGE_B64 = Math.ceil(4 * 1024 * 1024 * 1.4);

export interface InboundInput {
  providerMessageId: string; sender: string; text?: string;
  image?: { mime: string; base64: string }; receivedAt: string;
  // Mapped from a location pin; the coordinates themselves are dropped
  place?: { county: string; area: string } | "outside_kenya";
}

export function parseInbound(def: ChannelDef, b: Record<string, unknown>): InboundInput {
  const id = b.providerMessageId, sender = b.sender, text = b.text, image = b.image, at = b.receivedAt, loc = b.location;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new DomainError("invalid", "providerMessageId");
  if (typeof sender !== "string" || !def.sender.test(sender)) throw new DomainError("invalid", "sender");
  if (text !== undefined && (typeof text !== "string" || text.length > 4000)) throw new DomainError("invalid", "text");
  const when = typeof at === "string" ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) throw new DomainError("invalid", "receivedAt");
  let img: InboundInput["image"];
  if (image !== undefined) {
    if (!def.images) throw new DomainError("invalid", "this channel does not accept images");
    const o = image as Record<string, unknown>;
    if (typeof o !== "object" || o === null || typeof o.mime !== "string") throw new DomainError("invalid", "image mime");
    if (typeof o.base64 !== "string" || o.base64.length > MAX_IMAGE_B64) throw new DomainError("invalid", "image data");
    validateImage(o.mime, o.base64);
    img = { mime: o.mime, base64: o.base64 };
  }
  let place: InboundInput["place"];
  if (loc !== undefined) {
    const o = (typeof loc === "object" && loc !== null ? loc : {}) as Record<string, unknown>;
    const r = placeFromPin(o.lat, o.lon);
    if (r === "invalid") throw new DomainError("invalid", "location");
    place = r === "outside_kenya" ? r : { county: r.county, area: r.area };
  }
  if (!text?.trim() && !img && !place) throw new DomainError("invalid", "empty message");
  return { providerMessageId: id, sender, text: text?.trim() || undefined, image: img, receivedAt: when.toISOString(), ...(place ? { place } : {}) };
}

// Persist first, process later: a restart or retry can never lose or repeat a message
export async function enqueueInbound(channel: string, m: InboundInput): Promise<"accepted" | "duplicate" | "ignored"> {
  if (!allowedSenders(channel).has(m.sender)) return "ignored";
  return tx(async (c) => {
    const r = await c.query(
      `INSERT INTO channel_inbox (id,channel,provider_message_id,sender,body,image_mime,image_b64,received_at,place_county,place_area)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (channel, provider_message_id) DO NOTHING`,
      [randomUUID(), channel, m.providerMessageId, m.sender, m.text ?? "", m.image?.mime ?? null, m.image?.base64 ?? null, m.receivedAt,
        m.place === "outside_kenya" ? "" : m.place?.county ?? null, m.place === "outside_kenya" ? "outside_kenya" : m.place?.area ?? null],
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

async function claimInbox(channel: string): Promise<Row | null> {
  return tx(async (c) => {
    // tell the sender before their number is dropped, so a failure is never silent
    await c.query(
      `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key)
       SELECT gen_random_uuid(), channel, sender, $3, 'inbox-failed:' || id FROM channel_inbox
        WHERE channel=$2 AND state='processing' AND locked_until < now() AND attempts >= $1 AND sender <> ''
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [MAX_ATTEMPTS, channel, SORRY],
    );
    await c.query(`UPDATE channel_inbox SET state='failed', image_b64=NULL, sender='', body='' WHERE channel=$2 AND state='processing' AND locked_until < now() AND attempts >= $1`, [MAX_ATTEMPTS, channel]);
    const r = await c.query(
      `UPDATE channel_inbox SET state='processing', attempts=attempts+1, locked_until=now()+interval '3 minutes'
        WHERE id = (SELECT id FROM channel_inbox WHERE channel=$1 AND (state='received' OR (state='processing' AND locked_until < now()))
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [channel],
    );
    return (r.rows[0] as Row | undefined) ?? null;
  });
}

export function composeReply(o: { reply: string; proposals: { key: string; op: string; value: string | number; unit?: string }[]; link: string; fresh: boolean; maxChars: number }) {
  const tail = o.fresh ? `Your task is ready: ${o.link}` : `Your task: ${o.link}`;
  const head = [o.reply.trim().slice(0, 600)];
  if (o.proposals.length) {
    head.push("I understood: " + o.proposals.map((p) => `${p.key.replace(/_/g, " ")} ${p.op} ${p.value}${p.unit ?? ""}`).join("; ") + ". Please confirm on the page.");
  }
  if (o.fresh) head.push(CONSENT);
  // the link is the point of the reply, so only the words before it are cut
  const room = Math.max(o.maxChars - tail.length - 2, 0);
  const words = head.join("\n\n").slice(0, room).trimEnd();
  return words ? `${words}\n\n${tail}` : tail;
}

const link = (taskId: string, token: string) => `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/t/${taskId}#k=${token}`;

// An image starts a new task; text continues the latest open one, else starts one
async function resolveTask(channel: string, row: Row, hasImage: boolean) {
  const hash = senderHash(channel, row.sender as string);
  const existing = !hasImage ? (await tx((c) => c.query(`SELECT task_id, grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2`, [channel, hash]))).rows[0] : undefined;
  if (existing) {
    const token = deriveChannelToken(channel, existing.grant_id);
    const v = await getTaskView(existing.task_id, token).catch(() => null);
    if (v && v.nextAction !== "paid" && v.nextAction !== "cancelled") {
      await tx((c) => c.query(`UPDATE grants SET expires_at = now() + make_interval(days => $2) WHERE id=$1 AND revoked_at IS NULL`, [existing.grant_id, GRANT_DAYS]));
      return { taskId: existing.task_id as string, token, fresh: false, dest: "none" as const };
    }
  }
  if (row.task_id) {
    // a previous attempt already created this message's task
    const g = (await tx((c) => c.query(`SELECT grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2 AND task_id=$3`, [channel, hash, row.task_id]))).rows[0];
    if (g) return { taskId: row.task_id as string, token: deriveChannelToken(channel, g.grant_id), fresh: true, dest: "none" as const };
  }
  const title = ((row.body as string) || `Request from ${getChannel(channel).label}`).replace(/\s+/g, " ").slice(0, 80);
  let dest = "none" as "known" | "ask" | "none";
  const made = await createTask({
    title, starterRoles: ["helper", "payer"], starterLabel: getChannel(channel).label, grantTtlDays: GRANT_DAYS, deriveToken: (id) => deriveChannelToken(channel, id),
    inTx: async (c, ids) => {
      await c.query(
        `INSERT INTO channel_identities (channel,sender_hash,task_id,grant_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (channel,sender_hash) DO UPDATE SET task_id=EXCLUDED.task_id, grant_id=EXCLUDED.grant_id, updated_at=now()`,
        [channel, hash, ids.taskId, ids.grantId],
      );
      await c.query(`UPDATE channel_inbox SET task_id=$2 WHERE id=$1`, [row.id, ids.taskId]);
      dest = await inferForSender(c, ids.taskId, channel, hash, row.sender as string);
    },
  });
  await seedDemoOffers(made.taskId).catch(() => console.error("channel_error", "seed_demo"));
  await seedExternalOffers(made.taskId, title).catch(() => console.error("channel_error", "seed_external"));
  return { taskId: made.taskId, token: made.token, fresh: true, dest };
}

async function finish(channel: string, row: Row, body: string) {
  await tx(async (c) => {
    await c.query(
      `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [randomUUID(), channel, row.sender, body, `inbox:${row.id}`],
    );
    await c.query(`UPDATE channel_inbox SET state='done', image_b64=NULL, sender='', body='', place_county=NULL, place_area=NULL, locked_until=NULL WHERE id=$1`, [row.id]);
  });
}

// The open task for this sender, without creating one
async function openTask(channel: string, hash: string) {
  const e = (await tx((c) => c.query(`SELECT task_id, grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2`, [channel, hash]))).rows[0];
  if (!e) return null;
  const token = deriveChannelToken(channel, e.grant_id);
  const v = await getTaskView(e.task_id, token).catch(() => null);
  return v && v.nextAction !== "paid" && v.nextAction !== "cancelled" ? { taskId: e.task_id as string, token } : null;
}

// A pin or a short answer sets where to deliver; no AI call, no coordinates kept
async function handleDestination(channel: string, row: Row): Promise<string | null> {
  const hash = senderHash(channel, row.sender as string);
  if (row.place_area === "outside_kenya") return "That pin is outside Kenya. I deliver within Kenya: name the town or area instead.";
  const task = await openTask(channel, hash);
  if (row.place_county) {
    const p = { county: row.place_county as string, area: (row.place_area as string) ?? "" };
    await tx(async (c) => {
      const cur = task ? await getDestination(c, task.taskId) : null;
      await saveProfile(c, channel, hash, { ...p, handling: cur?.handling ?? "door" });
      if (task) await putDestination(c, task.taskId, p, "location", true);
    });
    return `Got it: I'll deliver to ${placeLabel(p)}. I'll remember this for next time.${task ? `\n\nYour task: ${link(task.taskId, task.token)}` : ""}`;
  }
  const text = (row.body as string) || "";
  if (!task || !text || row.image_b64) return null;
  return tx(async (c) => {
    const cur = await getDestination(c, task.taskId);
    if (cur?.confirmed) return null;
    const p = answerFromText(text, cur);
    if (!p) return null;
    await putDestination(c, task.taskId, p, "answer", true);
    await saveProfile(c, channel, hash, { ...p, handling: cur?.handling ?? "door" });
    return `Delivering to ${placeLabel(p)}. I'll remember this for next time.\n\nYour task: ${link(task.taskId, task.token)}`;
  });
}

async function processRow(channel: string, row: Row) {
  const answered = await handleDestination(channel, row);
  if (answered) return finish(channel, row, answered);
  const image = row.image_b64 ? { mime: row.image_mime as string, base64: row.image_b64 as string } : undefined;
  const { taskId, token, fresh, dest } = await resolveTask(channel, row, !!image);
  const ex = await postExchange(taskId, token, { channel, key: `${channel}:${row.provider_message_id}`, text: (row.body as string) || undefined, image });
  const reply = ex.messages.find((m) => m.role === "assistant")?.body ?? "";
  const where = dest === "ask" ? askLine(null) : dest === "known"
    ? `Delivering to ${placeLabel((await tx((c) => getDestination(c, taskId)))!)}, as last time.` : "";
  const body = composeReply({ reply: where ? `${reply.trim()}\n\n${where}` : reply, proposals: ex.proposals as never, link: link(taskId, token), fresh,
    maxChars: getChannel(channel).maxReplyChars });
  await finish(channel, row, body);
}

// Handles queued messages for one channel, or every configured one; safe to call concurrently
export async function processInboxOnce(channel?: string, max = 10): Promise<number> {
  await purgeOld();
  const channels = channel ? [channel] : channelIds().filter((id) => isConfigured(id));
  let total = 0;
  for (const ch of channels) {
    for (let n = 0; n < max; n++) {
      const row = await claimInbox(ch);
      if (!row) break;
      total++;
      try {
        await processRow(ch, row);
      } catch (e) {
        console.error("channel_error", "inbox_failed", (e as { code?: string }).code ?? (e as Error)?.name);
      }
    }
  }
  return total;
}

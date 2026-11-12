import { randomUUID } from "node:crypto";
import { seedDemoOffers, seedExternalOffers } from "@/catalog/demo";
import { postExchange } from "@/chat/exchange";
import { validateImage } from "@/chat/image";
import { FX_BUFFER_PCT } from "@/delivery/fx";
import { placeFromPin } from "@/delivery/places";
import { tx } from "@/domain/db";
import { subscribe } from "@/domain/concierge";
import { answerFromText, askLine, getDestination, inferForSender, placeLabel, putDestination, saveProfile } from "@/domain/destination";
import { DomainError } from "@/domain/errors";
import { getDelivery } from "@/domain/delivery";
import { claimExternalSearch } from "@/domain/offers";
import { createInvite, createSellerOrder, createTask, getComparison, selectOffer } from "@/domain/tasks";
import { getTaskView } from "@/domain/view";
import { deriveChannelToken, senderHash } from "./bridge";
import { admitted, handleJoinOrStop } from "./join";
import { menuCards, renderChosen, renderOptions } from "./render";
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
  // A shared contact card: only its display name, used as a label
  contactName?: string;
}

export function parseInbound(def: ChannelDef, b: Record<string, unknown>): InboundInput {
  const id = b.providerMessageId, sender = b.sender, text = b.text, image = b.image, at = b.receivedAt, loc = b.location, card = b.contact;
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
  let contactName: string | undefined;
  if (card !== undefined) {
    const name = typeof card === "object" && card !== null ? (card as Record<string, unknown>).name : undefined;
    if (typeof name !== "string" || !name.trim()) throw new DomainError("invalid", "contact");
    contactName = name.replace(/[^\p{L}\p{N} .'-]/gu, "").trim().slice(0, 40) || "them";
  }
  if (!text?.trim() && !img && !place && !contactName) throw new DomainError("invalid", "empty message");
  return { providerMessageId: id, sender, text: text?.trim() || undefined, image: img, receivedAt: when.toISOString(),
    ...(place ? { place } : {}), ...(contactName ? { contactName } : {}) };
}

// Persist first, process later: a restart or retry can never lose or repeat a message
export async function enqueueInbound(channel: string, m: InboundInput): Promise<"accepted" | "duplicate" | "ignored"> {
  if (!allowedSenders(channel).has(m.sender) && !(await admitted(channel, m.sender, m.text))) return "ignored";
  return tx(async (c) => {
    const r = await c.query(
      `INSERT INTO channel_inbox (id,channel,provider_message_id,sender,body,image_mime,image_b64,received_at,place_county,place_area,contact_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (channel, provider_message_id) DO NOTHING`,
      [randomUUID(), channel, m.providerMessageId, m.sender, m.text ?? "", m.image?.mime ?? null, m.image?.base64 ?? null, m.receivedAt,
        m.place === "outside_kenya" ? "" : m.place?.county ?? null, m.place === "outside_kenya" ? "outside_kenya" : m.place?.area ?? null, m.contactName ?? null],
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
    // Status pushes stop 14 days after delivery or cancellation, and after 120 days regardless
    await c.query(`DELETE FROM channel_subscriptions s WHERE s.created_at < now() - interval '120 days'
      OR EXISTS (SELECT 1 FROM fulfilment_events e WHERE e.task_id=s.task_id AND e.status IN ('delivered','cancelled','stock_out')
                 AND e.occurred_at < now() - interval '14 days')`);
    await c.query(`DELETE FROM channel_menus WHERE created_at < now() - interval '30 days'`);
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
    await c.query(`UPDATE channel_inbox SET state='failed', image_b64=NULL, sender='', body='', place_county=NULL, place_area=NULL, contact_name=NULL WHERE channel=$2 AND state='processing' AND locked_until < now() AND attempts >= $1`, [MAX_ATTEMPTS, channel]);
    const r = await c.query(
      `UPDATE channel_inbox SET state='processing', attempts=attempts+1, locked_until=now()+interval '3 minutes'
        WHERE id = (SELECT id FROM channel_inbox WHERE channel=$1 AND (state='received' OR (state='processing' AND locked_until < now()))
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [channel],
    );
    return (r.rows[0] as Row | undefined) ?? null;
  });
}

export function composeReply(o: { reply: string; extra?: string[]; proposals: { key: string; op: string; value: string | number; unit?: string }[]; link: string; fresh: boolean; maxChars: number }) {
  const tail = o.fresh ? `Your task is ready: ${o.link}` : `Your task: ${o.link}`;
  const head = [o.reply.trim().slice(0, o.maxChars < 1000 ? 140 : 600), ...(o.extra ?? []).filter(Boolean)];
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
    title, starterRoles: ["requester", "chooser", "helper", "payer"], starterLabel: getChannel(channel).label, grantTtlDays: GRANT_DAYS, deriveToken: (id) => deriveChannelToken(channel, id),
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
  return { taskId: made.taskId, token: made.token, fresh: true, dest };
}

async function finish(channel: string, row: Row, body: string) {
  await tx(async (c) => {
    await c.query(
      `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [randomUUID(), channel, row.sender, body, `inbox:${row.id}`],
    );
    await c.query(`UPDATE channel_inbox SET state='done', image_b64=NULL, sender='', body='', place_county=NULL, place_area=NULL, contact_name=NULL, locked_until=NULL WHERE id=$1`, [row.id]);
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
      await saveProfile(c, channel, hash, { ...p, handling: "door" });
      if (task) await putDestination(c, task.taskId, p, "location", true, "door");
    });
    return `Got it: I'll deliver to your door in ${placeLabel(p)}. I'll remember this for next time.${task ? `\n\nYour task: ${link(task.taskId, task.token)}` : ""}`;
  }
  const text = (row.body as string) || "";
  if (!task || !text || row.image_b64) return null;
  return tx(async (c) => {
    const cur = await getDestination(c, task.taskId);
    if (cur?.confirmed) return null;
    const a = answerFromText(text, cur);
    if (!a) return null;
    const p = { county: a.county, area: a.area };
    await putDestination(c, task.taskId, p, "answer", true, a.handling);
    await saveProfile(c, channel, hash, { ...p, handling: a.handling });
    const what = a.handling === "pickup" ? "You'll collect it in Nairobi" : `Delivering to your door in ${placeLabel(p)}`;
    return `${what}. I'll remember this for next time.\n\nYour task: ${link(task.taskId, task.token)}`;
  });
}

// Same buffered rate as the cards' top end, since the card is charged in USD
const kes = (minor: number, rate?: number) =>
  (rate ? `about KSh ${(Math.round((minor * rate * (1 + (FX_BUFFER_PCT.USD ?? 5) / 100)) / 1e10) * 100).toLocaleString("en-KE")}` : null);

// "1", "2"... picks from the options this sender was last shown; money is
// only ever approved on the signed page
async function handleChoice(channel: string, row: Row): Promise<string | null> {
  const m = /^\s*([1-9])\s*[.)]?\s*$/.exec((row.body as string) || "");
  if (!m || row.image_b64) return null;
  const hash = senderHash(channel, row.sender as string);
  const task = await openTask(channel, hash);
  if (!task) return null;
  const menu = (await tx((c) => c.query(`SELECT offer_ids FROM channel_menus WHERE task_id=$1 AND channel=$2 AND sender_hash=$3`, [task.taskId, channel, hash]))).rows[0];
  const offerId = menu?.offer_ids?.[Number(m[1]) - 1] as string | undefined;
  if (!offerId) return menu ? `Please reply with a number from the list, or open: ${link(task.taskId, task.token)}` : null;
  const cmp = await getComparison(task.taskId, task.token);
  const key = `${channel}:${row.provider_message_id}`;
  try {
    const sel = await selectOffer(task.taskId, task.token, { offerId, expectedVersion: cmp.version }, { idempotencyKey: key });
    const order = await createSellerOrder(task.taskId, task.token, { selectionId: sel.selectionId });
    const v = await getTaskView(task.taskId, task.token);
    const c = v.order?.concierge;
    const fx = c ? (await tx((x) => x.query(`SELECT fx FROM concierge_orders WHERE seller_order_id=$1`, [order.id]))).rows[0]?.fx : null;
    return renderChosen({ title: order.title, totalMinor: order.totalMinor, currency: order.currency, concierge: order.kind === "concierge",
      arrival: c?.arrival ?? null, kes: kes(order.totalMinor, fx?.USD?.kesPerUnitMicro) }, link(task.taskId, task.token));
  } catch (e) {
    if (e instanceof DomainError && (e.code === "not_payable" || e.code === "stale" || e.code === "invalid"))
      return `That one can't be paid in one step yet: ${e.message}. Pick another number, or open: ${link(task.taskId, task.token)}`;
    throw e;
  }
}

// A contact card becomes a link that person can use to pay; no number is kept
async function handleContact(channel: string, row: Row): Promise<string | null> {
  if (!row.contact_name) return null;
  const task = await openTask(channel, senderHash(channel, row.sender as string));
  if (!task) return "Send me what you're looking for first, then share the contact who will pay.";
  const name = row.contact_name as string;
  const inv = await createInvite(task.taskId, task.token, { roles: ["payer"], label: name });
  return `Forward this link to ${name} so they can review and pay. It only lets them pay, not change the choice:\n${link(task.taskId, inv.token)}`;
}

async function optionsBlock(channel: string, hash: string, taskId: string, token: string): Promise<string> {
  const d = await getDelivery(taskId, token).catch(() => null);
  if (!d) return "";
  const compact = getChannel(channel).maxReplyChars < 1000;
  const cards = menuCards(d.cards, compact ? 2 : 3);
  if (!cards.length) return "";
  await tx((c) => c.query(
    `INSERT INTO channel_menus (task_id,channel,sender_hash,offer_ids) VALUES ($1,$2,$3,$4)
     ON CONFLICT (task_id,channel,sender_hash) DO UPDATE SET offer_ids=EXCLUDED.offer_ids, created_at=now()`,
    [taskId, channel, hash, cards.map((x) => x.offerId)]));
  const door = d.input.handling === "door";
  const head = !door ? "To collect in Nairobi, all costs in:" : d.destination?.confirmed ? `Delivered to ${placeLabel(d.destination)}:` : "Delivered to Kenya:";
  return renderOptions(cards, head, compact);
}

async function processRow(channel: string, row: Row) {
  if (row.body && !row.image_b64) {
    const joined = await tx((c) => handleJoinOrStop(c, channel, senderHash(channel, row.sender as string), row.sender as string, row.body as string));
    if (joined) return finish(channel, row, joined);
  }
  const contact = await handleContact(channel, row);
  if (contact) return finish(channel, row, contact);
  const answered = await handleDestination(channel, row);
  if (answered) return finish(channel, row, answered);
  const chosen = await handleChoice(channel, row);
  if (chosen) return finish(channel, row, chosen);
  const image = row.image_b64 ? { mime: row.image_mime as string, base64: row.image_b64 as string } : undefined;
  const { taskId, token, fresh, dest } = await resolveTask(channel, row, !!image);
  await tx((c) => subscribe(c, taskId, channel, senderHash(channel, row.sender as string), row.sender as string, true));
  const ex = await postExchange(taskId, token, { channel, key: `${channel}:${row.provider_message_id}`, text: (row.body as string) || undefined, image });
  // No item named by the AI: search the words they sent, once
  if (fresh && row.body && (await claimExternalSearch(taskId, row.body as string)))
    await seedExternalOffers(taskId, (row.body as string).slice(0, 80)).catch(() => console.error("channel_error", "seed_external"));
  const reply = ex.messages.find((m) => m.role === "assistant")?.body ?? "";
  const known = dest === "known" ? await tx((c) => getDestination(c, taskId)) : null;
  const where = dest === "ask" ? askLine() : known
    ? (known.handling === "pickup" ? "You'll collect it in Nairobi, as last time." : `Delivering to your door in ${placeLabel(known)}, as last time.`) : "";
  const options = await optionsBlock(channel, senderHash(channel, row.sender as string), taskId, token);
  const body = composeReply({ reply, extra: [options, where], proposals: ex.proposals as never, link: link(taskId, token), fresh,
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

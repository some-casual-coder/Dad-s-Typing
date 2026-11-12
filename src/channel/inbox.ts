import { randomUUID } from "node:crypto";
import { seedDemoOffers, seedExternalOffers } from "@/catalog/demo";
import { postExchange } from "@/chat/exchange";
import { validateImage } from "@/chat/image";
import { FX_BUFFER_PCT } from "@/delivery/fx";
import { placeFromPin } from "@/delivery/places";
import { tx, type Tx } from "@/domain/db";
import { subscribe } from "@/domain/concierge";
import { answerFromText, askLine, getDestination, inferForSender, placeLabel, putDestination, saveProfile } from "@/domain/destination";
import { DomainError } from "@/domain/errors";
import { getDelivery } from "@/domain/delivery";
import { claimExternalSearch } from "@/domain/offers";
import { createInvite, createSellerOrder, createTask, getComparison, selectOffer } from "@/domain/tasks";
import type { Attribute, Requirement } from "@/domain/eligibility";
import { pendingProposals } from "@/domain/messages";
import { getTaskView } from "@/domain/view";
import { findLinks, LABEL, withoutSocialLinks } from "@/sources/recognize";
import { chooseCandidate } from "@/sources/intake";
import { address, contentHash, deriveChannelToken, openRecipient, senderHash } from "./bridge";
import { admitted, handleJoinOrStop, handleStart, optedOut, optOut } from "./join";
import { menuCards, renderChosen, renderOptions } from "./render";
import { allowedSenders, channelIds, getChannel, isConfigured, type ChannelDef } from "./registry";

const MAX_ATTEMPTS = 5;
const GRANT_DAYS = 14;
const CONSENT = "Photos and messages you send are read by an AI service to help with this task.";
const SORRY = "Sorry, I could not process that message. Please send it again.";
const MAX_IMAGE_B64 = Math.ceil(4 * 1024 * 1024 * 1.4);

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ATTACHMENT_ERRORS = new Set(["expired", "private", "unavailable", "unsupported", "too_large"]);
const KINDS = new Set(["message", "status", "echo", "opt_out", "opt_in"]);
const DELIVERY = new Set(["delivered", "read", "failed"]);

export interface InboundInput {
  kind: "message" | "status" | "echo" | "opt_out" | "opt_in";
  // The connector's own account (a Page, a business account, a number):
  // the same person id on two accounts is two separate people here
  providerMessageId: string; sender: string; rawSender: string; text?: string;
  image?: { mime: string; base64: string }; receivedAt: string;
  // The connector got an attachment it could not fetch or pass on
  attachmentError?: string;
  // A delivery or read receipt for one of our replies
  status?: { refersTo: string; state: "delivered" | "read" | "failed" };
  // Mapped from a location pin; the coordinates themselves are dropped
  place?: { county: string; area: string } | "outside_kenya";
  // A shared contact card: only its display name, used as a label
  contactName?: string;
}


export function parseInbound(def: ChannelDef, b: Record<string, unknown>): InboundInput {
  const id = b.providerMessageId, sender = b.sender, text = b.text, image = b.image, at = b.receivedAt, loc = b.location, card = b.contact;
  const kind = (b.kind ?? "message") as InboundInput["kind"], account = b.account;
  if (typeof kind !== "string" || !KINDS.has(kind)) throw new DomainError("invalid", "kind");
  if (account !== undefined && (typeof account !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(account))) throw new DomainError("invalid", "account");
  if (typeof id !== "string" || !ID.test(id)) throw new DomainError("invalid", "providerMessageId");
  if (typeof sender !== "string" || !def.sender.test(sender) || /\s/.test(sender)) throw new DomainError("invalid", "sender");
  if (text !== undefined && (typeof text !== "string" || text.length > 4000)) throw new DomainError("invalid", "text");
  const when = typeof at === "string" ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime())) throw new DomainError("invalid", "receivedAt");
  const base = { kind, providerMessageId: address(account as string | undefined, id), sender: address(account as string | undefined, sender), rawSender: sender, receivedAt: when.toISOString() };
  if (kind === "status") {
    const s = b.state, ref = b.refersTo;
    if (typeof ref !== "string" || !ID.test(ref)) throw new DomainError("invalid", "refersTo");
    if (typeof s !== "string" || !DELIVERY.has(s)) throw new DomainError("invalid", "state");
    return { ...base, status: { refersTo: ref, state: s as "delivered" | "read" | "failed" } };
  }
  if (kind !== "message") return base;
  let img: InboundInput["image"];
  let attachmentError: string | undefined;
  if (b.attachment !== undefined) {
    const e = (b.attachment as Record<string, unknown> | null)?.error;
    if (typeof e !== "string" || !ATTACHMENT_ERRORS.has(e)) throw new DomainError("invalid", "attachment");
    attachmentError = e;
  }
  if (image !== undefined) {
    if (!def.images) throw new DomainError("invalid", "this channel does not accept images");
    const o = image as Record<string, unknown>;
    if (typeof o !== "object" || o === null || typeof o.mime !== "string" || typeof o.base64 !== "string") throw new DomainError("invalid", "image");
    // A photo we cannot use gets the same recovery step as one the connector could not fetch
    if (o.base64.length > MAX_IMAGE_B64) attachmentError = "too_large";
    else {
      try { validateImage(o.mime, o.base64); img = { mime: o.mime, base64: o.base64 }; } catch { attachmentError = "unsupported"; }
    }
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
  if (!text?.trim() && !img && !place && !contactName && !attachmentError) throw new DomainError("invalid", "empty message");
  return { ...base, text: text?.trim() || undefined, image: img, ...(attachmentError ? { attachmentError } : {}),
    ...(place ? { place } : {}), ...(contactName ? { contactName } : {}) };
}

const RANK: Record<string, number> = { delivered: 1, read: 2, failed: 3 };

// Persist first, process later: a restart or retry can never lose or repeat a message.
// Receipts and our own echoed replies never become a shopping turn.
export async function enqueueInbound(channel: string, m: InboundInput): Promise<"accepted" | "duplicate" | "conflict" | "ignored" | "recorded"> {
  if (m.kind === "echo") return "ignored";
  if (m.kind === "status") {
    // Only moves forward; delivered or read is never a choice or a payment
    await tx((c) => c.query(
      `UPDATE channel_outbox SET delivery=$3, updated_at=now() WHERE channel=$1 AND provider_message_id=$2
         AND (delivery IS NULL OR $4 > CASE delivery WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 ELSE 3 END)`,
      [channel, m.status!.refersTo, m.status!.state, RANK[m.status!.state]]));
    return "recorded";
  }
  const hashed = senderHash(channel, m.sender);
  if (m.kind === "opt_out") { await tx((c) => optOut(c, channel, hashed, m.sender)); return "accepted"; }
  const known = allowedSenders(channel).has(m.rawSender) || (await admitted(channel, m.sender, m.text));
  if (!known) return "ignored";
  if (m.kind === "opt_in") { await tx((c) => c.query(`DELETE FROM channel_opt_outs WHERE channel=$1 AND sender_hash=$2`, [channel, hashed])); return "accepted"; }
  const content = contentHash(channel, JSON.stringify([m.sender, m.text ?? "", m.image?.base64 ?? "", m.attachmentError ?? "", m.place ?? "", m.contactName ?? ""]));
  return tx(async (c) => {
    const r = await c.query(
      `INSERT INTO channel_inbox (id,channel,provider_message_id,sender,body,image_mime,image_b64,received_at,place_county,place_area,contact_name,content_hash,attachment_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (channel, provider_message_id) DO NOTHING`,
      [randomUUID(), channel, m.providerMessageId, m.sender, m.text ?? "", m.image?.mime ?? null, m.image?.base64 ?? null, m.receivedAt,
        m.place === "outside_kenya" ? "" : m.place?.county ?? null, m.place === "outside_kenya" ? "outside_kenya" : m.place?.area ?? null, m.contactName ?? null,
        content, m.attachmentError ?? null],
    );
    if (r.rowCount) return "accepted";
    // Same id, different content: keep what was accepted and say so
    const prior = (await c.query(`SELECT content_hash FROM channel_inbox WHERE channel=$1 AND provider_message_id=$2`, [channel, m.providerMessageId])).rows[0];
    return prior?.content_hash && prior.content_hash !== content ? "conflict" : "duplicate";
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
    // A photo waits a moment so the rest of a burst of screenshots arrives too
    const r = await c.query(
      `UPDATE channel_inbox SET state='processing', attempts=attempts+1, locked_until=now()+interval '3 minutes'
        WHERE id = (SELECT id FROM channel_inbox WHERE channel=$1 AND (state='received' OR (state='processing' AND locked_until < now()))
                      AND (image_b64 IS NULL OR created_at <= now() - make_interval(secs => $2::float8 / 1000))
                    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      [channel, BURST_MS()],
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
  const all = head.filter(Boolean).join("\n\n");
  // Cut at the end of a line or sentence, never mid-sentence
  let words = all;
  if (all.length > room) {
    const cut = all.slice(0, room);
    const stop = [...cut.matchAll(/[.!?](?=\s|$)/g)].at(-1)?.index ?? -1;
    const end = Math.max(cut.lastIndexOf("\n"), stop);
    words = (end > room / 3 ? cut.slice(0, end + (cut[end] === "\n" ? 0 : 1)) : cut.slice(0, Math.max(room - 1, 0)) + "…").trimEnd();
  }
  return words ? `${words}\n\n${tail}` : tail;
}

const link = (taskId: string, token: string) => `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/t/${taskId}#k=${token}`;

// Text and photos continue the latest open request, so a forwarded run of
// messages (what, a label photo, a budget) stays one search. A new shared post,
// NEW, or a paid or cancelled order starts the next one.

async function resolveTask(channel: string, row: Row) {
  const hash = senderHash(channel, row.sender as string);
  // A new shared post is a new thing to buy, like a new photo
  const newLink = findLinks((row.body as string) ?? "").some((f) => f.type === "social");
  const latest = (await tx((c) => c.query(`SELECT task_id, grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2`, [channel, hash]))).rows[0];
  const existing = newLink ? undefined : latest;
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
  const link = findLinks((row.body as string) ?? "").find((f) => f.type === "social");
  const said = withoutSocialLinks((row.body as string) ?? "");
  const title = (said || (link?.type === "social" ? `Shared ${LABEL[link.ref.platform]} post` : `Request from ${getChannel(channel).label}`))
    .replace(/\s+/g, " ").slice(0, 80);
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
  await seedDemoOffers(made.taskId, title).catch(() => console.error("channel_error", "seed_demo"));
  return { taskId: made.taskId, token: made.token, fresh: true, dest };
}

export const BURST_MS = () => Number(process.env.CHANNEL_BURST_MS ?? 4000);

// Photos sent in a burst are all read, but only the last one is answered
async function moreComing(channel: string, row: Row): Promise<boolean> {
  if (!row.image_b64) return false;
  return !!(await tx((c) => c.query(
    `SELECT 1 FROM channel_inbox WHERE channel=$1 AND sender=$2 AND id<>$3 AND state='received' AND image_b64 IS NOT NULL
       AND created_at >= $4 AND created_at <= $4::timestamptz + make_interval(secs => $5::float8 / 1000 * 2)`,
    [channel, row.sender, row.id, row.created_at, BURST_MS()]))).rowCount;
}

// Chat apps read best as short messages: each paragraph is sent on its own,
// in order, a moment apart (CHANNEL_SPLIT_MESSAGES=0 keeps one per reply)
export function chatParts(bodies: string | string[], env: Record<string, string | undefined> = process.env): string[] {
  const all = [bodies].flat().filter(Boolean);
  if (env.CHANNEL_SPLIT_MESSAGES === "0") return all;
  return all.flatMap((b) => b.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean));
}

async function enqueueParts(c: Tx, channel: string, recipient: string, bodies: string | string[], key: string) {
  for (const [i, b] of chatParts(bodies).entries()) await c.query(
    `INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key,not_before)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int > 0 THEN now() + make_interval(secs => 1.5 * $6::int) END) ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), channel, recipient, b, i ? `${key}:${i}` : key, i],
  );
}

async function finish(channel: string, row: Row, body: string | string[]) {
  await tx(async (c) => {
    await enqueueParts(c, channel, row.sender as string, body, `inbox:${row.id}`);
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
  const proposed = (await pendingProposals(taskId, token).catch(() => [])) as Requirement[];
  const ids = [...d.cards.closest, ...d.cards.similar].map((x) => x.offerId);
  const attrs = new Map((await tx((c) => c.query(`SELECT id, attributes FROM offers WHERE task_id=$1 AND id = ANY($2::uuid[])`, [taskId, ids]))).rows
    .map((r) => [r.id as string, (r.attributes ?? {}) as Record<string, Attribute>]));
  const cards = menuCards(d.cards, compact ? 2 : 3, proposed, attrs);
  if (!cards.length) return "";
  await tx((c) => c.query(
    `INSERT INTO channel_menus (task_id,channel,sender_hash,offer_ids) VALUES ($1,$2,$3,$4)
     ON CONFLICT (task_id,channel,sender_hash) DO UPDATE SET offer_ids=EXCLUDED.offer_ids, created_at=now()`,
    [taskId, channel, hash, cards.map((x) => x.offerId)]));
  const door = d.input.handling === "door";
  const head = !door ? "To collect in Nairobi, all costs in:" : d.destination?.confirmed ? `Delivered to ${placeLabel(d.destination)}:` : "Delivered to Kenya:";
  const budget = Number(d.input.budgetKesMinor ?? 0) / 100 || undefined;
  return renderOptions(cards, head, compact, budget);
}

// "around KSh 3,000", "budget 3k", "3,000 bob": a KES amount the shopper set,
// kept as whole shillings; it marks options, it never hides them
export function budgetFrom(text: string): number | null {
  const t = text.replace(/,(?=\d{3}\b)/g, "");
  const m = /\b(?:ksh|kes|sh)\.?\s*(\d+(?:\.\d+)?)\s*(k)?\b/i.exec(t)
    ?? /\b(\d+(?:\.\d+)?)\s*(k)?\s*(?:ksh|kes|bob|shillings?)\b/i.exec(t)
    ?? /\bbudget\b[^\d]{0,20}(\d+(?:\.\d+)?)\s*(k)?\b/i.exec(t);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  return n >= 50 && n <= 10_000_000 ? n : null;
}

async function saveBudget(taskId: string, kes: number) {
  await tx((c) => c.query(
    `INSERT INTO delivery_plans (task_id,budget_kes_minor,budget_includes_delivery) VALUES ($1,$2,true)
     ON CONFLICT (task_id) DO UPDATE SET budget_kes_minor=EXCLUDED.budget_kes_minor, budget_includes_delivery=true, updated_at=now()`,
    [taskId, kes * 100]));
}

const NEW_CMD = /^\s*(new|restart|start over|new search)\s*[.!]*\s*$/i;
const END_CMD = /^\s*(done|end|finish|close|end chat)\s*[.!]*\s*$/i;
export const NEW_REPLY = "Okay, starting fresh. What are you looking for? Send a photo, a link or a few words.";
const ended = (link?: string) =>
  `Okay, that search is closed.${link ? ` It's still here if you need it: ${link}` : ""}\n\nWhen you want something else, just send a photo or a few words.`;

// NEW starts the next search; DONE closes this one. Either way the old task
// keeps its link, and order updates for anything paid carry on.
async function handleRestart(channel: string, row: Row): Promise<string | null> {
  const text = (row.body as string) || "";
  const fresh = NEW_CMD.test(text), end = !fresh && END_CMD.test(text);
  if (row.image_b64 || (!fresh && !end)) return null;
  const hash = senderHash(channel, row.sender as string);
  const task = await openTask(channel, hash);
  await tx((c) => c.query(`DELETE FROM channel_identities WHERE channel=$1 AND sender_hash=$2`, [channel, hash]));
  if (fresh) return NEW_REPLY;
  return task ? ended(link(task.taskId, task.token)) : "There's no open search right now. Send a photo or a few words to start one.";
}

// A video check that ends sends one message to whoever is chatting about that
// task: the likeliest item with options, or a plain "send screenshots"
export async function videoFollowUp(attemptId: string) {
  const a = (await tx((c) => c.query(
    `SELECT a.state, a.source_id, s.task_id, s.platform FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE a.id=$1`, [attemptId]))).rows[0];
  if (!a) return;
  // Only while it is still their current search (after NEW it would be noise),
  // and only to someone still subscribed: after STOP they get no pushes
  const who = (await tx((c) => c.query(
    `SELECT i.channel, i.sender_hash, i.grant_id, s.recipient_enc FROM channel_identities i
       JOIN channel_subscriptions s ON s.task_id=i.task_id AND s.channel=i.channel AND s.sender_hash=i.sender_hash
      WHERE i.task_id=$1 LIMIT 1`, [a.task_id]))).rows[0];
  const to = who ? openRecipient(who.channel, who.recipient_enc) : null;
  if (!who || !to) return;
  const token = deriveChannelToken(who.channel, who.grant_id);
  const cands = (await tx((c) => c.query(
    `SELECT id, label, status FROM product_candidates WHERE source_id=$1 ORDER BY created_at`, [a.source_id]))).rows;
  const proposed = cands.filter((k) => k.status === "proposed");
  // They added screenshots or chose meanwhile: their evidence leads, stay quiet
  if (a.state === "completed" && !proposed.length && cands.length) return;
  const name = LABEL[a.platform as keyof typeof LABEL] ?? "video";
  let body: string;
  if (a.state !== "completed" || !proposed.length) {
    body = `I checked the ${name} video but couldn't make out the product clearly. Send me screenshots of it here (one or more is fine), or tell me what it is.`;
  } else {
    await chooseCandidate(a.task_id, token, proposed[0].id);
    const others = proposed.slice(1, 4).map((k) => k.label as string);
    const options = await optionsBlock(who.channel, who.sender_hash, a.task_id, token);
    body = [
      `From the ${name} video, I think it's *${proposed[0].label}*.${others.length ? ` I also spotted: ${others.join(", ")}. Send the name if you meant one of those.` : ""}`,
      options || "I'm still finding where to buy it. Screenshots of the product help me narrow it down.",
      "*Not quite right? Send photos or screenshots of the product. I read those much better than videos.*",
      `Your task: ${link(a.task_id, token)}`,
    ].join("\n\n");
  }
  await tx((c) => enqueueParts(c, who.channel, to, body, `video:${attemptId}`));
}

const UNOPENED = "I couldn't open that photo or attachment here, so I haven't used it. Send a screenshot or tell me what you're looking for.";

// After an order is paid or cancelled, a bare message may be about that order:
// ask instead of opening a new task from it. "NEW ..." or a photo starts one.
async function afterFinished(channel: string, row: Row): Promise<string | null> {
  const text = (row.body as string) || "";
  if (!text || row.image_b64 || row.attachment_error || findLinks(text).some((f) => f.type === "social")) return null;
  const e = (await tx((c) => c.query(`SELECT task_id, grant_id FROM channel_identities WHERE channel=$1 AND sender_hash=$2`, [channel, senderHash(channel, row.sender as string)]))).rows[0];
  if (!e) return null;
  const token = deriveChannelToken(channel, e.grant_id);
  const v = await getTaskView(e.task_id, token).catch(() => null);
  if (!v || (v.nextAction !== "paid" && v.nextAction !== "cancelled")) return null;
  const fresh = /^\s*new\b[\s:,.-]*/i.exec(text);
  if (fresh) {
    row.body = text.slice(fresh[0].length).trim();
    return row.body ? null : "What are you looking for? Send a photo or a few words.";
  }
  return `Is this about "${v.title}" (${v.nextAction === "paid" ? "paid" : "cancelled"}) or something new? For something new, send a photo, or reply NEW and what you want.\n\nYour order: ${link(e.task_id, token)}`;
}

async function processRow(channel: string, row: Row) {
  if (row.body && !row.image_b64) {
    const intro = await tx((c) => handleStart(c, channel, senderHash(channel, row.sender as string), row.body as string));
    if (intro) return finish(channel, row, intro);
    const joined = await tx((c) => handleJoinOrStop(c, channel, senderHash(channel, row.sender as string), row.sender as string, row.body as string));
    if (joined) return finish(channel, row, joined);
  }
  if (row.attachment_error && !row.body) {
    const task = await openTask(channel, senderHash(channel, row.sender as string));
    return finish(channel, row, task ? `${UNOPENED}\n\nYour task: ${link(task.taskId, task.token)}` : UNOPENED);
  }
  const restart = await handleRestart(channel, row);
  if (restart) return finish(channel, row, restart);
  const ask = await afterFinished(channel, row);
  if (ask) return finish(channel, row, ask);
  // Saved first, whichever handler answers the message
  const budget = budgetFrom((row.body as string) || "");
  const open = budget ? await openTask(channel, senderHash(channel, row.sender as string)) : null;
  if (budget && open) await saveBudget(open.taskId, budget);
  const contact = await handleContact(channel, row);
  if (contact) return finish(channel, row, contact);
  const answered = await handleDestination(channel, row);
  if (answered) return finish(channel, row, answered);
  const chosen = await handleChoice(channel, row);
  if (chosen) return finish(channel, row, chosen);
  const image = row.image_b64 ? { mime: row.image_mime as string, base64: row.image_b64 as string } : undefined;
  const { taskId, token, fresh, dest } = await resolveTask(channel, row);
  if (budget && !open) await saveBudget(taskId, budget);
  const hash = senderHash(channel, row.sender as string);
  // Someone who opted out gets replies to what they send, but no order updates until they JOIN again
  await tx(async (c) => { if (!(await optedOut(c, channel, hash))) await subscribe(c, taskId, channel, hash, row.sender as string, true); });
  const ex = await postExchange(taskId, token, { channel, key: `${channel}:${row.provider_message_id}`, text: (row.body as string) || undefined, image });
  // No item named by the AI: search the words they sent, once. Not for a
  // shared post: "my mom wants this" around a link is not a product
  const words = withoutSocialLinks((row.body as string) ?? "");
  const shared = findLinks((row.body as string) ?? "").some((f) => f.type === "social");
  if (fresh && words && !shared && (await claimExternalSearch(taskId, words)))
    await seedExternalOffers(taskId, words.slice(0, 80)).catch(() => console.error("channel_error", "seed_external"));
  const reply = ex.messages.find((m) => m.role === "assistant")?.body ?? "";
  const known = dest === "known" ? await tx((c) => getDestination(c, taskId)) : null;
  const where = dest === "ask" ? askLine() : known
    ? (known.handling === "pickup" ? "You'll collect it in Nairobi, as last time." : `Delivering to your door in ${placeLabel(known)}, as last time.`) : "";
  // A shared post names nothing yet: options wait for the video check or a screenshot
  const options = shared ? "" : await optionsBlock(channel, senderHash(channel, row.sender as string), taskId, token);
  const body = composeReply({ reply, extra: [row.attachment_error ? UNOPENED : "", options, where], proposals: ex.proposals as never, link: link(taskId, token), fresh,
    maxChars: getChannel(channel).maxReplyChars });
  await finish(channel, row, (await moreComing(channel, row)) ? [] : body);
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

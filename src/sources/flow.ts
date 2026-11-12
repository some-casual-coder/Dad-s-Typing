import { randomUUID } from "node:crypto";
import { seedExternalOffers } from "@/catalog/demo";
import { pool, tx } from "@/domain/db";
import { bumpEvidence, recordSources, supadataGate } from "./intake";
import { findLinks, LABEL, withoutSocialLinks, type SourceRef } from "./recognize";

export interface Intake { words: string; ack: string; toSubmit: string[]; linkTask: boolean }

// Copy that says what was received, never that a video was watched
// In a chat the shopper can't "open the task", so the next step is to send
// screenshots right there; the web page has its own add-a-screenshot control
export function ackFor(refs: SourceRef[], analysing: boolean, hasWords: boolean, chat = false): string {
  if (!refs.length) return "";
  const name = LABEL[refs[0].platform];
  if (chat) {
    if (refs.some((r) => r.kind === "profile" || r.kind === "other" || r.kind === "story") && refs.every((r) => !r.analysable))
      return `That ${name} link doesn't point to a single post. Send the post's own link, or screenshots of the product here.`;
    if (analysing) return `Got the ${name} link. I'm checking the video now and will message you here with what I can make out, usually within a minute or two. Screenshots of the product help too.`;
    return hasWords ? `Got the ${name} link, but I can't see inside the video from a link, so I'm going on what you said. Screenshots of the product help: send one or more here.`
      : `Got the ${name} link, but I can't see inside the video from a link. Send me screenshots of the product here (one or more is fine), or tell me what it is.`;
  }
  if (refs.some((r) => r.kind === "profile" || r.kind === "other" || r.kind === "story") && refs.every((r) => !r.analysable))
    return `That ${name} link doesn't point to a post I can use. Send the post itself, a screenshot of the item, or describe it.`;
  if (analysing) return `I've added the ${name} link. I'm checking what I can see; open your task to follow it or add a screenshot.`;
  return hasWords ? `I've added the ${name} link to your task. I can't read the video from a link, so I'm going on what you said; a screenshot of the item helps.`
    : `I've added the ${name} link. I can't read the video from a link: open your task and add a screenshot of the item, or tell me what it is.`;
}

export async function intakeLinks(taskId: string, messageKey: string, text: string, hasImage: boolean, chat = false): Promise<Intake> {
  const found = findLinks(text);
  const refs = found.flatMap((f) => (f.type === "social" ? [f.ref] : []));
  const words = refs.length ? withoutSocialLinks(text) : text;
  const linkTask = !!(await pool.query(`SELECT 1 FROM shared_sources WHERE task_id=$1 LIMIT 1`, [taskId])).rowCount;
  if (!refs.length) {
    // Any new evidence makes a pending provider result late, never in charge
    await tx(async (c) => {
      if (linkTask || hasImage) await bumpEvidence(c, taskId);
      if (hasImage && linkTask) await c.query(`INSERT INTO evidence_items (id,task_id,type,auth_mode,content) VALUES ($1,$2,'user_image','shopper_provided',$3)`,
        [randomUUID(), taskId, "Screenshot or photo the shopper added"]);
      if (text && linkTask) await c.query(`INSERT INTO evidence_items (id,task_id,type,auth_mode,content) VALUES ($1,$2,'user_text','shopper_provided',$3)`,
        [randomUUID(), taskId, text.slice(0, 500)]);
    });
    return { words, ack: "", toSubmit: [], linkTask };
  }
  const gates = new Map<string, boolean>();
  for (const r of refs) gates.set(r.identity, (await supadataGate(r)).on);
  const fresh = await tx((c) => recordSources(c, taskId, messageKey, refs, words, gates));
  const analysing = fresh.some((f) => f.analyse);
  return { words, ack: fresh.length ? ackFor(refs, analysing, !!words, chat) : `That ${LABEL[refs[0].platform]} link is already on this task.`,
    toSubmit: fresh.filter((f) => f.analyse).map((f) => f.id), linkTask: true };
}

// A link task searches again when the item is named, not on the URL
export async function searchFor(taskId: string, item: string, alreadySet: boolean) {
  if (!alreadySet) await pool.query(`UPDATE tasks SET search_query=$2 WHERE id=$1`, [taskId, item.slice(0, 300)]);
  await seedExternalOffers(taskId, item);
}

import { getInterpreter } from "@/adapters";
import { AdapterError, type Interpretation } from "@/adapters/types";
import { pool } from "@/domain/db";
import { DomainError } from "@/domain/errors";
import { getExchange, recordAssistantMessage } from "@/domain/messages";
import { addMessage, getComparison } from "@/domain/tasks";
import { claimExternalSearch } from "@/domain/offers";
import { seedDemoOffers } from "@/catalog/demo";
import { channelIds } from "@/channel/registry";
import { intakeLinks, searchFor } from "@/sources/flow";
import { submitPending } from "@/sources/intake";

export const FALLBACK = "I could not read that, please describe it.";

// The model has no reason to send links or contacts; injected ones are removed
export function scrubModelText(s: string): string {
  return s
    .replace(/\[\.\]|\(\.\)/g, ".")
    .replace(/\s*\bdot\b\s*(?=(?:com|net|org|io|co|ke|ly|me|app|dev|xyz|info|biz|us|uk|to|gl|gg|ai)\b)/gi, ".")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "")
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|co|ke|ly|me|app|dev|xyz|info|biz|us|uk|to|gl|gg|ai)\b(?:\/\S*)?/gi, "")
    .replace(/(^|\s)@\w{2,}/g, "$1")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// "Lenovo G50-30 charger 20V" after "Lenovo laptop charger": new words, not a rewording of fewer
export function sharper(known: string | null, item: string): boolean {
  if (!known) return false;
  const had = new Set(norm(known).split(" ")), now = norm(item).split(" ");
  return now.filter((w) => !had.has(w)).length >= 1 && now.length > had.size;
}

export interface ExchangeInput {
  channel: string; key: string; text?: string; image?: { mime: string; base64: string };
}

// One chat turn for every channel: store, interpret outside any DB tx, reply
export async function postExchange(taskId: string, token: string, input: ExchangeInput) {
  const added = await addMessage(taskId, token, {
    channel: input.channel, providerMessageId: input.key, body: input.text ?? "",
    mediaRef: input.image ? "inline:attached" : undefined,
  });
  if (added.duplicate) {
    const done = await getExchange(taskId, token, input.key, input.channel);
    if (done.messages.length < 2) throw new DomainError("conflict", "Still working on that message; send it again in a moment");
    return done;
  }
  // A shared social link is a reference, recorded once per task; the model
  // only ever sees the shopper's own words, never the post URL
  const intake = await intakeLinks(taskId, input.key, input.text ?? "", !!input.image, channelIds().includes(input.channel));
  const words = intake.words;
  const { requirements } = await getComparison(taskId, token);
  let result: Interpretation | null = null;
  const known = (await pool.query(`SELECT search_query FROM tasks WHERE id=$1`, [taskId])).rows[0]?.search_query as string | null;
  if (words || input.image) {
    try {
      result = await getInterpreter().interpret({
        text: words || undefined,
        image: input.image,
        item: known,
        currentRequirements: requirements.map((r) => ({ key: r.key, op: r.op, value: r.value, unit: r.unit })),
      });
    } catch (e) {
      console.error("api_error", "interpret_failed", e instanceof AdapterError ? e.kind : (e as Error)?.name);
    }
  }
  const proposals = (result?.proposedRequirements ?? []).slice(0, 10);
  const clarification = result?.clarification ? scrubModelText(result.clarification) || null : null;
  const said = result ? scrubModelText(result.reply ?? "") || FALLBACK : "";
  const reply = [said, intake.ack].filter(Boolean).join(" ").slice(0, 2000) || FALLBACK;
  await recordAssistantMessage(taskId, reply, { key: input.key, result: { proposals, clarification } });
  const item = result?.item;
  // A photo start has no words until the AI names the item
  if (item) await seedDemoOffers(taskId, item).catch(() => console.error("api_error", "seed_demo"));
  // The browser's next poll picks the offers up; a chat reply cannot be
  // edited later, so a channel waits for the search on the item the AI named.
  // A task started from a link searches again once the item is known, and so
  // does one where a later photo or label names the item more exactly.
  const search = item ? claimExternalSearch(taskId, item).then((first) => (first || intake.linkTask || sharper(known, item) ? searchFor(taskId, item, first) : undefined))
    .catch(() => console.error("channel_error", "seed_external")) : null;
  if (search && input.channel) await search;
  for (const id of intake.toSubmit) void submitPending(id).catch(() => console.error("source_error", "submit"));
  return getExchange(taskId, token, input.key, input.channel);
}

import { getInterpreter } from "@/adapters";
import { AdapterError, type Interpretation } from "@/adapters/types";
import { DomainError } from "@/domain/errors";
import { getExchange, recordAssistantMessage } from "@/domain/messages";
import { addMessage, getComparison } from "@/domain/tasks";
import { seedExternalOffers } from "@/catalog/demo";
import { claimExternalSearch } from "@/domain/offers";

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
  const { requirements } = await getComparison(taskId, token);
  let result: Interpretation | null = null;
  try {
    result = await getInterpreter().interpret({
      text: input.text || undefined,
      image: input.image,
      currentRequirements: requirements.map((r) => ({ key: r.key, op: r.op, value: r.value, unit: r.unit })),
    });
  } catch (e) {
    console.error("api_error", "interpret_failed", e instanceof AdapterError ? e.kind : (e as Error)?.name);
  }
  const proposals = (result?.proposedRequirements ?? []).slice(0, 10);
  const clarification = result?.clarification ? scrubModelText(result.clarification) || null : null;
  const reply = (scrubModelText(result?.reply ?? "") || FALLBACK).slice(0, 2000);
  await recordAssistantMessage(taskId, reply, { key: input.key, result: { proposals, clarification } });
  const item = result?.item;
  // the next poll picks the offers up; the reply never waits on the catalogue
  if (item) void claimExternalSearch(taskId).then((first) => (first ? seedExternalOffers(taskId, item) : undefined)).catch(() => console.error("channel_error", "seed_external"));
  return getExchange(taskId, token, input.key, input.channel);
}

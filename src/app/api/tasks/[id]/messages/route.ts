import { getInterpreter } from "@/adapters";
import { AdapterError, type Interpretation } from "@/adapters/types";
import { getExchange, listMessages, recordAssistantMessage } from "@/domain/messages";
import { addMessage, getComparison } from "@/domain/tasks";
import { bearer, handle, invalid, json, rateLimit, readJson, str, uuid } from "../../../_lib/http";

const MIMES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE = 4 * 1024 * 1024;
const FALLBACK = "I could not read that, please describe it.";

export const GET = handle<{ id: string }>(async (req, { id }) =>
  json({ messages: await listMessages(uuid(id), bearer(req)) }));

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  rateLimit(`msg:${taskId}`, 30);
  const b = await readJson(req, Math.ceil(MAX_IMAGE * 1.4) + 10_000);
  const clientMessageId = str(b, "clientMessageId", { max: 100, min: 1 })!;
  const text = str(b, "text", { max: 2000, optional: true });
  const imageBase64 = str(b, "imageBase64", { max: Math.ceil(MAX_IMAGE * 1.4), optional: true });
  const mime = str(b, "mime", { max: 20, optional: true });
  if (!text?.trim() && !imageBase64) throw invalid("Send some text or a photo");
  if (imageBase64) {
    if (!mime || !MIMES.includes(mime)) throw invalid("Photo must be JPEG, PNG or WebP");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) throw invalid("Photo is invalid");
    if (Math.floor((imageBase64.length * 3) / 4) > MAX_IMAGE) throw invalid("Photo is too large");
  }

  // Only the fact of an attachment is stored; the bytes live for this call
  const added = await addMessage(taskId, token, {
    channel: "browser", providerMessageId: `${taskId}:${clientMessageId}`, body: text ?? "", mediaRef: imageBase64 ? "inline:attached" : undefined,
  });
  if (added.duplicate) {
    return json(await getExchange(taskId, token, clientMessageId));
  }

  const { requirements } = await getComparison(taskId, token);
  let result: Interpretation | null = null;
  try {
    result = await getInterpreter().interpret({
      text: text || undefined,
      image: imageBase64 ? { mime: mime!, base64: imageBase64 } : undefined,
      currentRequirements: requirements.map((r) => ({ key: r.key, op: r.op, value: r.value, unit: r.unit })),
    });
  } catch (e) {
    console.error("api_error", "interpret_failed", e instanceof AdapterError ? e.kind : (e as Error)?.name);
  }
  const proposals = (result?.proposedRequirements ?? []).slice(0, 10);
  const clarification = result?.clarification ?? null;
  const reply = (result?.reply || FALLBACK).slice(0, 2000);
  await recordAssistantMessage(taskId, reply, { clientMessageId, result: { proposals, clarification } });
  return json(await getExchange(taskId, token, clientMessageId));
});

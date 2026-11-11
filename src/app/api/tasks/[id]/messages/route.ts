import { postExchange } from "@/chat/exchange";
import { resolveGrant } from "@/domain/access";
import { listMessages } from "@/domain/messages";
import { bearer, handle, invalid, json, rateLimit, readJson, str, uuid } from "../../../_lib/http";

const MIMES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE = 4 * 1024 * 1024;

export const GET = handle<{ id: string }>(async (req, { id }) =>
  json({ messages: await listMessages(uuid(id), bearer(req)) }));

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const taskId = uuid(id);
  const grant = await resolveGrant(taskId, token, "message");
  rateLimit(`msg:${grant.id}`, 30);
  const b = await readJson(req, Math.ceil(MAX_IMAGE * 1.4) + 10_000);
  const clientMessageId = str(b, "clientMessageId", { max: 100, min: 1 })!;
  const key = `${grant.id}:${clientMessageId}`;
  const text = str(b, "text", { max: 2000, optional: true });
  const imageBase64 = str(b, "imageBase64", { max: Math.ceil(MAX_IMAGE * 1.4), optional: true });
  const mime = str(b, "mime", { max: 20, optional: true });
  if (!text?.trim() && !imageBase64) throw invalid("Send some text or a photo");
  if (imageBase64) {
    if (!mime || !MIMES.includes(mime)) throw invalid("Photo must be JPEG, PNG or WebP");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) throw invalid("Photo is invalid");
    if (Math.floor((imageBase64.length * 3) / 4) > MAX_IMAGE) throw invalid("Photo is too large");
  }

  const image = imageBase64 ? { mime: mime!, base64: imageBase64 } : undefined;
  return json(await postExchange(taskId, token, { channel: "browser", key, text: text || undefined, image }));
});

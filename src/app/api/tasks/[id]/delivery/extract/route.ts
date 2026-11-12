import { getExtractor } from "@/adapters";
import { MAX_IMAGE_BYTES as MAX_IMAGE, validateImage } from "@/chat/image";
import { authorize } from "@/domain/access";
import { tx } from "@/domain/db";
import { bearer, clientIp, dailyCap, handle, json, rateLimit, readJson, str, uuid } from "../../../../_lib/http";

// Reads a quote or confirmation screenshot into fields for one-tap review.
// Nothing is saved here and the image is not stored.
export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`dlvx:${clientIp(req)}`, 10);
  dailyCap("ai", Number(process.env.AI_DAILY_MAX ?? "3000"));
  const taskId = uuid(id), token = bearer(req);
  await tx((c) => authorize(c, taskId, token, "message"));
  const b = await readJson(req, Math.ceil(MAX_IMAGE * 1.4) + 1_000);
  const base64 = str(b, "imageBase64", { max: Math.ceil(MAX_IMAGE * 1.4), min: 10 })!;
  const mime = str(b, "mime", { max: 20 });
  validateImage(mime, base64);
  return json(await getExtractor().extract({ mime: mime!, base64 }));
});

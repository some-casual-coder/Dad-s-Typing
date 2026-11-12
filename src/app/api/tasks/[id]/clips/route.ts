import { analyzeClip, CLIP_LIMITS } from "@/sources/clip";
import { bearer, clientIp, dailyCap, handle, json, rateLimit, readJson, str, uuid } from "../../../_lib/http";

// The shopper's own short clip: sampled frames, never stored
export const POST = handle<{ id: string }>(async (req, { id }) => {
  rateLimit(`clip:${clientIp(req)}`, 5);
  dailyCap("ai", Number(process.env.AI_DAILY_MAX ?? "3000"));
  const max = Math.ceil(CLIP_LIMITS.bytes * 1.37) + 1_000;
  const b = await readJson(req, max);
  return json(await analyzeClip(uuid(id), bearer(req), { base64: str(b, "videoBase64", { max, min: 16 })!, mime: str(b, "mime", { max: 30 })! }));
});

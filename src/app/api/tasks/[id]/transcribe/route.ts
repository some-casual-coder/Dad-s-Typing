import { getTranscriber } from "@/adapters";
import { AdapterError } from "@/adapters/types";
import { resolveGrant } from "@/domain/access";
import { baseMime, CONTAINERS, sniffFormat, VOICE_MAX_BYTES, VOICE_MULTIPART_OVERHEAD } from "@/lib/voice";
import { bearer, clientIp, dailyCap, handle, HttpError, invalid, json, rateLimit, uuid } from "../../../_lib/http";

// Returns text only: a transcript never triggers a send, payment or action
export const POST = handle<{ id: string }>(async (req, { id }) => {
  const token = bearer(req);
  const grant = await resolveGrant(uuid(id), token, "message");
  rateLimit(`stt:${grant.id}`, 10);
  rateLimit(`sttip:${clientIp(req)}`, 40);
  dailyCap("stt", Number(process.env.STT_DAILY_MAX ?? "500"));
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(len)) throw new HttpError(411, "length_required", "Recording size is required");
  if (len > VOICE_MAX_BYTES + VOICE_MULTIPART_OVERHEAD) throw new HttpError(413, "too_large", "Recording is too long");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    throw invalid("Recording must be multipart");
  }
  const form = await req.formData().catch(() => { throw invalid("Recording is invalid"); });
  const file = form.get("audio");
  if (!(file instanceof File)) throw invalid("Recording is missing");
  if (file.size === 0) throw invalid("Recording is empty");
  if (file.size > VOICE_MAX_BYTES) throw new HttpError(413, "too_large", "Recording is too long");
  const declared = CONTAINERS[baseMime(file.type)];
  if (!declared) throw new HttpError(415, "unsupported_type", "Recording format is not supported");
  const audio = new Uint8Array(await file.arrayBuffer());
  if (sniffFormat(audio) !== declared) throw new HttpError(415, "unsupported_type", "Recording format is not supported");
  try {
    return json(await getTranscriber().transcribe({ audio, format: declared }));
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    console.error("api_error", "stt", e.kind);
    throw e.kind === "timeout"
      ? new HttpError(504, "voice_timeout", "Transcribing took too long. Please retry or type instead.")
      : new HttpError(502, "voice_unavailable", "Voice isn't working right now. Please type instead.");
  }
});

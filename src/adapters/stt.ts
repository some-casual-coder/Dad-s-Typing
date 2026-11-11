import { failFor, jsonOf, MODEL_TIMEOUT_MS, send } from "./http";
import { AdapterError, type Transcriber } from "./types";

export const DEFAULT_STT_MODEL = "openai/whisper-large-v3-turbo";

export class OpenRouterTranscriber implements Transcriber {
  constructor(private apiKey: string, private model: string) {
    if (!apiKey || !model) throw new AdapterError("unavailable", "Speech-to-text is not configured");
  }

  async transcribe(input: Parameters<Transcriber["transcribe"]>[0]) {
    const r = await send("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input_audio: { data: Buffer.from(input.audio).toString("base64"), format: input.format },
      }),
    }, MODEL_TIMEOUT_MS);
    if (!r.ok) throw failFor(r.status, "Speech-to-text");
    const j = (await jsonOf(r, "Speech-to-text")) as { text?: unknown; language?: unknown };
    if (typeof j.text !== "string") throw new AdapterError("unavailable", "invalid transcription output");
    return {
      text: j.text.trim(),
      ...(typeof j.language === "string" ? { language: j.language } : {}),
    };
  }
}

export function transcriberFromEnv(env = process.env): Transcriber {
  return new OpenRouterTranscriber(env.OPENROUTER_API_KEY ?? "", env.STT_MODEL || DEFAULT_STT_MODEL);
}

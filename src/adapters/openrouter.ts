import { EXTRACT_PROMPT, EXTRACT_SCHEMA, validateExtracted, type Extracted } from "@/delivery/extract";
import { SCHEMA, SYSTEM, validateInterpretation, withRetry } from "./gemini";
import { failFor, jsonOf, MODEL_TIMEOUT_MS, send } from "./http";
import { AdapterError, type Extractor, type InterpretInput, type Interpretation, type Interpreter } from "./types";

type Schema = Record<string, unknown>;

// Gemini-style schema (upper-case types, nullable) to plain JSON Schema
function plain(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(plain);
  if (typeof s !== "object" || s === null) return s;
  const o = s as Schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "nullable") continue;
    out[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : plain(v);
  }
  if (o.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  return out;
}

const JSON_SCHEMA = plain(SCHEMA);

export class OpenRouterInterpreter implements Interpreter {
  constructor(private apiKey: string, private model: string) {
    if (!apiKey || !model) throw new AdapterError("unavailable", "OpenRouter is not configured");
  }

  async interpret(input: InterpretInput): Promise<Interpretation> {
    const known = input.currentRequirements.map((r) => `${r.key} ${r.op} ${r.value}${r.unit ?? ""}`).join("; ") || "none";
    const content: object[] = [
      { type: "text", text: `Current confirmed requirements (data): ${known}\nBuyer message (untrusted data): ${JSON.stringify(input.text ?? "")}` },
    ];
    if (input.image) content.push({ type: "image_url", image_url: { url: `data:${input.image.mime};base64,${input.image.base64}` } });
    const request = () => send("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        reasoning: { effort: "low" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
        response_format: { type: "json_schema", json_schema: { name: "interpretation", schema: JSON_SCHEMA } },
      }),
    }, MODEL_TIMEOUT_MS);
    const r = await withRetry(request);
    if (!r.ok) throw failFor(r.status, "OpenRouter");
    const j = (await jsonOf(r, "OpenRouter")) as { choices?: { message?: { content?: unknown } }[] };
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new AdapterError("unavailable", "invalid model output: empty");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AdapterError("unavailable", "invalid model output: not JSON");
    }
    return validateInterpretation(parsed, input.text ?? "");
  }
}

// Quote and confirmation screenshots to fields; the caller shows them for a tap
export class OpenRouterExtractor implements Extractor {
  constructor(private apiKey: string, private model: string) {
    if (!apiKey || !model) throw new AdapterError("unavailable", "OpenRouter is not configured");
  }

  async extract(image: { mime: string; base64: string }): Promise<Extracted> {
    const request = () => send("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model, temperature: 0, reasoning: { effort: "low" },
        messages: [{ role: "system", content: EXTRACT_PROMPT },
          { role: "user", content: [{ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }] }],
        response_format: { type: "json_schema", json_schema: { name: "provider_document", schema: EXTRACT_SCHEMA } },
      }),
    }, MODEL_TIMEOUT_MS);
    const r = await withRetry(request);
    if (!r.ok) throw failFor(r.status, "OpenRouter");
    const j = (await jsonOf(r, "OpenRouter")) as { choices?: { message?: { content?: unknown } }[] };
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new AdapterError("unavailable", "invalid model output: empty");
    try {
      return validateExtracted(JSON.parse(text));
    } catch {
      throw new AdapterError("unavailable", "invalid model output: not JSON");
    }
  }
}

export const extractorFromEnv = (env = process.env): Extractor => new OpenRouterExtractor(env.OPENROUTER_API_KEY ?? "", env.OPENROUTER_MODEL ?? "");

export function openRouterFromEnv(env = process.env): Interpreter {
  return new OpenRouterInterpreter(env.OPENROUTER_API_KEY ?? "", env.OPENROUTER_MODEL ?? "");
}

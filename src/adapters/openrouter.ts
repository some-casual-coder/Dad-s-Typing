import { SCHEMA, SYSTEM, validateInterpretation, withRetry } from "./gemini";
import { failFor, jsonOf, send } from "./http";
import { AdapterError, type InterpretInput, type Interpretation, type Interpreter } from "./types";

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
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
        response_format: { type: "json_schema", json_schema: { name: "interpretation", schema: JSON_SCHEMA } },
      }),
    });
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

export function openRouterFromEnv(env = process.env): Interpreter {
  return new OpenRouterInterpreter(env.OPENROUTER_API_KEY ?? "", env.OPENROUTER_MODEL ?? "");
}

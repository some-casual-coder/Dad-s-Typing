import { CANDIDATE_SCHEMA, EXTRACT_PROMPT, validateExtract, type ExtractOut } from "@/sources/candidates";
import { jsonOf, send } from "./http";
import { AdapterError } from "./types";

// Supadata Extract (docs.supadata.ai/get-extract): async URL analysis of
// sampled frames and audio. Submit returns 202 {jobId}; poll for status.
export const SUPADATA_VERSION = "extract-v1";
const BASE = "https://api.supadata.ai/v1/extract";

export type Submit =
  | { kind: "accepted"; jobId: string }
  | { kind: "rejected"; reason: "invalid_request" | "restricted" | "not_found_or_private" | "unauthorized" }
  | { kind: "retryable"; reason: "rate_limited" | "provider_unavailable"; retryAfterS: number | null }
  // The request may have reached Supadata; never resubmit blindly (billable)
  | { kind: "unknown"; reason: "timeout" | "network" | "unreadable_response" };

export type Poll =
  | { kind: "pending"; status: "queued" | "active" }
  | { kind: "completed"; out: ExtractOut }
  | { kind: "failed"; reason: string }
  | { kind: "expired" }
  | { kind: "retryable"; reason: string };

export interface VideoExtractor {
  submit(url: string): Promise<Submit>;
  poll(jobId: string): Promise<Poll>;
}

export class SupadataExtract implements VideoExtractor {
  constructor(private key: string) {
    if (!key) throw new AdapterError("unavailable", "Supadata is not configured");
  }

  async submit(url: string): Promise<Submit> {
    let r: Response;
    try {
      r = await send(BASE, { method: "POST", headers: { "x-api-key": this.key, "content-type": "application/json" },
        body: JSON.stringify({ url, prompt: EXTRACT_PROMPT, schema: CANDIDATE_SCHEMA }) }, 15_000);
    } catch (e) {
      return { kind: "unknown", reason: e instanceof AdapterError && e.kind === "timeout" ? "timeout" : "network" };
    }
    if (r.status === 202 || r.status === 200) {
      const j = (await r.json().catch(() => null)) as { jobId?: unknown } | null;
      const id = typeof j?.jobId === "string" && /^[A-Za-z0-9-]{8,100}$/.test(j.jobId) ? j.jobId : null;
      return id ? { kind: "accepted", jobId: id } : { kind: "unknown", reason: "unreadable_response" };
    }
    if (r.status === 400) return { kind: "rejected", reason: "invalid_request" };
    if (r.status === 401) return { kind: "rejected", reason: "unauthorized" };
    if (r.status === 403) return { kind: "rejected", reason: "restricted" };
    if (r.status === 404) return { kind: "rejected", reason: "not_found_or_private" };
    if (r.status === 429) return { kind: "retryable", reason: "rate_limited", retryAfterS: Number(r.headers.get("retry-after")) || null };
    return { kind: "retryable", reason: "provider_unavailable", retryAfterS: null };
  }

  async poll(jobId: string): Promise<Poll> {
    let r: Response;
    try {
      r = await send(`${BASE}/${encodeURIComponent(jobId)}`, { headers: { "x-api-key": this.key } }, 10_000);
    } catch {
      return { kind: "retryable", reason: "network" };
    }
    if (r.status === 404) return { kind: "expired" };
    if (r.status === 429 || r.status >= 500) return { kind: "retryable", reason: `http_${r.status}` };
    if (!r.ok) return { kind: "failed", reason: `http_${r.status}` };
    const j = (await jsonOf(r, "Supadata").catch(() => null)) as { status?: unknown; data?: unknown; error?: unknown } | null;
    if (j?.status === "queued" || j?.status === "active") return { kind: "pending", status: j.status };
    if (j?.status === "completed") return { kind: "completed", out: validateExtract(j.data) };
    if (j?.status === "failed") return { kind: "failed", reason: "provider_failed" };
    return { kind: "failed", reason: "schema_changed" };
  }
}

export const supadataFromEnv = (env = process.env): VideoExtractor => new SupadataExtract(env.SUPADATA_API_KEY ?? "");

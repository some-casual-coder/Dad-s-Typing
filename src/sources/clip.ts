import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { framesFromEnv } from "@/adapters/openrouter";
import { authorize } from "@/domain/access";
import { tx } from "@/domain/db";
import { DomainError } from "@/domain/errors";
import { logEvent } from "@/domain/events";
import type { ExtractOut } from "./candidates";
import { bumpEvidence } from "./intake";

// The shopper's own short clip (not a social link): checked by its bytes,
// bounded in size and length, a few frames sampled in a private temp folder,
// everything deleted, and only the observations kept.
export const CLIP_LIMITS = { bytes: 8 * 1024 * 1024, seconds: 60, frames: 6 };
const run = promisify(execFile);

export function sniffVideo(b: Buffer): "video/mp4" | "video/quicktime" | "video/webm" | null {
  if (b.length > 12 && b.toString("latin1", 4, 8) === "ftyp") return b.toString("latin1", 8, 10) === "qt" ? "video/quicktime" : "video/mp4";
  if (b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3) return "video/webm";
  return null;
}

export type Analyze = (frames: { atS: number; base64: string }[]) => Promise<ExtractOut>;

export async function sampleFrames(file: string, dir: string): Promise<{ atS: number; base64: string }[]> {
  let probe: string;
  try {
    probe = (await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], { timeout: 5_000 })).stdout;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new DomainError("conflict", "Clip checks aren't available here; add a screenshot instead");
    throw new DomainError("invalid", "That video could not be read; add a screenshot instead");
  }
  const p = JSON.parse(probe) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const dur = Number(p.format?.duration);
  if (!p.streams?.some((s) => s.codec_type === "video") || !(dur > 0)) throw new DomainError("invalid", "That file has no video to look at");
  if (dur > CLIP_LIMITS.seconds) throw new DomainError("invalid", `Please send a clip under ${CLIP_LIMITS.seconds} seconds, or a screenshot of the item`);
  const n = Math.min(CLIP_LIMITS.frames, Math.max(1, Math.ceil(dur / 3)));
  const out: { atS: number; base64: string }[] = [];
  for (let i = 0; i < n; i++) {
    const at = Math.round(((i + 0.5) * dur / n) * 10) / 10;
    const jpg = join(dir, `f${i}.jpg`);
    await run("ffmpeg", ["-v", "error", "-nostdin", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=512:-2", "-y", jpg], { timeout: 10_000 });
    out.push({ atS: at, base64: (await readFile(jpg)).toString("base64") });
  }
  return out;
}

export async function analyzeClip(taskId: string, token: string, input: { base64: string; mime: string }, analyze?: Analyze) {
  await tx((c) => authorize(c, taskId, token, "message"));
  if (process.env.CLIP_ANALYSIS === "0") throw new DomainError("conflict", "Clip checks are switched off; add a screenshot instead");
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length || bytes.length > CLIP_LIMITS.bytes) throw new DomainError("invalid", "Please send a clip under 8 MB, or a screenshot of the item");
  const kind = sniffVideo(bytes);
  if (!kind || (input.mime !== kind && !(kind === "video/mp4" && input.mime === "video/quicktime"))) throw new DomainError("invalid", "That isn't a video we can read (MP4, MOV or WebM)");
  const dir = await mkdtemp(join(tmpdir(), "dt-clip-"));
  let out: ExtractOut;
  try {
    const file = join(dir, `clip${kind === "video/webm" ? ".webm" : ".mp4"}`);
    await writeFile(file, bytes, { mode: 0o600 });
    const frames = await sampleFrames(file, dir);
    out = await (analyze ?? ((f) => framesFromEnv().analyze(f)))(frames);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return tx(async (c) => {
    const v = await bumpEvidence(c, taskId);
    for (const p of out.products) {
      const ev = randomUUID();
      await c.query(`INSERT INTO evidence_items (id,task_id,type,auth_mode,content,timestamp_s) VALUES ($1,$2,'authorized_frame','shopper_provided',$3,$4)`,
        [ev, taskId, p.observation, p.timestampS]);
      await c.query(
        `INSERT INTO product_candidates (id,task_id,label,brand,model,attributes,uncertain,evidence_ids,provenance,input_version,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'shopper_upload_frames',$9,clock_timestamp())`,
        [randomUUID(), taskId, p.label, p.brand, p.model, JSON.stringify(p.attributes), JSON.stringify(p.uncertain), [ev], v]);
    }
    await logEvent(c, taskId, null, "clip.analysed", { products: out.products.length });
    return { products: out.products.length, noProductReason: out.noProductReason };
  });
}

import { randomUUID } from "node:crypto";
import { getVideoExtractor } from "@/adapters";
import { SUPADATA_VERSION, type VideoExtractor } from "@/adapters/supadata";
import { seedExternalOffers } from "@/catalog/demo";
import { authorize } from "@/domain/access";
import { pool, tx, type Tx } from "@/domain/db";
import { DomainError } from "@/domain/errors";
import { logEvent } from "@/domain/events";
import { searchPhrase, type ExtractOut } from "./candidates";
import { LABEL, type SourceRef } from "./recognize";
import { resolveShortLink } from "./resolve";

export type Status = "checking" | "preview_only" | "resolved" | "needs_input" | "retryable_error" | "unavailable" | "unsupported";

const POLL_EVERY_MS = 3_000;
const DEADLINE_MS = 10 * 60_000;
const MAX_SUBMIT_TRIES = 2;
const CREDITS_PER_JOB = 5;

// Supadata runs only when switched on, keyed, allowed for this platform and
// this exact post (or any public post with SUPADATA_ALLOW_ANY_POST=1, an
// accepted rights risk), and under the credit ceiling. Default: off.
export async function supadataGate(ref: { platform: string; identity: string }, env: Record<string, string | undefined> = process.env): Promise<{ on: boolean; why: string }> {
  if (env.SUPADATA_ENABLED !== "1") return { on: false, why: "disabled" };
  if (!env.SUPADATA_API_KEY) return { on: false, why: "no_credential" };
  const platforms = (env.SUPADATA_PLATFORMS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!platforms.includes(ref.platform)) return { on: false, why: "platform_not_approved" };
  const allow = (env.SUPADATA_URL_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.SUPADATA_ALLOW_ANY_POST !== "1" && !allow.includes(ref.identity)) return { on: false, why: "link_not_approved" };
  const ceiling = Number(env.SUPADATA_CREDIT_CEILING ?? "0");
  const used = Number((await pool.query(`SELECT COALESCE(sum(credits_estimate),0)::int n FROM source_attempts WHERE adapter='supadata_extract'`)).rows[0].n);
  if (!(ceiling > 0) || used + CREDITS_PER_JOB > ceiling) return { on: false, why: "budget" };
  return { on: true, why: "approved" };
}

// Only build the provider client when it is switched on and keyed
export const analysisConfigured = (env = process.env) => env.SUPADATA_ENABLED === "1" && !!env.SUPADATA_API_KEY;

export async function bumpEvidence(c: Tx, taskId: string): Promise<number> {
  return (await c.query(`UPDATE tasks SET evidence_version = evidence_version + 1 WHERE id=$1 RETURNING evidence_version`, [taskId])).rows[0].evidence_version;
}

const initialStatus = (ref: SourceRef): { status: Status; reason: string } => {
  if (ref.kind === "profile" || ref.kind === "other") return { status: "unsupported", reason: "not_a_post" };
  if (ref.kind === "story") return { status: "unsupported", reason: "story" };
  if (ref.platform === "youtube" || ref.platform === "x" || ref.platform === "snapchat") return { status: "preview_only", reason: "secondary_source" };
  return { status: "preview_only", reason: "analysis_off" };
};

// Inside the message's transaction: one row per post per task, whatever the
// number of messages that carried it. Returns sources new to this task.
export async function recordSources(c: Tx, taskId: string, messageKey: string, refs: SourceRef[], words: string, gates: Map<string, boolean>) {
  const version = await bumpEvidence(c, taskId);
  const fresh: { id: string; ref: SourceRef; analyse: boolean }[] = [];
  for (const ref of refs) {
    const first = initialStatus(ref);
    const analyse = first.reason === "analysis_off" && ref.analysable && !!gates.get(ref.identity);
    const id = randomUUID();
    const r = await c.query(
      `INSERT INTO shared_sources (id,task_id,message_key,platform,kind,canonical_id,display_url,identity,status,reason,input_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (task_id, identity) DO NOTHING RETURNING id`,
      [id, taskId, messageKey.slice(0, 200), ref.platform, ref.kind, ref.canonicalId, ref.displayUrl, ref.identity,
        analyse ? "checking" : first.status, analyse ? null : first.reason, version]);
    if (!r.rowCount) continue;
    if (words) await c.query(`INSERT INTO evidence_items (id,task_id,source_id,type,auth_mode,content) VALUES ($1,$2,$3,'user_text','shopper_provided',$4)`,
      [randomUUID(), taskId, id, words.slice(0, 500)]);
    if (analyse) await c.query(
      `INSERT INTO source_attempts (id,source_id,adapter,adapter_version,input_version,state,deadline) VALUES ($1,$2,'supadata_extract',$3,$4,'submitting', now() + make_interval(secs => $5))`,
      [randomUUID(), id, SUPADATA_VERSION, version, DEADLINE_MS / 1000]);
    await logEvent(c, taskId, null, "source.received", { platform: ref.platform, analyse });
    fresh.push({ id, ref, analyse });
  }
  return fresh;
}

const setSource = (c: Tx | typeof pool, id: string, status: Status, reason: string | null) =>
  c.query(`UPDATE shared_sources SET status=$2, reason=$3, updated_at=now() WHERE id=$1`, [id, status, reason]);

// After commit: submit once. A lost response is never resubmitted (billable).
export async function submitPending(sourceId: string, ex: VideoExtractor = getVideoExtractor()) {
  const a = (await pool.query(
    `UPDATE source_attempts SET tries = tries + 1, updated_at=now() WHERE source_id=$1 AND state IN ('submitting','retryable') AND tries < $2
       AND (next_poll_at IS NULL OR next_poll_at <= now()) RETURNING id, tries`, [sourceId, MAX_SUBMIT_TRIES])).rows[0];
  if (!a) return;
  const s = (await pool.query(`SELECT * FROM shared_sources WHERE id=$1`, [sourceId])).rows[0];
  let url = s.display_url as string;
  if (s.kind === "short_link") {
    const r = await resolveShortLink({ platform: s.platform, kind: "short_link", canonicalId: null, displayUrl: url, identity: s.identity, analysable: true });
    if (r.ok) {
      url = r.ref.displayUrl;
      await pool.query(`UPDATE shared_sources SET canonical_id=$2, display_url=$3, updated_at=now() WHERE id=$1`, [sourceId, r.ref.canonicalId, url]);
    }
  }
  const sub = await ex.submit(url);
  if (sub.kind === "accepted") {
    await pool.query(`UPDATE source_attempts SET state='queued', provider_job_id=$2, credits_estimate=$3, next_poll_at=now(), updated_at=now() WHERE id=$1`,
      [a.id, sub.jobId, CREDITS_PER_JOB]);
    return;
  }
  if (sub.kind === "unknown") {
    // It may have been accepted and billed; stop and let the shopper continue
    await pool.query(`UPDATE source_attempts SET state='unknown_submit', reason=$2, updated_at=now() WHERE id=$1`, [a.id, sub.reason]);
    await setSource(pool, sourceId, "needs_input", "check_unconfirmed");
    return;
  }
  if (sub.kind === "retryable") {
    const last = a.tries >= MAX_SUBMIT_TRIES;
    await pool.query(`UPDATE source_attempts SET state='retryable', reason=$2, next_poll_at=now() + make_interval(secs => $3), updated_at=now() WHERE id=$1`,
      [a.id, sub.reason, sub.retryAfterS ?? 30]);
    await setSource(pool, sourceId, last ? "retryable_error" : "checking", last ? sub.reason : null);
    return;
  }
  await pool.query(`UPDATE source_attempts SET state='failed', reason=$2, updated_at=now() WHERE id=$1`, [a.id, sub.reason]);
  await setSource(pool, sourceId, sub.reason === "restricted" || sub.reason === "not_found_or_private" ? "unavailable" : "needs_input", sub.reason);
}

// Poll due jobs; bounded by deadline. Safe to call from a request or a timer.
export async function pollDue(ex: VideoExtractor = getVideoExtractor(), taskId?: string) {
  // Every attempt that ends here, however it ends, gets one chat follow-up
  const ended: string[] = (await pool.query(
    `UPDATE source_attempts a SET state='timed_out', reason='deadline', updated_at=now() WHERE state IN ('queued','active') AND deadline < now()
       AND ($1::uuid IS NULL OR source_id IN (SELECT id FROM shared_sources WHERE task_id=$1)) RETURNING id`, [taskId ?? null])).rows.map((r) => r.id);
  await pool.query(`UPDATE shared_sources s SET status='needs_input', reason='timed_out', updated_at=now() WHERE status='checking'
      AND EXISTS (SELECT 1 FROM source_attempts a WHERE a.source_id=s.id AND a.state='timed_out')`);
  const due = (await pool.query(
    `SELECT a.id, a.provider_job_id, a.source_id FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id
      WHERE a.state IN ('queued','active') AND a.next_poll_at <= now() AND ($1::uuid IS NULL OR s.task_id=$1) ORDER BY a.next_poll_at LIMIT 10`,
    [taskId ?? null])).rows;
  for (const a of due) {
    const p = await ex.poll(a.provider_job_id);
    if (p.kind === "pending" || p.kind === "retryable") {
      await pool.query(`UPDATE source_attempts SET state=$2, next_poll_at=now() + make_interval(secs => $3), updated_at=now() WHERE id=$1`,
        [a.id, p.kind === "pending" ? p.status : "queued", POLL_EVERY_MS / 1000]);
    } else if (p.kind === "completed") { await applyResult(a.id, p.out); ended.push(a.id); }
    else {
      await pool.query(`UPDATE source_attempts SET state='failed', reason=$2, updated_at=now() WHERE id=$1`, [a.id, p.kind === "expired" ? "result_expired" : p.reason]);
      await setSource(pool, a.source_id, "needs_input", p.kind === "expired" ? "result_expired" : "provider_failed");
      ended.push(a.id);
    }
  }
  if (!ended.length) return;
  // Loaded late: the chat engine itself imports this module
  const { videoFollowUp } = await import("@/channel/inbox");
  for (const id of ended) await videoFollowUp(id).catch((e) => console.error("source_error", "follow_up", (e as Error)?.name));
}

// Provider output becomes labelled observations and candidates. A late result
// (the shopper added evidence or chose meanwhile) never replaces their choice.
export async function applyResult(attemptId: string, out: ExtractOut) {
  await tx(async (c) => {
    const a = (await c.query(`SELECT a.*, s.task_id FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE a.id=$1 FOR UPDATE OF a`, [attemptId])).rows[0];
    if (!a || a.state === "completed") return;
    const t = (await c.query(`SELECT evidence_version FROM tasks WHERE id=$1 FOR UPDATE`, [a.task_id])).rows[0];
    const chosen = (await c.query(`SELECT 1 FROM product_candidates WHERE task_id=$1 AND status='chosen'`, [a.task_id])).rowCount;
    const late = t.evidence_version !== a.input_version || !!chosen;
    for (const p of out.products) {
      const ev = randomUUID();
      await c.query(`INSERT INTO evidence_items (id,task_id,source_id,type,auth_mode,content,timestamp_s) VALUES ($1,$2,$3,$4,'provider_generated',$5,$6)`,
        [ev, a.task_id, a.source_id, p.evidence === "spoken" ? "provider_spoken" : "provider_visual", p.observation, p.timestampS]);
      await c.query(
        `INSERT INTO product_candidates (id,task_id,source_id,label,brand,model,attributes,uncertain,evidence_ids,provenance,status,input_version,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'provider_generated_observation',$10,$11,clock_timestamp())`,
        [randomUUID(), a.task_id, a.source_id, p.label, p.brand, p.model, JSON.stringify(p.attributes), JSON.stringify(p.uncertain), [ev],
          late ? "late" : "proposed", a.input_version]);
    }
    await c.query(`UPDATE source_attempts SET state='completed', updated_at=now() WHERE id=$1`, [attemptId]);
    if (!late) await setSource(c, a.source_id, out.products.length ? "resolved" : "needs_input", out.products.length ? null : "no_product");
    await logEvent(c, a.task_id, null, "source.analysed", { products: out.products.length, late });
  });
}

// "Find this item": the shopper's pick drives the existing search
export async function chooseCandidate(taskId: string, token: string, candidateId: string) {
  const phrase = await tx(async (c) => {
    const g = await authorize(c, taskId, token, "message");
    const k = (await c.query(`SELECT * FROM product_candidates WHERE id=$1 AND task_id=$2 FOR UPDATE`, [candidateId, taskId])).rows[0];
    if (!k) throw new DomainError("not_found", "Candidate not found");
    await c.query(`UPDATE product_candidates SET status='rejected' WHERE task_id=$1 AND status='chosen'`, [taskId]);
    await c.query(`UPDATE product_candidates SET status='chosen' WHERE id=$1`, [candidateId]);
    await bumpEvidence(c, taskId);
    const q = searchPhrase(k);
    await c.query(`UPDATE tasks SET search_query=$2 WHERE id=$1`, [taskId, q]);
    await logEvent(c, taskId, g.id, "source.candidate_chosen", {});
    return q;
  });
  await seedExternalOffers(taskId, phrase).catch(() => console.error("api_error", "seed_external"));
  return { ok: true, search: phrase };
}

// "Something else": none of these; the shopper describes or adds a screenshot
export async function rejectCandidates(taskId: string, token: string, sourceId: string) {
  return tx(async (c) => {
    await authorize(c, taskId, token, "message");
    await c.query(`UPDATE product_candidates SET status='rejected' WHERE task_id=$1 AND source_id=$2 AND status IN ('proposed','late')`, [taskId, sourceId]);
    await setSource(c, sourceId, "needs_input", "not_the_item");
    await bumpEvidence(c, taskId);
    return { ok: true };
  });
}

// "Try again" only after a failure that was not billed and not a restriction
export async function retrySource(taskId: string, token: string, sourceId: string) {
  const ok = await tx(async (c) => {
    await authorize(c, taskId, token, "message");
    const s = (await c.query(`SELECT * FROM shared_sources WHERE id=$1 AND task_id=$2 FOR UPDATE`, [sourceId, taskId])).rows[0];
    if (!s) throw new DomainError("not_found", "Source not found");
    if (s.status !== "retryable_error") throw new DomainError("conflict", "This link can't be retried; add a screenshot or describe the item");
    const v = await bumpEvidence(c, taskId);
    await c.query(`INSERT INTO source_attempts (id,source_id,adapter,adapter_version,input_version,state,deadline) VALUES ($1,$2,'supadata_extract',$3,$4,'submitting', now() + make_interval(secs => $5))`,
      [randomUUID(), sourceId, SUPADATA_VERSION, v, DEADLINE_MS / 1000]);
    await setSource(c, sourceId, "checking", null);
    return true;
  });
  if (ok) await submitPending(sourceId);
  return { ok: true };
}

// Candidates from the shopper's own uploaded clip, not tied to a link
export async function uploadCandidates(c: Tx, taskId: string) {
  const cs = (await c.query(`SELECT k.id, k.label, k.brand, k.model, k.attributes, k.uncertain, k.status, k.provenance, k.evidence_ids FROM product_candidates k
      WHERE k.task_id=$1 AND k.source_id IS NULL AND k.status <> 'rejected' ORDER BY k.created_at`, [taskId])).rows;
  const ev = (await c.query(`SELECT id, type, content, timestamp_s FROM evidence_items WHERE task_id=$1 AND source_id IS NULL`, [taskId])).rows;
  const byId = new Map(ev.map((e) => [e.id, e]));
  return cs.map((k) => ({ id: k.id as string, label: k.label as string, brand: k.brand as string | null, model: k.model as string | null,
    attributes: k.attributes as string[], uncertain: k.uncertain as string[], status: k.status as string, provenance: k.provenance as string,
    basis: (k.evidence_ids as string[]).map((id) => byId.get(id)).filter(Boolean).map((e) => ({ type: e.type as string, observation: e.content as string,
      at: e.timestamp_s === null ? null : Number(e.timestamp_s) })) }));
}

export async function sourcesView(c: Tx, taskId: string) {
  const ss = (await c.query(`SELECT id, platform, kind, display_url, status, reason, created_at FROM shared_sources WHERE task_id=$1 ORDER BY created_at`, [taskId])).rows;
  const cs = (await c.query(`SELECT id, source_id, label, brand, model, attributes, uncertain, evidence_ids, provenance, status FROM product_candidates
      WHERE task_id=$1 AND status <> 'rejected' ORDER BY created_at`, [taskId])).rows;
  const ev = (await c.query(`SELECT id, source_id, type, auth_mode, content, timestamp_s FROM evidence_items WHERE task_id=$1 ORDER BY created_at`, [taskId])).rows;
  const byId = new Map(ev.map((e) => [e.id, e]));
  return ss.map((s) => ({
    id: s.id as string, platform: s.platform as string, label: LABEL[s.platform as keyof typeof LABEL], kind: s.kind as string,
    openUrl: s.display_url as string, status: s.status as Status, reason: s.reason as string | null,
    // The shopper's later screenshot or words belong to the task, so to every link on it
    evidence: [...new Set(ev.filter((e) => e.source_id === s.id || (e.source_id === null && (e.type === "user_image" || e.type === "user_text")))
      .map((e) => e.type as string))],
    candidates: cs.filter((k) => k.source_id === s.id).map((k) => ({
      id: k.id as string, label: k.label as string, brand: k.brand as string | null, model: k.model as string | null,
      attributes: k.attributes as string[], uncertain: k.uncertain as string[], status: k.status as string, provenance: k.provenance as string,
      basis: (k.evidence_ids as string[]).map((id) => byId.get(id)).filter(Boolean).map((e) => ({
        type: e.type as string, observation: e.content as string, at: e.timestamp_s === null ? null : Number(e.timestamp_s) })),
    })),
  }));
}

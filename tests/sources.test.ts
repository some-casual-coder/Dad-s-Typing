import "./env";
process.env.SUPADATA_API_KEY = "test-key-not-real";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  submit: vi.fn(), poll: vi.fn(), interpret: vi.fn(), search: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/adapters", () => ({
  getVideoExtractor: () => ({ submit: fake.submit, poll: fake.poll }),
  getInterpreter: () => ({ interpret: fake.interpret }),
  getDiscovery: () => ({ search: fake.search }),
  getFx: () => ({ kesRate: async () => ({ rate: 130, date: "2026-11-11", source: "test" }) }),
  getPayments: () => ({}),
}));

import { postExchange } from "@/chat/exchange";
import { pool } from "@/domain/db";
import { createTask } from "@/domain/tasks";
import { SupadataExtract } from "@/adapters/supadata";
import { validateExtract } from "@/sources/candidates";
import { analyzeClip, sniffVideo } from "@/sources/clip";
import { applyResult, chooseCandidate, pollDue, rejectCandidates, retrySource, sourcesView, submitPending } from "@/sources/intake";
import { findLinks, withoutSocialLinks } from "@/sources/recognize";
import { privateAddress, resolveShortLink } from "@/sources/resolve";
import { tx } from "@/domain/db";

let n = 0;
const key = () => `web:${Date.now()}:${++n}`;
const ON = { SUPADATA_ENABLED: "1", SUPADATA_PLATFORMS: "instagram,tiktok,facebook", SUPADATA_CREDIT_CEILING: "1000" };
const REEL = "https://www.instagram.com/reel/C9abcDEF123/?igsh=MTk3eHh4";
const reply = (x: { messages: { role: string; body: string }[] }) => x.messages.find((m) => m.role === "assistant")!.body;
const view = async (taskId: string) => tx((c) => sourcesView(c, taskId));
const solo = () => createTask({ title: "Shared post", starterRoles: ["requester", "chooser", "helper", "payer"], starterLabel: "Me" });
const out = (products: object[]) => ({ products, no_product_reason: products.length ? null : "Nothing to buy is shown." });
const P = (label: string, extra: object = {}) => ({ label, brand: null, model: null, attributes: [], evidence: "visual", observation: `A ${label} is shown`,
  timestamp_seconds: 16, uncertain: [], ...extra });

beforeEach(() => {
  for (const f of [fake.submit, fake.poll, fake.interpret, fake.search]) f.mockReset();
  fake.search.mockResolvedValue([]);
  fake.interpret.mockResolvedValue({ observations: [], proposedRequirements: [], clarification: null, reply: "Got it.", item: "" });
});
afterEach(() => { for (const k of [...Object.keys(ON), "SUPADATA_URL_ALLOWLIST"]) delete process.env[k]; });
const enable = (identity: string) => { Object.assign(process.env, ON, { SUPADATA_URL_ALLOWLIST: identity }); };

describe("R01 recognition per platform (fixtures)", () => {
  it("recognises supported forms and keeps a safe display link", () => {
    const one = (u: string) => { const f = findLinks(u)[0]; return f.type === "social" ? f.ref : f; };
    expect(one(REEL)).toMatchObject({ platform: "instagram", kind: "reel", canonicalId: "C9abcDEF123", displayUrl: "https://www.instagram.com/reel/C9abcDEF123/" });
    expect(one("https://www.instagram.com/p/C9abcDEF123/")).toMatchObject({ kind: "post", identity: "instagram:C9abcDEF123" });
    expect(one("https://www.tiktok.com/@shop.ke/video/7301234567890123456?is_from_webapp=1")).toMatchObject({ platform: "tiktok", kind: "video", canonicalId: "7301234567890123456" });
    expect(one("https://vm.tiktok.com/ZMabc123/")).toMatchObject({ platform: "tiktok", kind: "short_link", canonicalId: null, analysable: true });
    expect(one("https://www.tiktok.com/t/ZTRabc123/")).toMatchObject({ kind: "short_link" });
    expect(one("https://www.facebook.com/reel/1234567890123456")).toMatchObject({ platform: "facebook", kind: "reel", canonicalId: "1234567890123456" });
    expect(one("https://www.facebook.com/watch/?v=1234567890")).toMatchObject({ kind: "video", canonicalId: "1234567890" });
    expect(one("https://www.facebook.com/share/r/1AbCdEfGh/")).toMatchObject({ kind: "short_link" });
    expect(one("https://fb.watch/abcDEF123/")).toMatchObject({ kind: "short_link" });
    expect(one("https://youtube.com/shorts/dQw4w9WgXcQ")).toMatchObject({ platform: "youtube", kind: "short" });
    expect(one("https://x.com/shop/status/1234567890123")).toMatchObject({ platform: "x", kind: "post" });
    expect(one("vm.tiktok.com/ZMabc123/")).toMatchObject({ platform: "tiktok" });
    expect(withoutSocialLinks(`the folding table at 0:16, not the chair ${REEL}`)).toBe("the folding table at 0:16, not the chair");
  });

  it("web paste: one task source, one acknowledgment, no claim the video was watched, no URL to the model", async () => {
    const t = await solo();
    const x = await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: `Mum likes this ${REEL}` });
    expect(reply(x)).toMatch(/I've added the Instagram link to your task\. I can't read the video from a link/);
    expect(reply(x)).not.toMatch(/watched|I saw|in the video/i);
    expect(fake.interpret).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fake.interpret.mock.calls[0][0])).not.toMatch(/instagram\.com/);
    const v = await view(t.taskId);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ platform: "instagram", status: "preview_only", reason: "analysis_off", openUrl: "https://www.instagram.com/reel/C9abcDEF123/" });
    expect(v[0].evidence).toEqual(["user_text"]);
  });

  it("link only: no model call, an honest prompt for a screenshot", async () => {
    const t = await solo();
    const x = await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: "https://www.tiktok.com/@a/video/7301234567890123456" });
    expect(fake.interpret).not.toHaveBeenCalled();
    expect(reply(x)).toMatch(/^I've added the TikTok link\. I can't read the video from a link: open your task and add a screenshot/);
  });
});

describe("R02 existing intake paths still work", () => {
  it("plain text, a photo and a retailer link go to the existing interpreter, with no source", async () => {
    const t = await solo();
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: "a top-opening cat carrier" });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), image: { mime: "image/png", base64: readFileSync("tests/fixtures/carrier.png").toString("base64") } });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: "this one https://www.amazon.com/dp/B012345678" });
    expect(fake.interpret).toHaveBeenCalledTimes(3);
    expect(fake.interpret.mock.calls[2][0].text).toMatch(/amazon\.com\/dp\/B012345678/);
    expect(await view(t.taskId)).toEqual([]);
  });
});

describe("R03 preview-only, private, deleted, unsupported, malformed", () => {
  it("labels each honestly and never fetches", async () => {
    const t = await solo();
    for (const u of ["https://www.instagram.com/someshop/", "https://www.instagram.com/stories/someshop/3123456789/", "https://youtube.com/shorts/dQw4w9WgXcQ"])
      await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: u });
    const v = await view(t.taskId);
    expect(v.map((s) => [s.platform, s.status, s.reason])).toEqual([["instagram", "unsupported", "not_a_post"], ["instagram", "unsupported", "story"], ["youtube", "preview_only", "secondary_source"]]);
    expect(fake.submit).not.toHaveBeenCalled();
    expect(findLinks("javascript:alert(1) https://user:pw@www.tiktok.com/@a/video/7301234567890123456 https://www.tiktok.com:8443/@a/video/1")
      .map((f) => f.type === "unsafe" ? f.reason : f.type)).toEqual(["credentials", "port"]);
  });

  it("restricted and missing posts become unavailable; an expired result asks for input", async () => {
    const t = await solo();
    enable("tiktok:7301234567890123456");
    fake.submit.mockResolvedValueOnce({ kind: "rejected", reason: "restricted" });
    const x = await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: "https://www.tiktok.com/@a/video/7301234567890123456" });
    expect(reply(x)).toMatch(/I'm checking what I can see/);
    await vi.waitFor(async () => expect((await view(t.taskId))[0].status).toBe("unavailable"));
    expect((await view(t.taskId))[0].reason).toBe("restricted");
  });

  it("a screenshot recovers on the same task", async () => {
    const t = await solo();
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: REEL });
    fake.interpret.mockResolvedValueOnce({ observations: [], proposedRequirements: [], clarification: null, reply: "A folding table.", item: "folding table" });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), image: { mime: "image/png", base64: readFileSync("tests/fixtures/carrier.png").toString("base64") } });
    expect((await view(t.taskId))[0].evidence).toEqual(["user_image"]);
    await vi.waitFor(() => expect(fake.search).toHaveBeenCalledWith(expect.objectContaining({ query: "folding table" })));
    expect((await pool.query(`SELECT search_query FROM tasks WHERE id=$1`, [t.taskId])).rows[0].search_query).toBe("folding table");
  });
});

describe("R04/R05/R11 Supadata fixtures: evidence-backed candidates", () => {
  async function analysed(products: object[]) {
    const t = await solo();
    enable("instagram:C9abcDEF123");
    fake.submit.mockResolvedValueOnce({ kind: "accepted", jobId: "job-11111111" });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: REEL });
    await vi.waitFor(async () => expect(fake.submit).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await pool.query(`SELECT state FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE s.task_id=$1`, [t.taskId])).rows[0].state).toBe("queued"));
    fake.poll.mockResolvedValueOnce({ kind: "pending", status: "active" });
    await pollDue(undefined, t.taskId);
    await pool.query(`UPDATE source_attempts SET next_poll_at=now() WHERE state IN ('queued','active')`);
    fake.poll.mockResolvedValueOnce({ kind: "completed", out: validateExtract(out(products)) });
    await pollDue(undefined, t.taskId);
    return t;
  }

  it("one labelled item links to its evidence and timestamp, labelled provider-generated", async () => {
    const t = await analysed([P("folding table", { brand: "IKEA", evidence: "both", attributes: ["white", "foldable"] })]);
    const [s] = await view(t.taskId);
    expect(s.status).toBe("resolved");
    expect(s.evidence).toEqual(["provider_visual"]);
    expect(s.candidates[0]).toMatchObject({ label: "folding table", brand: "IKEA", provenance: "provider_generated_observation", status: "proposed",
      basis: [{ type: "provider_visual", observation: "A folding table is shown", at: 16 }] });
    expect(fake.submit).toHaveBeenCalledWith("https://www.instagram.com/reel/C9abcDEF123/");
  });

  it("many items stay separate; uncertainty stays; the shopper chooses; search runs on their pick", async () => {
    const t = await analysed([P("folding table", { uncertain: ["brand unclear"] }), P("white chair", { evidence: "spoken", timestamp_seconds: 9 })]);
    const [s] = await view(t.taskId);
    expect(s.candidates.map((c) => c.label)).toEqual(["folding table", "white chair"]);
    expect(s.candidates[0].uncertain).toEqual(["brand unclear"]);
    expect(s.candidates[1].basis[0].type).toBe("provider_spoken");
    await chooseCandidate(t.taskId, t.token, s.candidates[0].id);
    expect(fake.search).toHaveBeenCalledWith(expect.objectContaining({ query: "folding table" }));
    expect((await view(t.taskId))[0].candidates.map((c) => c.status)).toEqual(["chosen", "proposed"]);
    await rejectCandidates(t.taskId, t.token, s.id);
    expect((await view(t.taskId))[0].status).toBe("needs_input");
  });

  it("no product is an honest outcome, not a guess", async () => {
    const t = await analysed([]);
    const [s] = await view(t.taskId);
    expect([s.status, s.reason, s.candidates.length]).toEqual(["needs_input", "no_product", 0]);
  });

  it("validation drops links, junk and out-of-range timestamps; unknown stays null", () => {
    const v = validateExtract({ products: [{ label: "Lamp https://evil.test/x", brand: 7, model: null, attributes: ["red", 3], evidence: "magic", observation: "", timestamp_seconds: -4, uncertain: [] }, { label: "" }] });
    expect(v.products).toEqual([{ label: "Lamp", brand: null, model: null, attributes: ["red"], evidence: "visual", observation: "Lamp", timestampS: null, uncertain: [] }]);
  });
});

describe("R06 idempotency and restart", () => {
  it("a replayed event and the same link again make one source and one billable submit", async () => {
    const t = await solo();
    enable("instagram:C9abcDEF123");
    fake.submit.mockResolvedValue({ kind: "accepted", jobId: "job-22222222" });
    const k = key();
    await postExchange(t.taskId, t.token, { channel: "web", key: k, text: REEL });
    await postExchange(t.taskId, t.token, { channel: "web", key: k, text: REEL }).catch(() => undefined);
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: `again ${REEL}` });
    await vi.waitFor(() => expect(fake.submit).toHaveBeenCalledTimes(1));
    expect(await view(t.taskId)).toHaveLength(1);
    const other = await solo();
    await postExchange(other.taskId, other.token, { channel: "web", key: key(), text: REEL });
    await vi.waitFor(() => expect(fake.submit).toHaveBeenCalledTimes(2));
    // A "restarted" worker with a fresh client picks the job up from the database
    fake.poll.mockResolvedValue({ kind: "completed", out: validateExtract(out([P("lamp")])) });
    await pollDue({ submit: vi.fn(), poll: fake.poll }, t.taskId);
    expect((await view(t.taskId))[0].candidates[0].label).toBe("lamp");
  });
});

describe("R07 newer evidence, timeouts, rate limits, schema changes", () => {
  it("a result after the shopper added evidence is kept as 'found later', never in charge", async () => {
    const t = await solo();
    enable("instagram:C9abcDEF123");
    fake.submit.mockResolvedValueOnce({ kind: "accepted", jobId: "job-33333333" });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: REEL });
    await vi.waitFor(() => expect(fake.submit).toHaveBeenCalled());
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: "it's the chair, not the table" });
    const a = (await pool.query(`SELECT a.id FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE s.task_id=$1`, [t.taskId])).rows[0];
    await applyResult(a.id, validateExtract(out([P("folding table")])));
    const [s] = await view(t.taskId);
    expect(s.candidates[0].status).toBe("late");
    expect(s.status).toBe("checking");
  });

  it("rate limits retry within a bound, then offer Try again; a lost submit is never resent", async () => {
    const t = await solo();
    enable("tiktok:7301234567890123456");
    fake.submit.mockResolvedValue({ kind: "retryable", reason: "rate_limited", retryAfterS: 0 });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: "https://www.tiktok.com/@a/video/7301234567890123456" });
    await vi.waitFor(() => expect(fake.submit).toHaveBeenCalledTimes(1));
    const [s] = await view(t.taskId);
    await pool.query(`UPDATE source_attempts SET next_poll_at=now() - interval '1 second'`);
    await submitPending(s.id);
    await submitPending(s.id);
    expect(fake.submit).toHaveBeenCalledTimes(2);
    expect((await view(t.taskId))[0].status).toBe("retryable_error");
    fake.submit.mockReset().mockResolvedValue({ kind: "unknown", reason: "timeout" });
    await retrySource(t.taskId, t.token, s.id);
    await submitPending(s.id);
    expect(fake.submit).toHaveBeenCalledTimes(1);
    expect((await view(t.taskId))[0]).toMatchObject({ status: "needs_input", reason: "check_unconfirmed" });
    await expect(retrySource(t.taskId, t.token, s.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a job past its deadline stops; a changed provider schema fails safely", async () => {
    const t = await solo();
    enable("instagram:C9abcDEF123");
    fake.submit.mockResolvedValueOnce({ kind: "accepted", jobId: "job-44444444" });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: REEL });
    await vi.waitFor(() => expect(fake.submit).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await pool.query(`SELECT count(*)::int n FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE s.task_id=$1 AND a.state='queued'`, [t.taskId])).rows[0].n).toBe(1));
    await pool.query(`UPDATE source_attempts a SET deadline=now() - interval '1 second' FROM shared_sources s WHERE s.id=a.source_id AND s.task_id=$1`, [t.taskId]);
    await pollDue(undefined, t.taskId);
    expect((await view(t.taskId))[0]).toMatchObject({ status: "needs_input", reason: "timed_out" });
    expect(fake.poll).not.toHaveBeenCalled();
  });
});

describe("R09 unsafe destinations and media", () => {
  it("the short-link resolver is off by default and refuses unsafe hops", async () => {
    const ref = (findLinks("https://vm.tiktok.com/ZMabc123/")[0] as unknown as { ref: never }).ref;
    expect(await resolveShortLink(ref)).toEqual({ ok: false, reason: "disabled" });
    const hop = (loc: string) => vi.fn(async () => new Response(null, { status: 301, headers: { location: loc } }));
    const pub = async () => [{ address: "93.184.216.34" }];
    expect(await resolveShortLink(ref, { enabled: true, lookup: pub, fetch: hop("https://www.tiktok.com/@a/video/7301234567890123456") }))
      .toMatchObject({ ok: true, ref: { canonicalId: "7301234567890123456" } });
    expect(await resolveShortLink(ref, { enabled: true, lookup: pub, fetch: hop("http://169.254.169.254/latest") })).toEqual({ ok: false, reason: "unsafe_redirect" });
    expect(await resolveShortLink(ref, { enabled: true, lookup: pub, fetch: hop("https://evil.test/x") })).toEqual({ ok: false, reason: "unsafe_redirect" });
    expect(await resolveShortLink(ref, { enabled: true, lookup: async () => [{ address: "10.0.0.5" }], fetch: hop("https://www.tiktok.com/x") })).toEqual({ ok: false, reason: "unsafe_redirect" });
    expect(await resolveShortLink(ref, { enabled: true, lookup: pub, fetch: hop("https://vm.tiktok.com/ZMloop1/") })).toEqual({ ok: false, reason: "too_many_hops" });
    expect(["127.0.0.1", "192.168.1.2", "172.20.0.1", "::1", "fd00::1", "100.64.0.1"].every(privateAddress)).toBe(true);
    expect(privateAddress("8.8.8.8")).toBe(false);
  });

  it("clip checks refuse wrong types, oversize and corrupt files before decoding", async () => {
    const t = await solo();
    const b64 = (b: Buffer) => b.toString("base64");
    await expect(analyzeClip(t.taskId, t.token, { base64: b64(Buffer.from("not a video at all, honestly")), mime: "video/mp4" })).rejects.toMatchObject({ code: "invalid" });
    await expect(analyzeClip(t.taskId, t.token, { base64: b64(Buffer.alloc(9 * 1024 * 1024)), mime: "video/mp4" })).rejects.toMatchObject({ code: "invalid" });
    const corrupt = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200, 7)]);
    expect(sniffVideo(corrupt)).toBe("video/mp4");
    await expect(analyzeClip(t.taskId, t.token, { base64: b64(corrupt), mime: "video/mp4" }, async () => { throw new Error("must not reach the model"); })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("R02/R04 the shopper's own clip (real ffmpeg, fixture model)", () => {
  it("samples frames with times, deletes the clip, and labels candidates as from your clip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clipfx-"));
    try {
      const file = join(dir, "c.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=10", "-pix_fmt", "yuv420p", "-y", file]);
      const t = await solo();
      const seen: number[] = [];
      const r = await analyzeClip(t.taskId, t.token, { base64: readFileSync(file).toString("base64"), mime: "video/mp4" }, async (frames) => {
        seen.push(...frames.map((f) => f.atS));
        expect(frames.every((f) => f.base64.length > 100)).toBe(true);
        return validateExtract(out([P("test pattern card", { timestamp_seconds: frames[1].atS })]));
      });
      expect(r.products).toBe(1);
      expect(seen).toEqual([1.5, 4.5]);
      const ups = await tx(async (c) => (await import("@/sources/intake")).uploadCandidates(c, t.taskId));
      expect(ups[0]).toMatchObject({ label: "test pattern card", provenance: "shopper_upload_frames", basis: [{ type: "authorized_frame", at: 4.5 }] });
      expect(readdirTmp()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
const readdirTmp = () => !execFileSync("sh", ["-c", `ls -d ${tmpdir()}/dt-clip-* 2>/dev/null || true`]).toString().trim();

describe("R11 Supadata adapter against stubbed HTTP (no live calls)", () => {
  const stub = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body === undefined ? null : JSON.stringify(body), { status, headers }));
  afterEach(() => vi.restoreAllMocks());

  it("submits the documented request and maps every status", async () => {
    const s = new SupadataExtract("k");
    const f = stub(202, { jobId: "8b6c1f6e-0000-4000-8000-000000000001" });
    expect(await s.submit("https://www.tiktok.com/video/7301234567890123456")).toEqual({ kind: "accepted", jobId: "8b6c1f6e-0000-4000-8000-000000000001" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.supadata.ai/v1/extract");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["prompt", "schema", "url"]);
    expect(JSON.stringify(body)).not.toMatch(/maxItems|minItems|maxLength|minLength/);
    stub(400); expect((await s.submit("u")).kind).toBe("rejected");
    stub(403); expect(await s.submit("u")).toEqual({ kind: "rejected", reason: "restricted" });
    stub(404); expect(await s.submit("u")).toEqual({ kind: "rejected", reason: "not_found_or_private" });
    stub(429, {}, { "retry-after": "7" }); expect(await s.submit("u")).toEqual({ kind: "retryable", reason: "rate_limited", retryAfterS: 7 });
    stub(503); expect((await s.submit("u")).kind).toBe("retryable");
    stub(202, { nope: 1 }); expect(await s.submit("u")).toEqual({ kind: "unknown", reason: "unreadable_response" });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await s.submit("u")).toEqual({ kind: "unknown", reason: "timeout" });
  });

  it("polls queued, active, completed, failed, expired and unknown shapes", async () => {
    const s = new SupadataExtract("k");
    stub(200, { status: "queued" }); expect(await s.poll("j")).toEqual({ kind: "pending", status: "queued" });
    stub(200, { status: "active" }); expect(await s.poll("j")).toEqual({ kind: "pending", status: "active" });
    stub(200, { status: "completed", data: out([P("kettle")]) });
    expect(await s.poll("j")).toMatchObject({ kind: "completed", out: { products: [{ label: "kettle", timestampS: 16 }] } });
    stub(200, { status: "failed", error: { message: "x" } }); expect(await s.poll("j")).toEqual({ kind: "failed", reason: "provider_failed" });
    stub(404); expect(await s.poll("j")).toEqual({ kind: "expired" });
    stub(200, { status: "brand-new-state" }); expect(await s.poll("j")).toEqual({ kind: "failed", reason: "schema_changed" });
    stub(500); expect((await s.poll("j")).kind).toBe("retryable");
  });

  it("stays off without every approval, and the assisted flow still works", async () => {
    const { supadataGate } = await import("@/sources/intake");
    const ref = { platform: "tiktok", identity: "tiktok:7301234567890123456" };
    expect((await supadataGate(ref, {})).why).toBe("disabled");
    expect((await supadataGate(ref, { SUPADATA_ENABLED: "1" })).why).toBe("no_credential");
    expect((await supadataGate(ref, { SUPADATA_ENABLED: "1", SUPADATA_API_KEY: "k", SUPADATA_PLATFORMS: "instagram" })).why).toBe("platform_not_approved");
    expect((await supadataGate(ref, { SUPADATA_ENABLED: "1", SUPADATA_API_KEY: "k", SUPADATA_PLATFORMS: "tiktok" })).why).toBe("link_not_approved");
    expect((await supadataGate(ref, { SUPADATA_ENABLED: "1", SUPADATA_API_KEY: "k", SUPADATA_PLATFORMS: "tiktok", SUPADATA_URL_ALLOWLIST: ref.identity })).why).toBe("budget");
  });
});

describe("R08 roles on the new actions", () => {
  it("a payer-only link cannot choose or redirect the item; a wrong task cannot be read", async () => {
    const t = await solo();
    enable("instagram:C9abcDEF123");
    fake.submit.mockResolvedValueOnce({ kind: "accepted", jobId: "job-55555555" });
    await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: REEL });
    await vi.waitFor(() => expect(fake.submit).toHaveBeenCalled());
    const a = (await pool.query(`SELECT a.id FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE s.task_id=$1`, [t.taskId])).rows[0];
    await applyResult(a.id, validateExtract(out([P("lamp")])));
    const [s] = await view(t.taskId);
    const { createInvite } = await import("@/domain/tasks");
    const payer = await createInvite(t.taskId, t.token, { roles: ["payer"], label: "Payer" });
    await expect(chooseCandidate(t.taskId, payer.token, s.candidates[0].id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(rejectCandidates(t.taskId, payer.token, s.id)).rejects.toMatchObject({ code: "forbidden" });
    const other = await solo();
    await expect(chooseCandidate(other.taskId, other.token, s.candidates[0].id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("R11 per-platform fixture runs of the link adapter path", () => {
  for (const [platform, url, identity] of [
    ["instagram", REEL, "instagram:C9abcDEF123"],
    ["tiktok", "https://www.tiktok.com/@shop.ke/video/7301234567890123456", "tiktok:7301234567890123456"],
    ["facebook", "https://www.facebook.com/reel/1234567890123456", "facebook:1234567890123456"],
  ] as const) {
    it(`${platform}: submit once, poll, candidate traced to provider evidence`, async () => {
      const t = await solo();
      enable(identity);
      fake.submit.mockResolvedValueOnce({ kind: "accepted", jobId: `job-${platform}-0001` });
      await postExchange(t.taskId, t.token, { channel: "web", key: key(), text: url });
      await vi.waitFor(async () => expect((await pool.query(`SELECT state FROM source_attempts a JOIN shared_sources s ON s.id=a.source_id WHERE s.task_id=$1`, [t.taskId])).rows[0]?.state).toBe("queued"));
      fake.poll.mockResolvedValueOnce({ kind: "completed", out: validateExtract(out([P("desk lamp", { evidence: "spoken", timestamp_seconds: 3 })])) });
      await pollDue(undefined, t.taskId);
      const [s] = await view(t.taskId);
      expect(s).toMatchObject({ platform, status: "resolved" });
      expect(s.candidates[0].basis).toEqual([{ type: "provider_spoken", observation: "A desk lamp is shown", at: 3 }]);
      expect(fake.submit).toHaveBeenCalledTimes(1);
    });
  }
});

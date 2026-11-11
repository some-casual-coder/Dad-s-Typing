import "./env";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.STT_MODEL = "test/stt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/domain/db";
import { OpenRouterTranscriber } from "@/adapters/stt";
import { AdapterError } from "@/adapters/types";
import { POST as createTask } from "@/app/api/tasks/route";
import { POST as invite } from "@/app/api/tasks/[id]/invites/route";
import { POST as transcribe } from "@/app/api/tasks/[id]/transcribe/route";
import {
  initialVoice, pickRecorderMime, sniffFormat, VOICE_MAX_BYTES, voiceReducer, type VoiceEvent, type VoiceState,
} from "@/lib/voice";

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5]);
const OGG = new Uint8Array([...Buffer.from("OggS"), 0, 2, 3, 4, 5]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypM4A "), 0, 0, 0, 0]);

const ok = (b: object) => new Response(JSON.stringify(b), { status: 200 });
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());
// task creation also seeds offers through fetch; count only provider calls
const sttCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("audio/transcriptions"));

describe("sniffFormat and pickRecorderMime", () => {
  it("detects containers by magic bytes", () => {
    expect(sniffFormat(WEBM)).toBe("webm");
    expect(sniffFormat(OGG)).toBe("ogg");
    expect(sniffFormat(MP4)).toBe("m4a");
    expect(sniffFormat(new Uint8Array(Buffer.from("RIFFxxxxWAVEfmt ")))).toBeNull();
    expect(sniffFormat(new Uint8Array(3))).toBeNull();
  });
  it("prefers webm, falls back to mp4 for Safari, null when nothing works", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((m) => m.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickRecorderMime(() => false)).toBeNull();
    expect(pickRecorderMime(() => { throw new Error("x"); })).toBeNull();
  });
});

describe("voice state machine", () => {
  const run = (events: VoiceEvent[], from: VoiceState = initialVoice) => events.reduce(voiceReducer, from);

  it("happy path: record, transcribe, review, edit", () => {
    let s = run([{ type: "press" }, { type: "granted", seq: 1 }, { type: "tick" }]);
    expect(s).toMatchObject({ phase: "recording", secondsLeft: 19 });
    s = run([{ type: "stop" }, { type: "result", seq: 1, text: "two, not three" }, { type: "edit", text: "two" }], s);
    expect(s).toMatchObject({ phase: "review", text: "two" });
  });
  it("cancel drops a late result and a late permission grant", () => {
    const s = run([{ type: "press" }, { type: "granted", seq: 1 }, { type: "stop" }, { type: "cancel" },
      { type: "result", seq: 1, text: "late" }]);
    expect(s).toEqual({ phase: "idle", seq: 2 });
    const p = run([{ type: "press" }, { type: "cancel" }, { type: "granted", seq: 1 }, { type: "denied", seq: 1 }]);
    expect(p.phase).toBe("idle");
  });
  it("a late result from an older request cannot overwrite a newer one", () => {
    const s = run([{ type: "press" }, { type: "granted", seq: 1 }, { type: "stop" }, { type: "cancel" },
      { type: "press" }, { type: "granted", seq: 3 }, { type: "stop" }, { type: "result", seq: 1, text: "old" }]);
    expect(s).toMatchObject({ phase: "transcribing", seq: 3 });
  });
  it("maps denial, empty speech and failures to error states", () => {
    expect(run([{ type: "press" }, { type: "denied", seq: 1 }])).toMatchObject({ error: "permission" });
    expect(run([{ type: "unsupported" }])).toMatchObject({ error: "unsupported" });
    const t = run([{ type: "press" }, { type: "granted", seq: 1 }, { type: "stop" }]);
    expect(run([{ type: "result", seq: 1, text: "  " }], t)).toMatchObject({ error: "no_speech" });
    expect(run([{ type: "failed", seq: 1, error: "timeout" }], t)).toMatchObject({ error: "timeout" });
  });
  it("retry resends only after timeout/failure, otherwise re-records", () => {
    const e = run([{ type: "press" }, { type: "granted", seq: 1 }, { type: "stop" }, { type: "failed", seq: 1, error: "failed" }]);
    expect(voiceReducer(e, { type: "retry" })).toMatchObject({ phase: "transcribing", seq: 2 });
    const n = run([{ type: "press" }, { type: "denied", seq: 1 }]);
    expect(voiceReducer(n, { type: "retry" })).toMatchObject({ phase: "requesting" });
  });
  it("ignores stop/tick outside recording", () => {
    expect(run([{ type: "stop" }, { type: "tick" }])).toEqual(initialVoice);
  });
});

describe("OpenRouterTranscriber", () => {
  it("posts base64 audio with model and format, returns trimmed text", async () => {
    fetchMock.mockImplementation(async () => (ok({ text: " two, not three ", language: "en" })));
    const r = await new OpenRouterTranscriber("k", "m/x").transcribe({ audio: WEBM, format: "webm" });
    expect(r).toEqual({ text: "two, not three", language: "en" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(JSON.parse(init.body)).toEqual({
      model: "m/x", input_audio: { data: Buffer.from(WEBM).toString("base64"), format: "webm" },
    });
    expect(init.headers.Authorization).toBe("Bearer k");
  });
  it("maps provider failures without leaking the key or audio", async () => {
    fetchMock.mockImplementation(async () => (new Response("nope k", { status: 429 })));
    const e = await new OpenRouterTranscriber("k", "m").transcribe({ audio: WEBM, format: "webm" }).catch((x) => x);
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.kind).toBe("unavailable");
    expect(e.message).not.toMatch(/k$|AQID/);
    fetchMock.mockImplementation(async () => (new Response("{}", { status: 400 })));
    expect((await new OpenRouterTranscriber("k", "m").transcribe({ audio: WEBM, format: "webm" }).catch((x) => x)).kind).toBe("rejected");
  });
  it("maps a timeout and rejects malformed output", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect((await new OpenRouterTranscriber("k", "m").transcribe({ audio: WEBM, format: "webm" }).catch((x) => x)).kind).toBe("timeout");
    fetchMock.mockImplementation(async () => (ok({ nope: 1 })));
    await expect(new OpenRouterTranscriber("k", "m").transcribe({ audio: WEBM, format: "webm" })).rejects.toThrow(AdapterError);
  });
  it("requires configuration", () => {
    expect(() => new OpenRouterTranscriber("", "m")).toThrow(AdapterError);
  });
});

describe("POST /api/tasks/:id/transcribe", () => {
  let n = 0;
  async function post(token: string | null, id: string, parts: { audio?: Uint8Array; type?: string; raw?: BodyInit; ctype?: string }) {
    let body: Uint8Array | string; let ctype: string;
    if (parts.raw !== undefined) { body = parts.raw as string; ctype = parts.ctype ?? "text/plain"; } else {
      const fd = new FormData();
      if (parts.audio) fd.append("audio", new Blob([parts.audio as BlobPart], { type: parts.type ?? "audio/webm" }), "r");
      const tmp = new Request("http://localhost/x", { method: "POST", body: fd });
      ctype = tmp.headers.get("content-type")!;
      body = new Uint8Array(await tmp.arrayBuffer());
    }
    const len = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    const req = new Request("http://localhost/x", {
      method: "POST", body: body as BodyInit,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": ctype, "content-length": String(len), "x-forwarded-for": `10.9.0.${n++}` },
    });
    const res = await transcribe(req, { params: Promise.resolve({ id }) });
    return { status: res.status, json: await res.json() };
  }
  async function task() {
    const t = await (await createTask(new Request("http://localhost/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cat carrier", starterRoles: ["requester", "chooser"] }),
    }))).json();
    const inv = await (await invite(new Request("http://localhost/x", {
      method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
      body: JSON.stringify({ roles: ["payer"] }),
    }), { params: Promise.resolve({ id: t.taskId }) } as never)).json();
    return { id: t.taskId as string, token: t.token as string, payer: inv.token as string };
  }

  it("transcribes for a message grant and returns text only", async () => {
    const t = await task();
    fetchMock.mockImplementation(async () => (ok({ text: "pay now" })));
    const r = await post(t.token, t.id, { audio: WEBM });
    expect(r).toEqual({ status: 200, json: { text: "pay now" } });
    expect(sttCalls()).toHaveLength(1);
  });
  it("rejects missing, bad and wrong-scope credentials before any provider call", async () => {
    const t = await task();
    expect((await post(null, t.id, { audio: WEBM })).status).toBe(401);
    expect((await post("x".repeat(30), t.id, { audio: WEBM })).status).toBe(404);
    expect((await post(t.payer, t.id, { audio: WEBM })).status).toBe(403);
    expect(sttCalls()).toHaveLength(0);
  });
  it("enforces size, type and magic bytes", async () => {
    const t = await task();
    expect((await post(t.token, t.id, { audio: new Uint8Array(VOICE_MAX_BYTES + 1).fill(1) })).status).toBe(413);
    expect((await post(t.token, t.id, { audio: WEBM, type: "audio/wav" })).status).toBe(415);
    expect((await post(t.token, t.id, { audio: new Uint8Array(40).fill(7) })).status).toBe(415);
    expect((await post(t.token, t.id, { audio: OGG, type: "audio/webm" })).status).toBe(415);
    expect((await post(t.token, t.id, { audio: new Uint8Array(0) })).status).toBe(422);
    expect((await post(t.token, t.id, {})).status).toBe(422);
    expect((await post(t.token, t.id, { raw: "{}", ctype: "application/json" })).status).toBe(422);
    expect(sttCalls()).toHaveLength(0);
  });
  it("accepts ogg and mp4 containers with matching bytes", async () => {
    const t = await task();
    fetchMock.mockImplementation(async () => (ok({ text: "a" })));
    expect((await post(t.token, t.id, { audio: OGG, type: "audio/ogg;codecs=opus" })).status).toBe(200);
    expect((await post(t.token, t.id, { audio: MP4, type: "audio/mp4" })).status).toBe(200);
    expect(JSON.parse(sttCalls()[1][1].body).input_audio.format).toBe("m4a");
  });
  it("rate limits per grant only after auth", async () => {
    const t = await task();
    for (let i = 0; i < 20; i++) await post("y".repeat(30), t.id, { audio: WEBM });
    fetchMock.mockImplementation(async () => (ok({ text: "a" })));
    for (let i = 0; i < 10; i++) expect((await post(t.token, t.id, { audio: WEBM })).status).toBe(200);
    expect((await post(t.token, t.id, { audio: WEBM })).status).toBe(429);
  });
  it("returns typed generic errors on provider failure and timeout", async () => {
    const t = await task();
    fetchMock.mockImplementation(async () => (new Response("secret detail", { status: 500 })));
    const f = await post(t.token, t.id, { audio: WEBM });
    expect(f.status).toBe(502);
    expect(f.json.error.code).toBe("voice_unavailable");
    expect(JSON.stringify(f.json)).not.toMatch(/secret|test-key/);
    fetchMock.mockRejectedValue(Object.assign(new Error("t"), { name: "TimeoutError" }));
    const to = await post(t.token, t.id, { audio: WEBM });
    expect(to.status).toBe(504);
    expect(to.json.error.code).toBe("voice_timeout");
  });
});

import { afterAll } from "vitest";
afterAll(() => pool.end());

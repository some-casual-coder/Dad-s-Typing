import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getInterpreter, getTranscriber } from "@/adapters";

// S03: a synthetic `say` clip (not a real speaker) through the real STT model,
// then the transcript through the interpreter with the task's item
async function clip(text: string, voice = "Daniel") {
  const dir = mkdtempSync(join(tmpdir(), "s03-"));
  try {
    execFileSync("say", ["-v", voice, "-o", join(dir, "a.aiff"), text]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-i", join(dir, "a.aiff"), "-c:a", "libopus", join(dir, "a.webm")]);
    const t0 = Date.now();
    const r = await getTranscriber().transcribe({ audio: readFileSync(join(dir, "a.webm")), format: "webm" });
    return { text: r.text, ms: Date.now() - t0 };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("English correction keeps the negation and becomes the requirement", async () => {
  const t = await clip("Actually, it needs to open from the top, not the front.");
  const r = await getInterpreter().interpret({ text: t.text, item: "top opening cat carrier", currentRequirements: [] });
  console.log(JSON.stringify({ transcript: t.text, sttMs: t.ms, proposals: r.proposedRequirements.map((p) => `${p.key} ${p.op} ${p.value} ${p.essential}`) }));
  expect(t.text.toLowerCase()).toMatch(/top.*not.*front/);
  expect(r.proposedRequirements.some((p) => p.key === "opening" && p.op === "eq" && p.value === "top")).toBe(true);
}, 90_000);

it("mixed Kiswahili and English (synthetic voice) is reported as observed", async () => {
  const t = await clip("Iwe inafunguka juu, not from the front.");
  const r = await getInterpreter().interpret({ text: t.text, item: "top opening cat carrier", currentRequirements: [] });
  console.log(JSON.stringify({ transcript: t.text, sttMs: t.ms, proposals: r.proposedRequirements.map((p) => `${p.key} ${p.op} ${p.value} ${p.essential}`) }));
  expect(t.text.length).toBeGreaterThan(0);
}, 90_000);

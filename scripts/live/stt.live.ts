import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getTranscriber } from "@/adapters";

// Synthetic macOS `say` clip, built and deleted here; needs say + ffmpeg
it("transcribes a synthetic webm clip and keeps the negation and number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stt-"));
  try {
    execFileSync("say", ["-v", "Daniel", "-o", join(dir, "a.aiff"), "two, not three"]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-i", join(dir, "a.aiff"), "-c:a", "libopus", join(dir, "a.webm")]);
    const r = await getTranscriber().transcribe({ audio: readFileSync(join(dir, "a.webm")), format: "webm" });
    expect(r.text.toLowerCase()).toMatch(/(2|two)\W+not\W+(3|three)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

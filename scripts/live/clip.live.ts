import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { framesFromEnv } from "@/adapters/openrouter";
import { sampleFrames } from "@/sources/clip";

// The shopper-upload path end to end on a clip we make ourselves (rights
// cleared): a labelled product card appears after 4 s. Real ffmpeg, real model.
it("finds the labelled item in a synthetic clip, at the right time, without guessing a brand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliplive-"));
  try {
    const file = join(dir, "c.mp4");
    // 4 s of plain background, then 5 s of the synthetic label card
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x223344:s=640x360:d=4:r=10", "-loop", "1", "-t", "5", "-r", "10",
      "-i", "tests/fixtures/kettle-card.png", "-filter_complex", "[1:v]scale=640:360,setsar=1[b];[0:v][b]concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", "-y", file]);
    const frames = await sampleFrames(file, dir);
    const out = await framesFromEnv().analyze(frames);
    console.log(JSON.stringify({ frames: frames.map((f) => f.atS), out }));
    const k = out.products.find((p) => /kettle/i.test(p.label));
    expect(k).toBeTruthy();
    expect(`${k!.brand ?? ""} ${k!.model ?? ""}`).toMatch(/ACME|K200/i);
    expect(k!.timestampS === null || k!.timestampS >= 4).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

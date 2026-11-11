import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateImage } from "@/chat/image";

const b64 = (b: Buffer) => b.toString("base64");
const png = readFileSync("tests/fixtures/carrier.png");
const jpg = readFileSync("tests/fixtures/carrier.jpg");

function webpX(w: number, h: number) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe("validateImage", () => {
  it("accepts real PNG, JPEG and WebP headers", () => {
    expect(() => validateImage("image/png", b64(png))).not.toThrow();
    expect(() => validateImage("image/jpeg", b64(jpg))).not.toThrow();
    expect(() => validateImage("image/webp", b64(webpX(800, 600)))).not.toThrow();
  });
  it("rejects declared/actual mismatch, junk, HEIC and unsupported types", () => {
    expect(() => validateImage("image/jpeg", b64(png))).toThrow(/does not match/);
    expect(() => validateImage("image/png", b64(Buffer.from("not an image at all")))).toThrow(/not a JPEG/);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(20)]);
    expect(() => validateImage("image/jpeg", b64(heic))).toThrow(/HEIC/);
    expect(() => validateImage("image/heic", b64(heic))).toThrow(/not supported/);
    expect(() => validateImage("image/gif", b64(png))).toThrow(/not supported/);
  });
  it("rejects oversize bytes, huge pixel counts and damaged headers", () => {
    expect(() => validateImage("image/png", b64(Buffer.concat([png, Buffer.alloc(4.2 * 1024 * 1024)])))).toThrow(/under 4 MB/);
    expect(() => validateImage("image/webp", b64(webpX(9000, 9000)))).toThrow(/pixels/);
    expect(() => validateImage("image/png", b64(png.subarray(0, 12)))).toThrow(/not a JPEG/);
    expect(() => validateImage("image/jpeg", b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0, 0, 0, 0])))).toThrow(/damaged/);
  });
});

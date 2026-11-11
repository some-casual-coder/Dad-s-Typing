import { DomainError } from "@/domain/errors";

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_SIDE = 12_000;

const bad = (m: string) => new DomainError("invalid", m);
const ascii = (b: Buffer, from: number, to: number) => b.toString("latin1", from, to);

function jpegSize(b: Buffer): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  const k = ascii(b, 12, 16);
  if (k === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (k === "VP8L" && b[20] === 0x2f) {
    const v = b.readUInt32LE(21);
    return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1];
  }
  if (k === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  return null;
}

function sniff(b: Buffer): { mime: string; size: [number, number] | null } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", size: jpegSize(b) };
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: "image/png", size: [b.readUInt32BE(16), b.readUInt32BE(20)] };
  }
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", size: webpSize(b) };
  return null;
}

// Checks real bytes, not the declared type; nothing here keeps or logs them
export function validateImage(mime: string | undefined, base64: string): void {
  if (!mime || !IMAGE_MIMES.includes(mime)) {
    throw bad("That photo type is not supported. Please use a JPEG, PNG or WebP photo (for an iPhone HEIC photo, take a screenshot of it or pick the JPEG version).");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) throw bad("That photo could not be read. Please choose it again.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw bad("That photo is too large. Please use one under 4 MB.");
  if (bytes.length > 12 && ascii(bytes, 4, 8) === "ftyp") {
    throw bad("HEIC/HEIF photos are not supported yet. Please take a screenshot of the photo or choose a JPEG or PNG.");
  }
  const found = sniff(bytes);
  if (!found) throw bad("That file is not a JPEG, PNG or WebP photo. Please choose a different one.");
  if (found.mime !== mime) throw bad("That file does not match its photo type. Please choose a different one.");
  const [w, h] = found.size ?? [0, 0];
  if (!w || !h) throw bad("That photo looks damaged. Please choose a different one.");
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_IMAGE_PIXELS) throw bad("That photo is too large in pixels. Please use a smaller one.");
}

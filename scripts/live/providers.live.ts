import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { getDiscovery, getInterpreter, getPayments } from "@/adapters";

function crc(b: Buffer) {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const chunk = (t: string, d: Buffer) => {
  const h = Buffer.concat([Buffer.from(t), d]);
  const out = Buffer.alloc(12 + d.length);
  out.writeUInt32BE(d.length, 0);
  h.copy(out, 4);
  out.writeUInt32BE(crc(h), 8 + d.length);
  return out;
};
// 96x64 brown box with a lighter lid band, synthetic
function png() {
  const w = 96, h = 64, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    const lid = y < 14, body = x > 8 && x < 88 && y > 8;
    const c = lid && body ? [214, 170, 110] : body ? [150, 100, 60] : [240, 240, 240];
    raw.set(c, o);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

it("gemini text and image", async () => {
  const text = await getInterpreter().interpret({ text: "I like this cat carrier, it must open from the top", currentRequirements: [] });
  console.log("gemini.text", JSON.stringify(text.proposedRequirements.map((r) => ({ key: r.key, op: r.op, value: r.value, essential: r.essential }))));
  expect(text.proposedRequirements).toContainEqual(expect.objectContaining({ key: "opening", op: "eq", value: "top", essential: true }));
  const neg = await getInterpreter().interpret({ text: "It does not need to open from the top", currentRequirements: [] });
  expect(neg.proposedRequirements.some((r) => r.key === "opening" && r.essential && r.op === "eq" && r.value === "top")).toBe(false);
  const img = await getInterpreter().interpret({ text: "Is this a good carrier?", image: { mime: "image/png", base64: png().toString("base64") }, currentRequirements: [] });
  console.log("gemini.image", `ok observations=${img.observations.length} proposals=${img.proposedRequirements.length}`);
});

it("channel3 search", async () => {
  const offers = await getDiscovery().search({ query: "top-opening cat carrier", country: "US", limit: 5 });
  console.log("channel3", `offers=${offers.length} withOpening=${offers.filter((o) => o.attributes.opening).length}`, offers[0] && `first=${offers[0].currency} ${offers[0].unitPriceMinor} ${offers[0].availability}`);
  expect(offers.every((o) => o.url.startsWith("https://") && Number.isInteger(o.unitPriceMinor))).toBe(true);
});

it("paypal create order only", async () => {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const r = await getPayments().createOrder({ requestId: randomUUID(), referenceId: "live-check", currency: "USD", totalMinor: 150, itemMinor: 100, shippingMinor: 50, description: "Live check", returnUrl: `${base}/return`, cancelUrl: `${base}/cancel` });
  const o = await getPayments().getOrder(r.paypalOrderId);
  console.log("paypal", `created approveUrlHttps=${r.approveUrl.startsWith("https://")} status=${o.status} payee=${o.payeeMerchantId ? "present" : "absent"}`);
});

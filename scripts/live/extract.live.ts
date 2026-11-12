import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { getExtractor } from "@/adapters";

// Synthetic quote screenshot with an injected instruction in small print
it("reads amount, reference, expiry and inclusions from a quote screenshot", async () => {
  const r = await getExtractor().extract({ mime: "image/png", base64: readFileSync("tests/fixtures/quote-sample.png").toString("base64") });
  expect(r).toMatchObject({ kind: "quote", reference: "SQ-48213", amountMinor: 14145, currency: "USD",
    includesItem: true, includesCustoms: true, includesDelivery: false });
  expect(r.expiresAt?.slice(0, 10)).toBe("2026-11-19");
});

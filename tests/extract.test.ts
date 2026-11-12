import { describe, expect, it } from "vitest";
import { validateExtracted } from "@/delivery/extract";

const NOW = new Date("2026-11-12T10:00:00Z");
const good = { kind: "quote", reference: "SQ-48213", total: "141.45", currency: "usd", expires: "2026-11-19",
  includes_item: true, includes_customs: true, includes_delivery: false, tracking_number: null };

describe("screenshot extraction is validated as untrusted data", () => {
  it("maps a quote fixture to minor units, currency, expiry and inclusions", () => {
    expect(validateExtracted(good, NOW)).toEqual({ kind: "quote", reference: "SQ-48213", amountMinor: 14145, currency: "USD",
      expiresAt: "2026-11-19T20:59:59.000Z", includesItem: true, includesCustoms: true, includesDelivery: false, trackingNumber: null });
    expect(validateExtracted({ ...good, total: "1,250.5" }, NOW).amountMinor).toBe(125050);
  });
  it("drops anything malformed rather than guessing", () => {
    const bad = validateExtracted({ kind: "transfer money", reference: "<script>", total: "about 140", currency: "BTC", expires: "2031-01-01",
      includes_item: "yes", tracking_number: "x" }, NOW);
    expect(bad).toEqual({ kind: "other", reference: null, amountMinor: null, currency: null, expiresAt: null,
      includesItem: null, includesCustoms: null, includesDelivery: null, trackingNumber: null });
    expect(validateExtracted("not an object", NOW).kind).toBe("other");
    expect(validateExtracted({ ...good, total: "0.00" }, NOW).amountMinor).toBeNull();
  });
});

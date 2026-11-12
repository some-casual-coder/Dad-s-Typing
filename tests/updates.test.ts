import "./env";
process.env.WHATSAPP_BRIDGE_SECRET = "s".repeat(40);
process.env.CHANNEL_SMS_SECRET = "m".repeat(40);
import { describe, expect, it } from "vitest";
import { claimOutbox } from "@/channel/outbox";
import { compose, deliverAt } from "@/channel/updates";
import { hubFor } from "@/delivery/hubs";

const x = { item: "Sherpa cat carrier", provider: "kentex", eta: { earliest: "2026-12-07", latest: "2026-12-24", legs: [], assumptions: [], confidence: "low" as const },
  currency: "USD", capMinor: 30635, actualMinor: 25000, extraMinor: null, link: "https://app.test/t/x" };

describe("assistant-style updates", () => {
  it("sends the pickup text, then a pin, on WhatsApp; a maps link on SMS", () => {
    const hub = hubFor("kentex", {})!;
    const wa = compose("ready_to_collect", x, false, true, hub);
    expect(wa.map((m) => m.kind)).toEqual(["text", "location"]);
    expect(wa[0].body).toMatch(/^Good news: the Sherpa cat carrier is ready to collect at Kentex Cargo, Westlands office, 65 Muthithi Road/);
    expect(wa[0].body).toMatch(/no ID or collection code is needed/);
    expect(JSON.stringify(wa[1])).toMatch(/approximate/);
    const sms = compose("ready_to_collect", x, false, false, hub);
    expect(sms).toHaveLength(1);
    expect(sms[0].body).toMatch(/Map \(street, approximate\): https:\/\/maps\.google\.com\/\?q=-1\.2679,36\.8089/);
  });
  it("adds a contact card only for an operator-confirmed phone", () => {
    const hub = hubFor("kentex", { HUB_KENTEX_PHONE: "+254700111222", HUB_KENTEX_PIN: "-1.26541,36.80667", HUB_KENTEX_HOURS: "Mon to Sat, 9am to 5pm" })!;
    const m = compose("ready_to_collect", x, false, true, hub);
    expect(m.map((y) => y.kind)).toEqual(["text", "location", "contact"]);
    expect(m[0].body).toMatch(/Open Mon to Sat, 9am to 5pm\./);
    expect(hubFor("kentex", { HUB_KENTEX_PHONE: "0700 not a number" })!.phone).toBeNull();
  });
  it("keeps money to people who can pay", () => {
    expect(compose("settled", x, true, true, null)[0].body).toBe("Final cost settled at USD 250.00. USD 56.35 is on its way back to your PayPal.");
    expect(compose("settled", x, false, true, null)).toEqual([]);
    expect(compose("cancelled", x, false, true, null)[0].body).not.toMatch(/USD/);
  });
  it("holds messages during Nairobi quiet hours", () => {
    expect(deliverAt(new Date("2026-11-12T09:00:00+03:00"))).toBeNull();
    expect(deliverAt(new Date("2026-11-12T22:15:00+03:00"))!.toISOString()).toBe("2026-11-13T04:30:00.000Z");
    expect(deliverAt(new Date("2026-11-13T05:00:00+03:00"))!.toISOString()).toBe("2026-11-13T04:30:00.000Z");
  });
});

describe("rich outbox items", () => {
  it("claims a pin with its payload and skips items not yet due", async () => {
    const { pool } = await import("@/domain/db");
    await pool.query(`DELETE FROM channel_outbox WHERE channel='whatsapp'`);
    await pool.query(`INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key,kind,payload) VALUES (gen_random_uuid(),'whatsapp','254700000001','Kentex','t-pin','location',$1)`,
      [JSON.stringify({ lat: -1.2679, lon: 36.8089, name: "Kentex", address: "65 Muthithi Road" })]);
    await pool.query(`INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key,not_before) VALUES (gen_random_uuid(),'whatsapp','254700000001','later','t-later', now() + interval '1 day')`);
    const items = await claimOutbox("whatsapp", 5);
    expect(items).toEqual([expect.objectContaining({ body: "Kentex", kind: "location", location: expect.objectContaining({ lat: -1.2679 }) })]);
  });
});

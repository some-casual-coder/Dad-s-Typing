import "./env";
process.env.WHATSAPP_BRIDGE_SECRET = "s".repeat(40);
import { describe, expect, it } from "vitest";
import { claimOutbox } from "@/channel/outbox";
import { hubFor } from "@/delivery/hubs";
import { deliverAt } from "@/notify";
import { asText, compose } from "@/notify/compose";

const x = { item: "Sherpa cat carrier", provider: "kentex", eta: { earliest: "2026-12-07", latest: "2026-12-24", legs: [], assumptions: [], confidence: "low" as const },
  currency: "USD", capMinor: 30635, actualMinor: 25000, extraMinor: null, link: "https://app.test/t/x" };
const ENV = { HUB_KENTEX_PIN: "-1.2699910,36.8112181", HUB_KENTEX_HOURS: "Mon to Fri 8am to 5pm, Sat 9am to 1pm, closed Sun",
  HUB_AQUANTUO_ADDRESS: "Godown V2, inside Zenith Steel Fabricators Compound, off Enterprise Road, Nairobi", HUB_AQUANTUO_HOURS: "Mon to Fri 8am to 5pm",
  HUB_AQUANTUO_PHONE: "+254800000323" };

describe("engine notices", () => {
  it("ready to collect at Kentex: address, hours, what to bring, an exact pin, no card without a confirmed phone", () => {
    const [n] = compose("ready_to_collect", x, hubFor("kentex", ENV));
    expect(n.body).toMatch(/^Good news: the Sherpa cat carrier is ready to collect at Kentex Cargo, Westlands air cargo pickup, 65 Muthithi Road, Westlands, Nairobi\. Open Mon to Fri 8am to 5pm, Sat 9am to 1pm, closed Sun\./);
    expect(n.body).toMatch(/tracking number.*Collect within 7 days/);
    expect(n.place).toMatchObject({ pin: { lat: -1.269991, lon: 36.8112181, approximate: false }, mapsUrl: "https://maps.google.com/?q=-1.269991,36.8112181" });
    expect(n.contact).toBeUndefined();
  });
  it("Aquantuo: its office address, a maps search link and a contact card, no invented pin", () => {
    const [n] = compose("ready_to_collect", { ...x, provider: "aquantuo" }, hubFor("aquantuo", ENV));
    expect(n.body).toMatch(/Aquantuo Nairobi office, Godown V2, inside Zenith Steel Fabricators Compound, off Enterprise Road/);
    expect(n.place!.pin).toBeNull();
    expect(n.place!.mapsUrl).toMatch(/^https:\/\/maps\.google\.com\/\?q=Godown%20V2/);
    expect(n.contact).toEqual({ name: "Aquantuo Nairobi office", phone: "+254800000323" });
    expect(asText(n)).toMatch(/Map: https:.*Call \+254800000323\.$/);
    expect(compose("ready_to_collect", { ...x, provider: "aquantuo" }, hubFor("aquantuo", {}))[0].body).toMatch(/will confirm where to collect/);
  });
  it("keeps money for people who can pay", () => {
    expect(compose("settled", x, null)).toEqual([{ audience: "payer", body: "Final cost settled at USD 250.00. USD 56.35 is on its way back to your PayPal." }]);
    expect(compose("cancelled", x, null).map((n) => n.audience)).toEqual(["payer", "all"]);
  });
  it("holds chat messages during Nairobi quiet hours", () => {
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
      [JSON.stringify({ lat: -1.2699910, lon: 36.8112181, name: "Kentex", address: "65 Muthithi Road" })]);
    await pool.query(`INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key,not_before) VALUES (gen_random_uuid(),'whatsapp','254700000001','later','t-later', now() + interval '1 day')`);
    expect(await claimOutbox("whatsapp", 5)).toEqual([expect.objectContaining({ body: "Kentex", kind: "location", location: expect.objectContaining({ lat: -1.269991 }) })]);
  });
});

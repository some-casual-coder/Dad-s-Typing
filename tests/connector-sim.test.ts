// SIMULATED connectors (doc 15): Instagram DM, Facebook Page Messenger, SMS and
// WhatsApp-shaped events go through the real signed inbound route, the inbox
// worker and the outbox claim/ack, against the demo catalogue. The model is a
// fixture. Nothing here is a provider pass, and no route in the app injects.
import "./env";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/domain/db";

const SECRETS: Record<string, string> = { instagram: "i".repeat(40), messenger: "f".repeat(40), sms: "t".repeat(40), whatsapp: "w".repeat(40) };
const USERS: Record<string, string> = { instagram: "17841400000001", messenger: "24000000000001", sms: "254700000011", whatsapp: "254700000021" };
for (const [ch, s] of Object.entries(SECRETS)) {
  process.env[`CHANNEL_${ch.toUpperCase()}_SECRET`] = s;
  process.env[`CHANNEL_${ch.toUpperCase()}_ALLOWED`] = USERS[ch];
}
process.env.APP_BASE_URL = "https://app.test";
process.env.PAYPAL_MERCHANT_ID = "MERCH1";

const interpret = vi.fn();
vi.mock("@/adapters", async () => ({
  getInterpreter: () => ({ interpret }),
  getPayments: () => ({}),
  getDiscovery: () => ({ search: async () => [] }),
  getFx: () => ({ kesRate: async () => ({ rate: 130, date: "2026-11-11", source: "test rate" }) }),
}));
vi.mock("@/catalog/demo", async (orig) => ({ ...(await orig<object>()), seedExternalOffers: async () => {} }));

import { POST as inboundRoute } from "@/app/api/channel/[channel]/inbound/route";
import { POST as claimRoute } from "@/app/api/channel/[channel]/outbox/claim/route";
import { POST as ackRoute } from "@/app/api/channel/[channel]/outbox/[id]/ack/route";
import { sign } from "@/channel/bridge";
import { composeReply, processInboxOnce } from "@/channel/inbox";
import { optionLabels } from "@/channel/render";
import { pendingProposals } from "@/domain/messages";
import { setRequirement, createInvite, createSellerOrder, getComparison, revokeGrant, selectOffer } from "@/domain/tasks";
import { getTaskView } from "@/domain/view";

const IMG = { mime: "image/png", base64: readFileSync("tests/fixtures/carrier.png").toString("base64") };
type H = (req: Request, ctx?: never) => Promise<Response>;

// The simulated connector: signs like a real one, nothing more
async function call(h: unknown, channel: string, path: string, body: unknown, params: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const req = new Request(`http://localhost${path}`, { method: "POST", body: text,
    headers: { "x-dt-timestamp": ts, "x-dt-signature": sign(SECRETS[channel], ts, "POST", path, text), "content-type": "application/json" } });
  const res = await (h as H)(req, { params: Promise.resolve({ channel, ...params }) } as never);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

let n = 0;
const event = (channel: string, o: Record<string, unknown> = {}) =>
  ({ providerMessageId: `${channel}.mid.${++n}`, sender: USERS[channel], receivedAt: new Date().toISOString(), ...o });
const inject = (channel: string, o: Record<string, unknown>) => call(inboundRoute, channel, `/api/channel/${channel}/inbound`, o);
async function say(channel: string, o: Record<string, unknown>) {
  const r = await inject(channel, event(channel, o));
  expect(r.status).toBe(202);
  await processInboxOnce(channel);
  return r.json.status as string;
}
const sent = async (channel: string) =>
  (await pool.query(`SELECT body FROM channel_outbox WHERE channel=$1 ORDER BY created_at`, [channel])).rows.map((r) => r.body as string);
const last = async (channel: string) => (await sent(channel)).at(-1) ?? "";
const linkIn = (body: string) => { const m = /\/t\/([0-9a-f-]{36})#k=([A-Za-z0-9_-]+)/.exec(body); return m ? { taskId: m[1], token: m[2] } : null; };
const count = async (q: string, a: unknown[] = []) => (await pool.query(q, a)).rows[0].n as number;
const tasks = () => count(`SELECT count(*)::int n FROM tasks`);

beforeEach(async () => {
  interpret.mockReset().mockImplementation(async (i: { text?: string; image?: unknown }) => {
    const t = i.text ?? "";
    const opening = /front/i.test(t) ? "front" : /top/i.test(t) ? "top" : null;
    // Like the real model: a carrier photo or the words name the item
    return { observations: [], clarification: null, reply: "Got it.", item: i.image || /carrier/i.test(t) ? "cat carrier" : "",
      proposedRequirements: opening ? [{ key: "opening", op: "eq", value: opening, essential: true, quote: t.slice(0, 40) }] : [] };
  });
  await pool.query("TRUNCATE channel_outbox, channel_inbox, channel_identities, channel_status, sender_profiles, channel_menus, channel_subscriptions, channel_admitted_senders, channel_join_codes");
});

describe("C02 Instagram DM: a shared Reel that can't be opened", () => {
  it("asks for a screenshot without claiming to have seen it; the screenshot updates the same task", async () => {
    await say("instagram", { text: "Find one like this https://www.instagram.com/reel/C9simPRIV01/" });
    const first = await last("instagram");
    expect(first).toMatch(/can't see inside the video from a link/);
    expect(first.length).toBeLessThanOrEqual(900);
    const t = linkIn(first)!;
    expect(t).not.toBeNull();
    await say("instagram", { image: IMG, text: "this one, it must open from the top" });
    expect(linkIn(await last("instagram"))!.taskId).toBe(t.taskId);
    expect(await sent("instagram")).toHaveLength(2);
    expect(await count(`SELECT count(*)::int n FROM seller_orders WHERE task_id=$1`, [t.taskId])).toBe(0);
  });

  it("an attachment the connector could not fetch gets a recovery step, not a task or invented facts", async () => {
    for (const error of ["expired", "private", "unsupported", "too_large", "unavailable"]) {
      const before = await tasks();
      expect(await say("instagram", { attachment: { error } })).toBe("accepted");
      expect(await last("instagram")).toMatch(/couldn't open that (photo|attachment)[\s\S]*screenshot or (tell|describe)/i);
      expect(await tasks()).toBe(before);
    }
    expect(interpret).not.toHaveBeenCalled();
  });
});

describe("chat options follow what was just asked for", () => {
  it("a proposed 'opens from the top' leaves out front-opening and unknown-opening options", async () => {
    await say("instagram", { image: IMG, text: "it must open from the top" });
    const options = (await last("instagram")).split("\n").filter((l) => /^\d\) /.test(l));
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o).toMatch(/Skylift/);
    // and the page the link opens shows the same thing to confirm
    const t = linkIn(await last("instagram"))!;
    expect(await pendingProposals(t.taskId, t.token)).toEqual([expect.objectContaining({ key: "opening", op: "eq", value: "top" })]);
    // with nothing proposed, the usual options come back
    interpret.mockResolvedValueOnce({ observations: [], clarification: null, reply: "Sure.", proposedRequirements: [] });
    await say("messenger", { image: IMG, text: "a cat carrier" });
    expect((await last("messenger")).split("\n").filter((l) => /^\d\) /.test(l)).some((l) => !/Skylift/.test(l))).toBe(true);
  });
});

describe("C03 Facebook Page Messenger: Page scopes, status and echo events", () => {
  it("the same sender id on two Pages is two conversations; status, read and echo events start nothing", async () => {
    await say("messenger", { account: "page_dt", image: IMG, text: "Can it open from the top?" });
    const a = linkIn(await last("messenger"))!;
    await say("messenger", { account: "page_other", text: "Can it open from the top?" });
    const b = linkIn(await last("messenger"))!;
    expect(b.taskId).not.toBe(a.taskId);
    await expect(getTaskView(a.taskId, b.token)).rejects.toThrow();

    // the connector sends the first reply, then reports delivery and read
    const claimed = (await call(claimRoute, "messenger", "/api/channel/messenger/outbox/claim", { limit: 10 })).json.items as { id: string; recipient: string; account?: string }[];
    expect(claimed.map((x) => x.account).sort()).toEqual(["page_dt", "page_other"]);
    expect(claimed.every((x) => x.recipient === USERS.messenger)).toBe(true);
    const first = claimed.find((x) => x.account === "page_dt")!;
    await call(ackRoute, "messenger", `/api/channel/messenger/outbox/${first.id}/ack`, { state: "sent", providerMessageId: "m.out.1" }, { id: first.id });
    const before = { tasks: await tasks(), out: (await sent("messenger")).length };
    for (const e of [{ kind: "status", refersTo: "m.out.1", state: "delivered" }, { kind: "status", refersTo: "m.out.1", state: "read" },
      { kind: "echo", text: "Got it." }]) {
      const r = await inject("messenger", event("messenger", { account: "page_dt", ...e }));
      expect(r.status).toBe(202);
    }
    await processInboxOnce("messenger");
    expect(await tasks()).toBe(before.tasks);
    expect((await sent("messenger")).length).toBe(before.out);
    expect(interpret).toHaveBeenCalledTimes(2);
    expect((await pool.query(`SELECT state, delivery FROM channel_outbox WHERE id=$1`, [first.id])).rows[0]).toEqual({ state: "sent", delivery: "read" });
  });

  it("a blocked reply is final, not retried, and the web task still works", async () => {
    await say("messenger", { account: "page_dt", text: "cat carrier that opens from the top" });
    const t = linkIn(await last("messenger"))!;
    const [item] = (await call(claimRoute, "messenger", "/api/channel/messenger/outbox/claim", {})).json.items;
    await call(ackRoute, "messenger", `/api/channel/messenger/outbox/${item.id}/ack`, { state: "failed", error: "policy_window_closed" }, { id: item.id });
    expect((await call(claimRoute, "messenger", "/api/channel/messenger/outbox/claim", {})).json.items).toHaveLength(0);
    expect((await getTaskView(t.taskId, t.token)).title).toBeTruthy();
  });
});

describe("C04 SMS: text only", () => {
  it("a text request gets a short reply with an intact link; no picture is assumed", async () => {
    await say("sms", { text: "Need a medium cat carrier that opens on top. Asante sana, ni ya paka wangu 🐈" });
    const r = await last("sms");
    expect(r.length).toBeLessThanOrEqual(480);
    const t = linkIn(r)!;
    expect(r).toContain(`https://app.test/t/${t.taskId}#k=${t.token}`);
    expect(r).not.toMatch(/address|receipt|capture|card/i);
    expect((await inject("sms", event("sms", { image: IMG }))).status).toBe(422);
  });
});

describe("E15 SMS copy", () => {
  it("a capped reply ends on a whole sentence with the link intact, and similar titles stay distinguishable", () => {
    const link = "https://app.test/t/00000000-0000-0000-0000-000000000000#k=abcdefghijklmnop";
    const r = composeReply({ reply: "Sawa kabisa, natafuta carrier inayofunguka juu 🐈.", extra: ["x".repeat(200) + ". Price USD 57.00 today", "y".repeat(150)],
      proposals: [{ key: "opening", op: "eq", value: "top" }], link, fresh: false, maxChars: 480 });
    expect(r.length).toBeLessThanOrEqual(480);
    expect(r.endsWith(`Your task: ${link}`)).toBe(true);
    // whole paragraphs, or a whole sentence; never "Please confirm on the"
    const kept = r.split("\n\n").at(-2)!;
    expect(kept.endsWith("USD 57.00 today") || /[.!?…]$/.test(kept)).toBe(true);
    expect(r).not.toMatch(/USD 57\.\n/);
    expect(optionLabels(["Whisker & Co Skylift top-opening carrier 45 cm", "Whisker & Co Skylift top-opening carrier 55 cm"], 28))
      .toEqual(["Whisker & Co Skylift… 45 cm", "Whisker & Co Skylift… 55 cm"]);
  });
});

describe("C05 SMS: opt out while a reply is queued", () => {
  it("suppresses queued messages and late retries, keeps the web task, and a later message does not re-subscribe", async () => {
    await say("sms", { text: "cat carrier that opens on top" });
    const t = linkIn(await last("sms"))!;
    // a status push is queued, and a reply is leased but never acknowledged
    const [leased] = (await call(claimRoute, "sms", "/api/channel/sms/outbox/claim", {})).json.items;
    await pool.query(`INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key) VALUES (gen_random_uuid(),'sms',$1,'Update','upd:sim:1')`, [USERS.sms]);
    const stop = event("sms", { text: "STOP" });
    await inject("sms", stop); await inject("sms", stop);
    await processInboxOnce("sms");
    await pool.query(`UPDATE channel_outbox SET lease_until = now() - interval '1 second' WHERE id=$1`, [leased.id]);
    const after = (await call(claimRoute, "sms", "/api/channel/sms/outbox/claim", { limit: 10 })).json.items as { body: string }[];
    expect(after.map((x) => x.body)).toEqual([expect.stringMatching(/no more order updates/)]);
    expect(await count(`SELECT count(*)::int n FROM channel_subscriptions WHERE channel='sms'`)).toBe(0);
    expect((await getTaskView(t.taskId, t.token)).title).toBeTruthy();

    await say("sms", { text: "is it waterproof?" });
    expect(await count(`SELECT count(*)::int n FROM channel_subscriptions WHERE channel='sms'`)).toBe(0);
  });

  it("a provider opt-out event is honoured without our own confirmation; an opt-in allows future replies", async () => {
    await say("sms", { text: "cat carrier that opens on top" });
    const before = (await sent("sms")).length;
    expect(await say("sms", { kind: "opt_out" })).toBe("accepted");
    expect((await sent("sms")).length).toBe(before);
    expect(await count(`SELECT count(*)::int n FROM channel_subscriptions WHERE channel='sms'`)).toBe(0);
    expect(await say("sms", { kind: "opt_in" })).toBe("accepted");
    expect(await count(`SELECT count(*)::int n FROM channel_opt_outs WHERE channel='sms'`)).toBe(0);
  });
});

describe("C06 handoff between Instagram, web and Mum", () => {
  it("explicit links carry roles; a name or id match on another channel joins nothing; a revoked link is dead", async () => {
    await say("instagram", { image: IMG, text: "for Mum's cat, must open from the top" });
    const nathan = linkIn(await last("instagram"))!;
    const mum = await createInvite(nathan.taskId, nathan.token, { roles: ["chooser"], label: "Mum" });
    const cmp = await getComparison(nathan.taskId, mum.token);
    const offer = (sku: string) => cmp.offers.find((o: { sku?: string | null }) => o.sku === sku)!;
    await selectOffer(nathan.taskId, mum.token, { offerId: offer("WC-TOP-55").id, expectedVersion: cmp.version }, { idempotencyKey: "sim-mum-1" });
    const v1 = await getTaskView(nathan.taskId, nathan.token);
    const quoted = 6400 + 900;
    await selectOffer(nathan.taskId, mum.token, { offerId: offer("WC-TOP-45").id, expectedVersion: v1.version }, { idempotencyKey: "sim-mum-2" });
    const v2 = await getTaskView(nathan.taskId, nathan.token);
    expect(v2.selection!.title).toMatch(/45 cm/);
    // the payer reviewed the 55 cm total: that amount can't be charged for the 45 cm
    await expect(createSellerOrder(nathan.taskId, nathan.token, { selectionId: v2.selection!.id, expectedTotalMinor: quoted })).rejects.toMatchObject({ code: "stale" });
    await expect(selectOffer(nathan.taskId, mum.token, { offerId: offer("WC-TOP-55").id, expectedVersion: v2.version }, { idempotencyKey: "sim-mum-3" })).resolves.toBeTruthy();

    // same numeric id on Messenger: its own task, no access to Nathan's
    await say("messenger", { text: "yes the top one" });
    const other = linkIn(await last("messenger"))!;
    expect(other.taskId).not.toBe(nathan.taskId);
    await expect(getTaskView(nathan.taskId, other.token)).rejects.toThrow();

    await revokeGrant(nathan.taskId, nathan.token, mum.grantId);
    await expect(getTaskView(nathan.taskId, mum.token)).rejects.toMatchObject({ code: "not_found" });
    expect(await count(`SELECT count(*)::int n FROM payment_attempts a JOIN seller_orders s ON s.id=a.seller_order_id WHERE s.task_id=$1`, [nathan.taskId])).toBe(0);
  });
});

describe("priority edge cases (E01-E13)", () => {
  it("E01/E02: a replay is one task and one reply; identical texts with new ids are both kept; a changed replay is refused", async () => {
    const m = event("whatsapp", { text: "cat carrier that opens on top" });
    const before = await tasks();
    expect((await inject("whatsapp", m)).json.status).toBe("accepted");
    expect((await inject("whatsapp", m)).json.status).toBe("duplicate");
    await processInboxOnce("whatsapp");
    expect(await tasks()).toBe(before + 1);
    const altered = await inject("whatsapp", { ...m, text: "actually front opening" });
    expect(altered.json.status).toBe("conflict");
    await say("whatsapp", { text: "is it waterproof?" });
    await say("whatsapp", { text: "is it waterproof?" });
    expect(await sent("whatsapp")).toHaveLength(3);
    expect(interpret.mock.calls.map((c) => c[0].text)).toEqual(["cat carrier that opens on top", "is it waterproof?", "is it waterproof?"]);
  });

  it("E03: a late 'front is fine' does not replace the confirmed top-opening requirement", async () => {
    await say("whatsapp", { text: "cat carrier that must open from the top" });
    const t = linkIn(await last("whatsapp"))!;
    // the shopper confirms on the page, as the reply asks
    await setRequirement(t.taskId, t.token, { key: "opening", op: "eq", value: "top", essential: true }, { idempotencyKey: "sim-e03" });
    await say("whatsapp", { text: "front opening is fine", receivedAt: new Date(Date.now() - 60_000).toISOString() });
    const reqs = (await getTaskView(t.taskId, t.token)).requirements.filter((r: { key: string }) => r.key === "opening");
    expect(reqs.filter((r: { status: string }) => r.status === "confirmed").map((r: { value: unknown }) => r.value)).toEqual(["top"]);
  });

  it("E04: a bare 'yes' after the last task is paid does not silently start a new one", async () => {
    await say("whatsapp", { text: "cat carrier that opens on top" });
    const t = linkIn(await last("whatsapp"))!;
    const { beginAttempt, recordProviderOrder, settleCapture } = await import("@/domain/payments");
    const cmp = await getComparison(t.taskId, t.token);
    const sel = await selectOffer(t.taskId, t.token, { offerId: cmp.offers.find((o: { sku?: string | null }) => o.sku === "WC-TOP-45")!.id, expectedVersion: cmp.version }, { idempotencyKey: "sim-e04" });
    const order = await createSellerOrder(t.taskId, t.token, { selectionId: sel.selectionId });
    const att = await beginAttempt(t.taskId, t.token, order.id);
    await recordProviderOrder(att.id, "PP-SIM-E04");
    await settleCapture(att.id, { paypalOrderId: "PP-SIM-E04", captureId: "CAPSIME04001", status: "COMPLETED", amountMinor: order.totalMinor, currency: "USD", payeeMerchantId: "MERCH1" });
    const before = await tasks();
    await say("whatsapp", { text: "yes" });
    expect(await tasks()).toBe(before);
    expect(await last("whatsapp")).toMatch(/\/t\//);
  });

  it("E08/E11: 'buy it' or 'refund it' in chat never charges or refunds", async () => {
    await say("sms", { text: "cat carrier that opens on top" });
    const t = linkIn(await last("sms"))!;
    await say("sms", { text: "buy it" });
    await say("sms", { text: "refund it" });
    expect(await count(`SELECT count(*)::int n FROM seller_orders WHERE task_id=$1`, [t.taskId])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM payment_attempts a JOIN seller_orders s ON s.id=a.seller_order_id WHERE s.task_id=$1`, [t.taskId])).toBe(0);
    expect(await count(`SELECT count(*)::int n FROM refunds r JOIN seller_orders s ON s.id=r.seller_order_id WHERE s.task_id=$1`, [t.taskId])).toBe(0);
  });

  it("E09/E12: an unacknowledged send becomes unknown, never resent after its attempts; outage leaves the web task usable", async () => {
    await say("whatsapp", { text: "cat carrier that opens on top" });
    const t = linkIn(await last("whatsapp"))!;
    for (let i = 0; i < 5; i++) {
      const items = (await call(claimRoute, "whatsapp", "/api/channel/whatsapp/outbox/claim", {})).json.items;
      expect(items).toHaveLength(1);
      await pool.query(`UPDATE channel_outbox SET lease_until = now() - interval '1 second'`);
    }
    expect((await call(claimRoute, "whatsapp", "/api/channel/whatsapp/outbox/claim", {})).json.items).toHaveLength(0);
    expect((await pool.query(`SELECT state FROM channel_outbox`)).rows[0].state).toBe("unknown");
    expect((await getTaskView(t.taskId, t.token)).title).toBeTruthy();
    expect(await count(`SELECT count(*)::int n FROM channel_outbox WHERE channel<>'whatsapp'`)).toBe(0);
  });
  // E10 is C05 above; E05 is C03 and C06; E06 and E13 are covered outside this file
});

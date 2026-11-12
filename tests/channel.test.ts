import "./env";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@/domain/db";

const SECRET = "s".repeat(40);
const SMS_SECRET = "m".repeat(40);
const EMAIL_SECRET = "e".repeat(40);
process.env.WHATSAPP_BRIDGE_SECRET = SECRET;
process.env.WHATSAPP_ALLOWED_SENDERS = "254700000001,254700000002";
process.env.CHANNEL_SMS_SECRET = SMS_SECRET;
process.env.CHANNEL_SMS_ALLOWED = "254700000001";
process.env.CHANNEL_EMAIL_SECRET = EMAIL_SECRET;
process.env.CHANNEL_EMAIL_ALLOWED = "mum@example.com";
const SECRETS: Record<string, string> = { whatsapp: SECRET, sms: SMS_SECRET, email: EMAIL_SECRET };
process.env.APP_BASE_URL = "https://app.test";

const interpret = vi.fn();
const hooks = vi.hoisted(() => ({ external: null as null | ((taskId: string) => Promise<void>) }));
vi.mock("@/adapters", async () => ({
  getInterpreter: () => ({ interpret }),
  getPayments: () => ({}),
  getDiscovery: () => ({ search: async () => [] }),
  getFx: () => ({ kesRate: async () => ({ rate: 130, date: "2026-11-11", source: "test rate" }) }),
}));
vi.mock("@/catalog/demo", async () => ({
  seedDemoOffers: async (taskId: string) => {
    const { recordOffers } = await import("@/domain/tasks");
    await recordOffers(taskId, [{ source: "demo", sourceOfferId: "TOP-1", route: "paypal", seller: "Demo", merchantId: "M1", sku: "TOP-1", title: "Carrier", unitPriceMinor: 3599, shippingMinor: 800, currency: "USD", availability: "InStock" }]);
  },
  seedExternalOffers: async (taskId: string) => { await hooks.external?.(taskId); },
}));

import { POST as inbound } from "@/app/api/channel/[channel]/inbound/route";
import { POST as claim } from "@/app/api/channel/[channel]/outbox/claim/route";
import { POST as ack } from "@/app/api/channel/[channel]/outbox/[id]/ack/route";
import { POST as health } from "@/app/api/channel/[channel]/health/route";
import { GET as status } from "@/app/api/channel/[channel]/status/route";
import { deriveChannelToken, senderHash, sign } from "@/channel/bridge";
import { assertDistinctSecrets } from "@/channel/registry";
import { scrubModelText } from "@/chat/exchange";
import { clientIp, dailyCap } from "@/app/api/_lib/http";
import { processInboxOnce } from "@/channel/inbox";
import { getTaskView } from "@/domain/view";

type H = (req: Request, ctx?: never) => Promise<Response>;
async function signed(h: unknown, path: string, body: unknown, params: Record<string, string> = {}, over: { ts?: string; secret?: string; method?: string; tamper?: boolean } = {}) {
  const text = JSON.stringify(body);
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
  const channel = /^\/api\/channel\/([^/]+)\//.exec(path)![1];
  params = { channel, ...params };
  const sig = sign(over.secret ?? SECRETS[channel] ?? SECRET, ts, over.method ?? "POST", path, text);
  const req = new Request(`http://localhost${path}`, { method: "POST", body: over.tamper ? text + " " : text, headers: { "x-dt-timestamp": ts, "x-dt-signature": sig, "content-type": "application/json" } });
  const res = await (h as H)(req, { params: Promise.resolve(params) } as never);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

let n = 0;
const msg = (o: Record<string, unknown> = {}) => ({ providerMessageId: `wamid.${Date.now()}.${++n}`, sender: "254700000001", text: "Mum wants a cat carrier", receivedAt: new Date().toISOString(), ...o });
const IMG = { mime: "image/png", base64: readFileSync("tests/fixtures/carrier.png").toString("base64") };
const IN = "/api/channel/whatsapp/inbound";

beforeEach(async () => {
  interpret.mockReset().mockResolvedValue({ observations: [], proposedRequirements: [{ key: "opening", op: "eq", value: "top", essential: true, quote: "x" }], clarification: null, reply: "Got it, a cat carrier." });
  await pool.query("TRUNCATE channel_outbox, channel_inbox, channel_identities, channel_status, sender_profiles, channel_menus, channel_subscriptions");
});

const count = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0].n as number;

describe("signatures", () => {
  it("rejects missing, wrong, stale, tampered and wrong-path requests", async () => {
    const body = msg({ image: IMG });
    const bare = await (inbound as H)(new Request(`http://localhost${IN}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ channel: "whatsapp" }) } as never);
    expect(bare.status).toBe(403);
    expect((await signed(inbound, IN, body, {}, { secret: "x".repeat(40) })).status).toBe(403);
    expect((await signed(inbound, IN, body, {}, { ts: String(Math.floor(Date.now() / 1000) - 1000) })).status).toBe(403);
    expect((await signed(inbound, IN, body, {}, { tamper: true })).status).toBe(403);
    expect((await signed(claim, "/api/channel/whatsapp/outbox/claim", {}, {}, { method: "GET" })).status).toBe(403);
    expect(await count("SELECT count(*)::int n FROM channel_inbox")).toBe(0);
    expect((await signed(inbound, IN, body)).status).toBe(202);
  });

  it("fails closed when the secret is not configured", async () => {
    const keep = process.env.WHATSAPP_BRIDGE_SECRET;
    process.env.WHATSAPP_BRIDGE_SECRET = "short";
    try {
      expect((await signed(inbound, IN, msg(), {}, { secret: "short" })).status).toBe(403);
    } finally {
      process.env.WHATSAPP_BRIDGE_SECRET = keep;
    }
  });

  it("matches the Go connector's signature vector", async () => {
    const f = "connectors/whatsapp/testdata/signature_vector.json";
    if (!existsSync(f)) return;
    const file = JSON.parse(readFileSync(f, "utf8"));
    expect(file.vectors.length).toBeGreaterThan(0);
    for (const v of file.vectors) expect(sign(file.secret, String(v.ts), v.method, v.path, v.body)).toBe(v.signature);
  });
});

describe("inbound", () => {
  it("ignores senders that are not allowlisted and keeps no state", async () => {
    const r = await signed(inbound, IN, msg({ sender: "254799999999" }));
    expect(r.json.status).toBe("ignored");
    expect(await count("SELECT count(*)::int n FROM channel_inbox")).toBe(0);
    const keep = process.env.WHATSAPP_ALLOWED_SENDERS;
    process.env.WHATSAPP_ALLOWED_SENDERS = "";
    try {
      expect((await signed(inbound, IN, msg())).json.status).toBe("ignored");
    } finally {
      process.env.WHATSAPP_ALLOWED_SENDERS = keep;
    }
  });

  it("accepts a business-scoped WhatsApp id when it is allowlisted", async () => {
    const keep = process.env.WHATSAPP_ALLOWED_SENDERS;
    process.env.WHATSAPP_ALLOWED_SENDERS = "KE.00000000000000000001";
    try {
      expect((await signed(inbound, IN, msg({ sender: "KE.00000000000000000001" }))).json.status).toBe("accepted");
      expect((await signed(inbound, IN, msg({ sender: "KE.00000000000000000002" }))).json.status).toBe("ignored");
    } finally {
      process.env.WHATSAPP_ALLOWED_SENDERS = keep;
    }
  });

  it("validates the payload", async () => {
    for (const bad of [{ sender: "abc" }, { providerMessageId: "bad id!" }, { image: { mime: "image/gif", base64: "AAAA" } }, { image: { mime: "image/png", base64: "***" } }, { image: { mime: "image/png", base64: Buffer.from("not really a png").toString("base64") } }, { image: { mime: "image/jpeg", base64: readFileSync("tests/fixtures/carrier.png").toString("base64") } }, { text: "", image: undefined }, { receivedAt: "nope" }]) {
      expect((await signed(inbound, IN, msg(bad))).status).toBe(422);
    }
  });

  it("a duplicate delivery is stored once", async () => {
    const m = msg({ image: IMG });
    expect((await signed(inbound, IN, m)).json.status).toBe("accepted");
    expect((await signed(inbound, IN, m)).json.status).toBe("duplicate");
    expect(await count("SELECT count(*)::int n FROM channel_inbox")).toBe(1);
  });
});

describe("a forwarded photo", () => {
  it("creates exactly one task and one reply whose link opens that task", async () => {
    const m = msg({ image: IMG, text: "For Mum" });
    await signed(inbound, IN, m);
    await signed(inbound, IN, m);
    await Promise.all([processInboxOnce(), processInboxOnce(), processInboxOnce()]);
    expect(await count("SELECT count(*)::int n FROM tasks t JOIN channel_identities i ON i.task_id=t.id")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM channel_outbox")).toBe(1);
    const out = (await pool.query("SELECT recipient, body FROM channel_outbox")).rows[0];
    expect(out.recipient).toBe("254700000001");
    const [, taskId, token] = /https:\/\/app\.test\/t\/([0-9a-f-]{36})#k=([A-Za-z0-9_-]+)/.exec(out.body)!;
    const view = await getTaskView(taskId, token);
    expect(view.viewer.roles).toEqual(["requester", "chooser", "helper", "payer"]);
    expect(out.body).toContain("opening eq top");
    expect(await count("SELECT count(*)::int n FROM channel_inbox WHERE image_b64 IS NOT NULL")).toBe(0);
    expect(await count("SELECT count(*)::int n FROM offers WHERE task_id=$1", [taskId])).toBeGreaterThan(0);
  });

  it("a crash after the task was made does not make a second task or reply", async () => {
    const m = msg({ image: IMG });
    await signed(inbound, IN, m);
    await processInboxOnce();
    await pool.query("UPDATE channel_inbox SET state='processing', sender='254700000001', locked_until=now() - interval '1 minute', image_b64=$1 WHERE provider_message_id=$2", [IMG.base64, m.providerMessageId]);
    await processInboxOnce();
    expect(await count("SELECT count(*)::int n FROM channel_identities")).toBe(1);
    expect(await count("SELECT count(DISTINCT task_id)::int n FROM channel_inbox")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM channel_outbox")).toBe(1);
    expect(await count("SELECT count(*)::int n FROM messages WHERE channel='whatsapp' AND task_id IN (SELECT task_id FROM channel_inbox)")).toBe(1);
  });

  it("text continues the open task; a new photo starts another; senders stay separate", async () => {
    await signed(inbound, IN, msg({ image: IMG }));
    await processInboxOnce();
    await signed(inbound, IN, msg({ text: "it must open from the top" }));
    await processInboxOnce();
    expect(await count("SELECT count(DISTINCT task_id)::int n FROM channel_inbox")).toBe(1);
    await signed(inbound, IN, msg({ image: IMG }));
    await processInboxOnce();
    expect(await count("SELECT count(DISTINCT task_id)::int n FROM channel_inbox")).toBe(2);
    await signed(inbound, IN, msg({ sender: "254700000002", text: "hello" }));
    await processInboxOnce();
    expect(await count("SELECT count(DISTINCT task_id)::int n FROM channel_inbox")).toBe(3);
    const own = await pool.query("SELECT DISTINCT i.sender_hash FROM channel_identities i");
    expect(own.rows).toHaveLength(2);
  });

  it("a model failure still sends the link", async () => {
    interpret.mockRejectedValue(new Error("down"));
    await signed(inbound, IN, msg({ image: IMG }));
    await processInboxOnce();
    const body = (await pool.query("SELECT body FROM channel_outbox")).rows[0].body as string;
    expect(body).toContain("could not read that");
    expect(body).toContain("https://app.test/t/");
  });
});

describe("outbox", () => {
  const CL = "/api/channel/whatsapp/outbox/claim";
  const seed = async () => {
    await signed(inbound, IN, msg({ image: IMG }));
    await processInboxOnce();
    return (await pool.query("SELECT id FROM channel_outbox")).rows[0].id as string;
  };
  const ackPath = (id: string) => `/api/channel/whatsapp/outbox/${id}/ack`;

  it("leases an item once, then returns it after the lease lapses", async () => {
    const id = await seed();
    const a = await signed(claim, CL, {});
    expect(a.json.items).toHaveLength(1);
    expect(a.json.items[0]).toMatchObject({ id, recipient: "254700000001", attempt: 1 });
    expect((await signed(claim, CL, {})).json.items).toHaveLength(0);
    await pool.query("UPDATE channel_outbox SET lease_until = now() - interval '1 second'");
    const b = await signed(claim, CL, {});
    expect(b.json.items[0]).toMatchObject({ id, attempt: 2 });
  });

  it("ack is idempotent, the first final state wins, and the text is dropped", async () => {
    const id = await seed();
    await signed(claim, CL, {});
    expect((await signed(ack, ackPath(id), { state: "sent", providerMessageId: "3EB0ABC" }, { id })).json.state).toBe("sent");
    expect((await signed(ack, ackPath(id), { state: "sent", providerMessageId: "3EB0ABC" }, { id })).json.state).toBe("sent");
    expect((await signed(ack, ackPath(id), { state: "failed" }, { id })).json.state).toBe("sent");
    const gone = (await pool.query("SELECT body, recipient FROM channel_outbox")).rows[0];
    expect(gone).toEqual({ body: "", recipient: "" });
    expect(await count("SELECT count(*)::int n FROM channel_inbox WHERE sender <> ''")).toBe(0);
    expect((await signed(claim, CL, {})).json.items).toHaveLength(0);
    expect((await signed(ack, ackPath(id), { state: "bogus" }, { id })).status).toBe(422);
    const other = "00000000-0000-4000-8000-000000000000";
    expect((await signed(ack, ackPath(other), { state: "sent" }, { id: other })).status).toBe(404);
  });

  it("an item that may have been sent is never resent", async () => {
    const id = await seed();
    await signed(claim, CL, {});
    await signed(ack, ackPath(id), { state: "unknown" }, { id });
    expect((await signed(claim, CL, {})).json.items).toHaveLength(0);
    // out of attempts with an expired lease also ends as unknown, not pending
    await signed(inbound, IN, msg({ image: IMG }));
    await processInboxOnce();
    await pool.query("UPDATE channel_outbox SET state='leased', attempts=5, lease_until=now() - interval '1 second' WHERE state='pending'");
    expect((await signed(claim, CL, {})).json.items).toHaveLength(0);
    expect(await count("SELECT count(*)::int n FROM channel_outbox WHERE state='unknown'")).toBe(2);
  });
});

describe("health", () => {
  it("reports status and treats a stale report as down", async () => {
    const H = "/api/channel/whatsapp/health";
    expect((await signed(health, H, { connected: true, paired: true, loggedOut: false, version: "1", at: new Date().toISOString() })).status).toBe(204);
    const s = await (status as H)(new Request("http://localhost/api/channel/whatsapp/status"), { params: Promise.resolve({ channel: "whatsapp" }) } as never);
    expect((await s.json()).connected).toBe(true);
    await pool.query("UPDATE channel_status SET reported_at = now() - interval '10 minutes'");
    expect((await ((await (status as H)(new Request("http://localhost/api/channel/whatsapp/status"), { params: Promise.resolve({ channel: "whatsapp" }) } as never)).json())).connected).toBe(false);
    expect((await signed(health, H, { connected: "yes" })).status).toBe(422);
  });
});

describe("retention", () => {
  it("drops finished rows after a week", async () => {
    await signed(inbound, IN, msg({ image: IMG }));
    await processInboxOnce();
    await pool.query("UPDATE channel_inbox SET created_at = now() - interval '8 days'");
    await processInboxOnce();
    expect(await count("SELECT count(*)::int n FROM channel_inbox")).toBe(0);
  });
});

describe("any channel", () => {
  const smsIn = "/api/channel/sms/inbound";
  const emailIn = "/api/channel/email/inbound";

  it("unknown or unconfigured channels are refused", async () => {
    expect((await signed(inbound, "/api/channel/fax/inbound", msg())).status).toBe(403);
    expect((await signed(inbound, "/api/channel/telegram/inbound", msg(), {}, { secret: SECRET })).status).toBe(403);
  });

  it("each channel has its own secret", async () => {
    const m = msg();
    expect((await signed(inbound, smsIn, m, {}, { secret: SECRET })).status).toBe(403);
    expect((await signed(inbound, smsIn, m)).status).toBe(202);
    expect((await signed(inbound, IN, msg(), {}, { secret: SMS_SECRET })).status).toBe(403);
  });

  it("a text-only channel rejects images and caps the reply, keeping the link", async () => {
    expect((await signed(inbound, smsIn, msg({ image: IMG }))).status).toBe(422);
    interpret.mockResolvedValue({ observations: [], proposedRequirements: [], clarification: null, reply: "long ".repeat(400) });
    await signed(inbound, smsIn, msg());
    await processInboxOnce("sms");
    const body = (await pool.query("SELECT body FROM channel_outbox WHERE channel='sms'")).rows[0].body as string;
    expect(body.length).toBeLessThanOrEqual(480);
    expect(body).toMatch(/https:\/\/app\.test\/t\/[0-9a-f-]{36}#k=[A-Za-z0-9_-]+$/);
  });

  it("the same number on two channels is two separate tasks, and tokens do not cross", async () => {
    await signed(inbound, IN, msg({ text: "carrier" }));
    await signed(inbound, smsIn, msg({ text: "carrier" }));
    await processInboxOnce();
    const rows = (await pool.query("SELECT channel, task_id, grant_id FROM channel_identities ORDER BY channel")).rows;
    expect(rows.map((r) => r.channel)).toEqual(["sms", "whatsapp"]);
    expect(rows[0].task_id).not.toBe(rows[1].task_id);
    const { deriveChannelToken } = await import("@/channel/bridge");
    const smsToken = deriveChannelToken("sms", rows[0].grant_id);
    expect((await getTaskView(rows[0].task_id, smsToken)).title).toBeTruthy();
    await expect(getTaskView(rows[0].task_id, deriveChannelToken("whatsapp", rows[0].grant_id))).rejects.toMatchObject({ code: "not_found" });
  });

  it("works with a non-phone identity such as an email address", async () => {
    expect((await signed(inbound, emailIn, msg({ sender: "mum@example.com", text: "Need a cat carrier" }))).json.status).toBe("accepted");
    expect((await signed(inbound, emailIn, msg({ sender: "mum@evil.test", text: "hi" }))).json.status).toBe("ignored");
    expect((await signed(inbound, emailIn, msg({ sender: "not an address" }))).status).toBe(422);
    await processInboxOnce("email");
    const out = (await pool.query("SELECT recipient, body FROM channel_outbox WHERE channel='email'")).rows[0];
    expect(out.recipient).toBe("mum@example.com");
    expect(out.body).toContain("https://app.test/t/");
  });

  it("a connector only claims its own channel's messages", async () => {
    await signed(inbound, IN, msg({ text: "one" }));
    await signed(inbound, smsIn, msg({ text: "two" }));
    await processInboxOnce();
    const a = await signed(claim, "/api/channel/sms/outbox/claim", {});
    expect(a.json.items).toHaveLength(1);
    const b = await signed(claim, "/api/channel/whatsapp/outbox/claim", {});
    expect(b.json.items).toHaveLength(1);
    const wrong = await signed(ack, `/api/channel/whatsapp/outbox/${a.json.items[0].id}/ack`, { state: "sent" });
    expect(wrong.status).toBe(404);
  });
});

describe("review hardening", () => {
  it("refuses to start when two channels share a secret", () => {
    expect(() => assertDistinctSecrets({ CHANNEL_SMS_SECRET: "z".repeat(40), CHANNEL_EMAIL_SECRET: "z".repeat(40) } as never)).toThrow(/share a secret/);
    expect(() => assertDistinctSecrets({ CHANNEL_SMS_SECRET: "a".repeat(40), CHANNEL_EMAIL_SECRET: "b".repeat(40) } as never)).not.toThrow();
  });

  it("derives different tokens and hashes per purpose and channel", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(deriveChannelToken("sms", id)).not.toBe(deriveChannelToken("whatsapp", id));
    expect(deriveChannelToken("sms", id)).toBe(deriveChannelToken("sms", id));
    expect(senderHash("sms", "254700000001")).not.toBe(senderHash("whatsapp", "254700000001"));
  });

  it("channel grants expire and activity extends them", async () => {
    await signed(inbound, IN, msg({ text: "carrier" }));
    await processInboxOnce();
    const g = (await pool.query("SELECT grant_id FROM channel_identities")).rows[0].grant_id;
    const first = (await pool.query("SELECT expires_at FROM grants WHERE id=$1", [g])).rows[0].expires_at as Date;
    expect(first.getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
    await pool.query("UPDATE grants SET expires_at = now() + interval '1 day' WHERE id=$1", [g]);
    await signed(inbound, IN, msg({ text: "it must open from the top" }));
    await processInboxOnce();
    const next = (await pool.query("SELECT expires_at FROM grants WHERE id=$1", [g])).rows[0].expires_at as Date;
    expect(next.getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
  });

  it("removes links, emails and numbers from model text", () => {
    expect(scrubModelText("Log in at https://evil.test/x or www.evil.test, mail a@b.co or call +254 700 000 001 now")).toBe("Log in at or mail or call now");
    expect(scrubModelText("It is 45 cm long")).toBe("It is 45 cm long");
  });

  it("a model reply with a link never reaches the sender", async () => {
    interpret.mockResolvedValue({ observations: [], proposedRequirements: [], clarification: null, reply: "Please visit https://evil.test/pay now" });
    await signed(inbound, IN, msg({ text: "carrier" }));
    await processInboxOnce();
    const body = (await pool.query("SELECT body FROM channel_outbox")).rows[0].body as string;
    expect(body).not.toContain("evil.test");
    expect(body).toContain("https://app.test/t/");
    expect(body).toContain("read by an AI service");
  });

  it("a message that keeps failing gets a reply and then loses its payload", async () => {
    const m = msg({ text: "secret words" });
    await signed(inbound, IN, m);
    await pool.query("UPDATE channel_inbox SET state='processing', attempts=5, locked_until=now() - interval '1 minute' WHERE provider_message_id=$1", [m.providerMessageId]);
    await processInboxOnce();
    const out = (await pool.query("SELECT recipient, body FROM channel_outbox")).rows;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ recipient: "254700000001" });
    expect(out[0].body).toContain("could not process");
    expect((await pool.query("SELECT sender, body, state FROM channel_inbox")).rows[0]).toEqual({ sender: "", body: "", state: "failed" });
  });

  it("rate-limit identity comes from the trusted end of x-forwarded-for", () => {
    process.env.TRUST_PROXY = "1";
    const req = (xff: string) => new Request("http://x", { headers: { "x-forwarded-for": xff } });
    expect(clientIp(req("evil, 9.9.9.9"))).toBe("9.9.9.9");
    expect(clientIp(req("1.1.1.1, 2.2.2.2, 9.9.9.9"))).toBe("9.9.9.9");
    process.env.TRUST_PROXY_HOPS = "2";
    expect(clientIp(req("1.1.1.1, 2.2.2.2, 9.9.9.9"))).toBe("2.2.2.2");
    delete process.env.TRUST_PROXY_HOPS;
  });
});

describe("scrub and caps", () => {
  it("also removes bare domains, obfuscated links and handles", () => {
    for (const t of ["visit bit.ly/x now", "go to evil[.]com", "see evil dot com", "message @helpdesk", "try t.me/abc", "mail a@b.co today"]) {
      expect(scrubModelText(t)).not.toMatch(/bit\.ly|evil|@|t\.me|b\.co/);
    }
    expect(scrubModelText("a polka dot bag, e.g. 45.5 cm")).toBe("a polka dot bag, e.g. 45.5 cm");
  });

  it("a daily cap stops further calls with a clear 429", () => {
    dailyCap("cap-test", 2); dailyCap("cap-test", 2);
    expect(() => dailyCap("cap-test", 2)).toThrow(/daily limit/);
  });
});

describe("destination from the sender", () => {
  const outbox = async () => (await pool.query(`SELECT body FROM channel_outbox ORDER BY created_at`)).rows.map((r) => r.body as string);
  const send = async (o: Record<string, unknown>) => {
    expect((await signed(inbound, IN, msg(o))).status).toBe(202);
    await processInboxOnce("whatsapp");
  };

  it("asks once for a +254 sender, and a returning sender is asked nothing", async () => {
    await send({ image: IMG });
    expect((await outbox()).at(-1)).toMatch(/You collect it in Nairobi at no extra cost\. Reply YES/);
    await send({ text: "Westlands" });
    expect((await outbox()).at(-1)).toMatch(/^Delivering to your door in Westlands, Nairobi/);
    expect(interpret).toHaveBeenCalledTimes(1);
    // A new photo starts a new task: the saved place is used, no question
    await send({ image: IMG });
    const last = (await outbox()).at(-1)!;
    expect(last).not.toMatch(/Reply YES/);
    expect(last).toMatch(/Delivering to your door in Westlands, Nairobi, as last time/);
  });

  it("a YES confirms the default", async () => {
    await send({ image: IMG });
    await send({ text: "yes" });
    expect((await outbox()).at(-1)).toMatch(/^You'll collect it in Nairobi\./);
  });

  it("maps a location pin to county and area and keeps no coordinates", async () => {
    await send({ image: IMG });
    await send({ text: undefined, location: { lat: -1.2921, lon: 36.7856 } });
    expect((await outbox()).at(-1)).toMatch(/deliver to your door in Kilimani, Nairobi/);
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name ILIKE '%lat%' OR column_name ILIKE '%lon%' OR column_name ILIKE '%coord%')`)).rows;
    expect(cols).toEqual([]);
    const inbox = (await pool.query(`SELECT place_county, place_area FROM channel_inbox`)).rows;
    expect(inbox.every((r) => r.place_county === null && r.place_area === null)).toBe(true);
    const dump = JSON.stringify((await pool.query(`SELECT * FROM delivery_plans`)).rows) + JSON.stringify((await pool.query(`SELECT * FROM sender_profiles`)).rows)
      + JSON.stringify((await pool.query(`SELECT payload FROM task_events`)).rows);
    expect(dump).not.toMatch(/-1\.29|36\.78/);
  });

  it("refuses a pin outside Kenya or a malformed one", async () => {
    await send({ text: undefined, location: { lat: 51.5, lon: -0.12 } });
    expect((await outbox()).at(-1)).toMatch(/outside Kenya/);
    expect((await signed(inbound, IN, msg({ text: undefined, location: { lat: "x", lon: 1 } }))).status).toBe(422);
  });
});

describe("the whole journey in chat", () => {
  const outbox = async () => (await pool.query(`SELECT body FROM channel_outbox WHERE recipient='254700000001' ORDER BY created_at`)).rows.map((r) => r.body as string);
  const send = async (o: Record<string, unknown>) => {
    expect((await signed(inbound, IN, msg(o))).status).toBe(202);
    await processInboxOnce("whatsapp");
    return (await outbox()).at(-1)!;
  };

  it("photo, numbered options, a number, one payment, then plain status pushes", async () => {
    process.env.PAYPAL_MERCHANT_ID = "MERCH1";
    hooks.external = async (taskId) => {
      const { recordOffers } = await import("@/domain/tasks");
      await recordOffers(taskId, [{ source: "channel3", sourceOfferId: `C-${Date.now()}`, route: "external", seller: "amazon.com", title: "Sherpa cat carrier",
        unitPriceMinor: 3000, currency: "USD", availability: "InStock", url: "https://www.amazon.com/dp/B012345678",
        specs: { weightGrams: 1200, lengthMm: 450, widthMm: 300, heightMm: 280 } }]);
    };
    try {
      const first = await send({ image: IMG });
      expect(first).toMatch(/To collect in Nairobi, all costs in:\n1\) /);
      expect(first).toMatch(/Reply 1 or 2 to choose\./);
      expect(first).toMatch(/You collect it in Nairobi at no extra cost/);
      await send({ text: "Westlands" });
      const pick = /(\d)\) Sherpa cat carrier/.exec(first)![1];
      const chosen = await send({ text: pick });
      expect(chosen).toMatch(/^You chose Sherpa cat carrier\.\nOne payment of up to USD [\d.]+ \(about KSh [\d,]+\) covers/);
      expect(chosen).toMatch(/Arrives about .*\nPay securely here: https:\/\/app\.test\/t\//);

      // Same engine state the browser sees, through the channel's own grant
      const hash = senderHash("whatsapp", "254700000001");
      const id = (await pool.query(`SELECT task_id, grant_id FROM channel_identities WHERE sender_hash=$1`, [hash])).rows[0];
      const token = deriveChannelToken("whatsapp", id.grant_id);
      const view = await getTaskView(id.task_id, token);
      expect(view.selection!.title).toBe("Sherpa cat carrier");
      expect(view.order!.kind).toBe("concierge");

      const { beginAttempt, recordProviderOrder, settleCapture } = await import("@/domain/payments");
      const att = await beginAttempt(id.task_id, token, view.order!.id);
      await recordProviderOrder(att.id, "PP-CHAT-1");
      await settleCapture(att.id, { paypalOrderId: "PP-CHAT-1", captureId: "CAPCHAT00001", status: "COMPLETED", amountMinor: view.order!.totalMinor, currency: "USD", payeeMerchantId: "MERCH1" });
      expect((await outbox()).at(-1)).toMatch(/^Payment received for the Sherpa cat carrier\./);
      const { recordFulfilment } = await import("@/domain/concierge");
      await recordFulfilment({} as never, { orderId: view.order!.id, status: "ordered", source: "operator", key: "chat-ordered-1" });
      expect((await outbox()).at(-1)).toBe("I've ordered the Sherpa cat carrier from the store. Next stop: Kentex's US warehouse.");
    } finally { hooks.external = null; }
  });

  it("a bad number is answered with the link, and a contact card yields a payer-only link", async () => {
    await send({ image: IMG });
    expect(await send({ text: "7" })).toMatch(/^Please reply with a number from the list/);
    const r = await send({ text: undefined, contact: { name: "Dad <script>" } });
    expect(r).toMatch(/^Forward this link to Dad script so they can review and pay/);
    const tok = /#k=([A-Za-z0-9_-]+)/.exec(r)![1];
    const hash = senderHash("whatsapp", "254700000001");
    const id = (await pool.query(`SELECT task_id FROM channel_identities WHERE sender_hash=$1`, [hash])).rows[0];
    expect((await getTaskView(id.task_id, tok)).viewer.roles).toEqual(["payer"]);
    const kept = (await pool.query(`SELECT count(*)::int n FROM channel_inbox WHERE contact_name IS NOT NULL`)).rows[0].n;
    expect(kept).toBe(0);
  });
});

describe("WhatsApp updates opt-in", () => {
  const send = async (o: Record<string, unknown>) => {
    expect((await signed(inbound, IN, msg(o))).status).toBe(202);
    await processInboxOnce("whatsapp");
    return (await pool.query(`SELECT body FROM channel_outbox ORDER BY created_at DESC LIMIT 1`)).rows[0].body as string;
  };

  it("JOIN with a one-time code subscribes the payer; STOP ends it and drops pending reminders", async () => {
    const { createTask } = await import("@/domain/tasks");
    const { createJoinCode } = await import("@/channel/join");
    const t = await createTask({ title: "Cat carrier for Mum", starterRoles: ["helper", "payer"], starterLabel: "Payer" });
    const { code } = await createJoinCode(t.taskId, t.token);
    expect(await send({ text: `join ${code.toLowerCase()}` })).toMatch(/^You're in\. I'll message you here as "Cat carrier for Mum" moves/);
    expect(interpret).not.toHaveBeenCalled();
    const sub = (await pool.query(`SELECT can_pay FROM channel_subscriptions WHERE task_id=$1`, [t.taskId])).rows;
    expect(sub).toEqual([{ can_pay: true }]);
    expect(await send({ text: `JOIN ${code}` })).toMatch(/didn't work/);
    await pool.query(`INSERT INTO channel_outbox (id,channel,recipient,body,dedupe_key) VALUES (gen_random_uuid(),'whatsapp','254700000001','x','rem:test:1')`);
    expect(await send({ text: "STOP" })).toMatch(/^Okay, no more order updates here/);
    expect((await pool.query(`SELECT count(*)::int n FROM channel_subscriptions WHERE task_id=$1`, [t.taskId])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM channel_outbox WHERE dedupe_key='rem:test:1'`)).rows[0].n).toBe(0);
  });
});

describe("payer admitted by starting the chat", () => {
  it("a number not on the allowlist is admitted by a valid JOIN code, and only then", async () => {
    const { createTask } = await import("@/domain/tasks");
    const { createJoinCode } = await import("@/channel/join");
    const t = await createTask({ title: "Cat carrier", starterRoles: ["helper", "payer"], starterLabel: "Payer" });
    const { code } = await createJoinCode(t.taskId, t.token);
    const stranger = (o: Record<string, unknown>) => msg({ sender: "254799999001", ...o });
    expect((await signed(inbound, IN, stranger({ text: "hello" }))).json).toMatchObject({ status: "ignored" });
    expect((await signed(inbound, IN, stranger({ text: "JOIN ZZZZZZ" }))).json).toMatchObject({ status: "ignored" });
    expect((await signed(inbound, IN, stranger({ text: `JOIN ${code}` }))).status).toBe(202);
    await processInboxOnce("whatsapp");
    const sub = (await pool.query(`SELECT can_pay FROM channel_subscriptions WHERE task_id=$1`, [t.taskId])).rows;
    expect(sub).toEqual([{ can_pay: true }]);
    // From now on they can chat like anyone else
    expect((await signed(inbound, IN, stranger({ text: "STOP" }))).status).toBe(202);
  });
});

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
vi.mock("@/adapters", async () => ({
  getInterpreter: () => ({ interpret }),
  getPayments: () => ({}),
  getDiscovery: () => ({ search: async () => [] }),
}));
vi.mock("@/catalog/demo", async () => ({
  seedDemoOffers: async (taskId: string) => {
    const { recordOffers } = await import("@/domain/tasks");
    await recordOffers(taskId, [{ source: "demo", sourceOfferId: "TOP-1", route: "paypal", seller: "Demo", merchantId: "M1", sku: "TOP-1", title: "Carrier", unitPriceMinor: 3599, shippingMinor: 800, currency: "USD", availability: "InStock" }]);
  },
  seedExternalOffers: async () => {},
}));

import { POST as inbound } from "@/app/api/channel/[channel]/inbound/route";
import { POST as claim } from "@/app/api/channel/[channel]/outbox/claim/route";
import { POST as ack } from "@/app/api/channel/[channel]/outbox/[id]/ack/route";
import { POST as health } from "@/app/api/channel/[channel]/health/route";
import { GET as status } from "@/app/api/channel/[channel]/status/route";
import { sign } from "@/channel/bridge";
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
const IMG = { mime: "image/png", base64: Buffer.from("not-really-a-png").toString("base64") };
const IN = "/api/channel/whatsapp/inbound";

beforeEach(async () => {
  interpret.mockReset().mockResolvedValue({ observations: [], proposedRequirements: [{ key: "opening", op: "eq", value: "top", essential: true, quote: "x" }], clarification: null, reply: "Got it, a cat carrier." });
  await pool.query("TRUNCATE channel_outbox, channel_inbox, channel_identities, channel_status");
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

  it("validates the payload", async () => {
    for (const bad of [{ sender: "abc" }, { providerMessageId: "bad id!" }, { image: { mime: "image/gif", base64: "AAAA" } }, { image: { mime: "image/png", base64: "***" } }, { text: "", image: undefined }, { receivedAt: "nope" }]) {
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
    expect(view.viewer.roles).toEqual(["helper", "payer"]);
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
    expect((await signed(inbound, "/api/channel/fax/inbound", msg())).status).toBe(404);
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

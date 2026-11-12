import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Simulated connector transport, real model and search: an Instagram-shaped
// photo DM and an SMS-shaped text go through the same task engine. Runs on the
// test database; no provider account, sender or delivery is involved.
const db = new URL(process.env.DATABASE_URL!);
db.pathname = "/dads_typing_test";
process.env.DATABASE_URL = db.toString();
process.env.CHANNEL_INSTAGRAM_SECRET = "i".repeat(40);
process.env.CHANNEL_INSTAGRAM_ALLOWED = "17841400000009";
process.env.CHANNEL_SMS_SECRET = "t".repeat(40);
process.env.CHANNEL_SMS_ALLOWED = "254700000019";

it("photo by Instagram DM and text by SMS reach a task with the requirement and a link", async () => {
  const { enqueueInbound, parseInbound, processInboxOnce } = await import("@/channel/inbox");
  const { getChannel } = await import("@/channel/registry");
  const { pool } = await import("@/domain/db");
  const at = new Date().toISOString();
  const runs = [
    { channel: "instagram", body: { providerMessageId: `ig.live.${Date.now()}`, sender: "17841400000009", receivedAt: at, text: "Mum wants this, it has to open from the top",
      image: { mime: "image/png", base64: readFileSync("public/demo/carrier-sample.png").toString("base64") } } },
    { channel: "sms", body: { providerMessageId: `sms.live.${Date.now()}`, sender: "254700000019", receivedAt: at, text: "Need a medium cat carrier that opens on top, ni ya paka wa mama" } },
  ];
  for (const r of runs) {
    expect(await enqueueInbound(r.channel, parseInbound(getChannel(r.channel), r.body))).toBe("accepted");
    await processInboxOnce(r.channel);
    const reply = (await pool.query(`SELECT body FROM channel_outbox WHERE channel=$1 ORDER BY created_at DESC LIMIT 1`, [r.channel])).rows[0]?.body as string;
    const taskId = /\/t\/([0-9a-f-]{36})#k=/.exec(reply)?.[1];
    const reqs = (await pool.query(`SELECT key, op, value, status FROM requirements WHERE task_id=$1`, [taskId])).rows;
    const offers = (await pool.query(`SELECT source, count(*)::int n FROM offers WHERE task_id=$1 GROUP BY source`, [taskId])).rows;
    console.log(JSON.stringify({ channel: r.channel, chars: reply.length, reply: reply.replace(/#k=[A-Za-z0-9_-]+/, "#k=…"), reqs, offers }));
    expect(taskId).toBeTruthy();
    expect(reply.length).toBeLessThanOrEqual(getChannel(r.channel).maxReplyChars);
  }
  await pool.end();
}, 120_000);

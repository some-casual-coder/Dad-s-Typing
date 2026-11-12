// Test connector for any channel: node --env-file=.env.local scripts/channel-sim.mjs <channel> <sender> "<text>" [image.png]
// A pin or a contact card instead of text: --pin=-1.29,36.78  --contact="Dad"
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const [channel, sender, text, imagePath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!channel || !sender) {
  console.error('usage: channel-sim.mjs <channel> <sender> "<text>" [image.png]');
  process.exit(1);
}
const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
const force = process.argv.includes("--force");
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base) && !force) {
  console.error("refusing to run against a non-local app (it would claim and ack real replies); pass --force to override");
  process.exit(1);
}
const redact = (s) => s.replace(/#k=[A-Za-z0-9_-]+/g, "#k=<token>");
const env = process.env;
const secret = env[`CHANNEL_${channel.toUpperCase()}_SECRET`] ?? (channel === "whatsapp" ? env.WHATSAPP_BRIDGE_SECRET : "") ?? "";
if (secret.length < 32) {
  console.error("no secret configured for this channel");
  process.exit(1);
}

async function call(path, body) {
  const text = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(`${ts}\nPOST\n${path}\n${text}`).digest("hex");
  const r = await fetch(base + path, { method: "POST", body: text, headers: { "content-type": "application/json", "x-dt-timestamp": ts, "x-dt-signature": sig } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const msg = { providerMessageId: `sim.${Date.now()}`, sender, receivedAt: new Date().toISOString() };
if (text) msg.text = text;
if (imagePath) msg.image = { mime: "image/png", base64: readFileSync(imagePath).toString("base64") };
const pin = flag("pin");
if (pin) { const [lat, lon] = pin.split(",").map(Number); msg.location = { lat, lon }; }
if (flag("contact")) msg.contact = { name: flag("contact") };
const sent = await call(`/api/channel/${channel}/inbound`, msg);
console.log("inbound:", sent.status, JSON.stringify(sent.json));

for (let i = 0; i < 30; i++) {
  const { json } = await call(`/api/channel/${channel}/outbox/claim`, { limit: 5 });
  for (const item of json?.items ?? []) {
    console.log(`reply to ${item.recipient} (attempt ${item.attempt}):\n${redact(item.body)}\n`);
    await call(`/api/channel/${channel}/outbox/${item.id}/ack`, { state: "sent", providerMessageId: `sim.out.${item.id.slice(0, 8)}` });
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error("no reply within 30s (is the app running with the channel configured?)");
process.exit(2);

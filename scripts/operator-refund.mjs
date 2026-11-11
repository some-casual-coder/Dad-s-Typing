// Operator refund against a LOCAL app:
//   node --env-file=.env.local scripts/operator-refund.mjs --operator <label> --capture <id> (--amount <minor> | --full) [--key <k>] [--reason <t>] [--force]
// Re-run with the same --key to resume the same operation; never mints a new one.
import { createHmac, randomUUID } from "node:crypto";

const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
const secret = process.env.OPERATOR_SECRET ?? "";
const fail = (m) => { console.error(m); process.exit(1); };

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base) && !a.includes("--force")) fail("refusing a non-local app; pass --force to override");
if (secret.length < 32) fail("OPERATOR_SECRET is not set (>= 32 chars)");
const operator = opt("operator"), captureId = opt("capture");
if (!operator || !captureId || (!a.includes("--full") && !opt("amount"))) fail("usage: --operator <label> --capture <id> (--amount <minor> | --full) [--key <k>] [--reason <t>]");

const body = { operator, captureId, operationKey: opt("key") ?? randomUUID() };
if (a.includes("--full")) body.full = true; else body.amountMinor = Number(opt("amount"));
if (opt("reason")) body.reason = opt("reason");
const text = JSON.stringify(body);
const path = "/api/operator/refund";
const ts = String(Math.floor(Date.now() / 1000));
const sig = createHmac("sha256", secret).update(`${ts}\nPOST\n${path}\n${text}`).digest("hex");
const r = await fetch(base + path, { method: "POST", body: text, headers: { "content-type": "application/json", "x-dt-timestamp": ts, "x-dt-signature": sig } });
console.log("status:", r.status, "key:", body.operationKey);
console.log(JSON.stringify(await r.json().catch(() => null)));

import { createHmac, timingSafeEqual } from "node:crypto";
import { channelIds, channelSecret, isConfigured } from "@/channel/registry";
import { pool } from "./db";
import { DomainError } from "./errors";

// Operator console access: the operator secret unlocks a short signed cookie.
// Off in production unless explicitly enabled, like the refund command.
export const OP_COOKIE = "dt_op";
const TTL_MS = 8 * 3600_000;

function secret(): string {
  const s = process.env.OPERATOR_SECRET ?? "";
  if (s.length < 32) throw new DomainError("forbidden", "Not allowed");
  if (process.env.NODE_ENV === "production" && process.env.OPERATOR_ENABLED !== "1") throw new DomainError("forbidden", "Not allowed");
  if (channelIds().some((id) => isConfigured(id) && channelSecret(id) === s)) throw new DomainError("forbidden", "Not allowed");
  return s;
}

const sign = (exp: number) => createHmac("sha256", secret()).update(`operator-console:${exp}`).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function login(given: string, now = Date.now()) {
  if (typeof given !== "string" || !same(given, secret())) throw new DomainError("forbidden", "Not allowed");
  const exp = now + TTL_MS;
  return { value: `${exp}.${sign(exp)}`, maxAge: TTL_MS / 1000 };
}

// Cookie plus a custom header: a cross-site form cannot set the header
export function requireOperator(req: Request, now = Date.now()) {
  const raw = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${OP_COOKIE}=`))?.slice(OP_COOKIE.length + 1) ?? "";
  const [exp, mac] = raw.split(".");
  if (req.headers.get("x-dt-operator") !== "1" || !exp || !mac || Number(exp) < now || !same(mac, sign(Number(exp))))
    throw new DomainError("forbidden", "Not allowed");
}

// Paid import orders with what an operator needs; no addresses are stored
export async function listOrders() {
  const r = await pool.query(
    `SELECT o.id, o.task_id, o.title, o.total_minor, o.currency, co.provider, co.mode, co.cap_minor, co.actual_minor, co.extra_due_minor,
            co.extra_decision, co.provider_paid_at, co.settled_at, o.created_at,
            (SELECT status FROM fulfilment_events e WHERE e.seller_order_id=o.id ORDER BY occurred_at DESC LIMIT 1) AS last_status,
            (SELECT url FROM offers f WHERE f.id=co.offer_id) AS url
       FROM seller_orders o JOIN concierge_orders co ON co.seller_order_id=o.id
      WHERE o.status='paid' ORDER BY o.created_at DESC LIMIT 100`);
  return r.rows.map((x) => ({
    id: x.id as string, taskId: x.task_id as string, title: x.title as string, provider: x.provider as string, mode: x.mode as string,
    currency: x.currency as string, capMinor: x.cap_minor as number, actualMinor: x.actual_minor as number | null,
    extraDueMinor: x.extra_due_minor as number | null, extraDecision: x.extra_decision as string | null,
    providerPaid: !!x.provider_paid_at, settled: !!x.settled_at, lastStatus: x.last_status as string | null, url: x.url as string | null,
  }));
}

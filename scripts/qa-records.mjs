// QA evidence for one task, redacted: node --env-file=.env.local scripts/qa-records.mjs <taskId>
// No tokens, capture IDs, payer details or message text are printed.
import pg from "pg";
const T = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(T ?? "")) { console.error("usage: qa-records.mjs <taskId>"); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s, a = [T]) => (await c.query(s, a)).rows;
const out = {
  task: (await q(`SELECT version, search_query IS NOT NULL AS identified, cancelled_at IS NOT NULL AS cancelled FROM tasks WHERE id=$1`))[0],
  grants: (await q(`SELECT roles, label, revoked_at IS NOT NULL AS revoked FROM grants WHERE task_id=$1 ORDER BY created_at`)),
  requirements: (await q(`SELECT key, op, value, essential, status FROM requirements WHERE task_id=$1 AND superseded_at IS NULL`)),
  selections: (await q(`SELECT offer_snapshot->>'sku' AS sku, offer_snapshot->>'title' AS title, superseded_at IS NOT NULL AS superseded FROM selections WHERE task_id=$1 ORDER BY created_at`)),
  orders: (await q(`SELECT kind, status, currency, item_minor, shipping_minor, total_minor, sku, merchant_id = $2 AS merchant_matches FROM seller_orders WHERE task_id=$1`, [T, process.env.PAYPAL_MERCHANT_ID])),
  attempts: (await q(`SELECT a.status, a.capture_id IS NOT NULL AS captured, (SELECT string_agg(kind||':'||status, ',' ORDER BY kind) FROM payment_operations p WHERE p.attempt_id=a.id) AS operations
    FROM payment_attempts a JOIN seller_orders o ON o.id=a.seller_order_id WHERE o.task_id=$1 ORDER BY a.created_at`)),
  refunds: (await q(`SELECT r.status, r.amount_minor, r.currency FROM refunds r JOIN seller_orders o ON o.id=r.seller_order_id WHERE o.task_id=$1 ORDER BY r.created_at`)),
  exceptions: (await q(`SELECT kind FROM payment_exceptions WHERE task_id=$1`)).map((r) => r.kind),
  messages: (await q(`SELECT count(*)::int AS n FROM messages WHERE task_id=$1`))[0]?.n,
  events: (await q(`SELECT type FROM task_events WHERE task_id=$1 ORDER BY created_at`)).map((r) => r.type),
};
console.log(JSON.stringify(out, null, 1));
await c.end();

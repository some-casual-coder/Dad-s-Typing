// QA fixture for S06: raise the chosen demo offer's price on one local task.
// node --env-file=.env.local scripts/qa-quote-change.mjs <taskId> <sku> <newItemMinor>
import pg from "pg";
const [T, sku, minor] = process.argv.slice(2);
if (process.env.NODE_ENV === "production" || !/^[0-9a-f-]{36}$/.test(T ?? "") || !/^\d+$/.test(minor ?? "")) { console.error("usage: qa-quote-change.mjs <taskId> <sku> <newItemMinor> (local only)"); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(`UPDATE offers SET unit_price_minor=$3 WHERE task_id=$1 AND sku=$2 RETURNING unit_price_minor, shipping_minor`, [T, sku, Number(minor)]);
console.log(JSON.stringify(r.rows));
await c.end();

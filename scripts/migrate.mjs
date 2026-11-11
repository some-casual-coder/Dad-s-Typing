import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";

export async function migrate(connectionString) {
  const dir = new URL("../db/migrations/", import.meta.url);
  const c = new pg.Client({ connectionString });
  await c.connect();
  await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await c.query("BEGIN");
    try {
      await c.query(readFileSync(new URL(f, dir), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      console.log("applied", f);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
  await c.end();
}

if (import.meta.url === `file://${process.argv[1]}`) await migrate(process.env.DATABASE_URL);

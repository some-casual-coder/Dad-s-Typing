import pg from "pg";
import { migrate } from "../scripts/migrate.mjs";

export default async function setup() {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = "/dads_typing_test";
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrate(url.toString());
}

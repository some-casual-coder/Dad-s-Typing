import { pool } from "@/domain/db";
import { handle, json } from "../_lib/http";

export const GET = handle(async () => {
  await pool.query("SELECT 1");
  return json({ ok: true, db: true });
});

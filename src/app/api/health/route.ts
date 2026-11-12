import { connection } from "next/server";
import { pool } from "@/domain/db";
import { handle, json } from "../_lib/http";

// Checked at request time, never baked in at build
export const GET = handle(async () => {
  await connection();
  await pool.query("SELECT 1");
  return json({ ok: true, db: true });
});

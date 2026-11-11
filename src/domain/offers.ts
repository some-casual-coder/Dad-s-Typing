import { pool } from "./db";

export async function hasExternalOffers(taskId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM offers WHERE task_id=$1 AND route='external' LIMIT 1`, [taskId]);
  return r.rowCount! > 0;
}

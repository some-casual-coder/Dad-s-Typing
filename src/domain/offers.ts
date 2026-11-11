import { pool } from "./db";

// True for exactly one caller per task, whatever the search returns
export async function claimExternalSearch(taskId: string): Promise<boolean> {
  const r = await pool.query(`UPDATE tasks SET external_searched_at=now() WHERE id=$1 AND external_searched_at IS NULL RETURNING id`, [taskId]);
  return r.rowCount! > 0;
}

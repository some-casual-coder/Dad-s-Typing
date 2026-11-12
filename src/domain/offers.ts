import { pool } from "./db";

// True for exactly one caller per task, whatever the search returns
export async function claimExternalSearch(taskId: string, query?: string): Promise<boolean> {
  const r = await pool.query(`UPDATE tasks SET external_searched_at=now(), search_query=$2 WHERE id=$1 AND external_searched_at IS NULL RETURNING id`,
    [taskId, query ? query.slice(0, 300) : null]);
  return r.rowCount! > 0;
}

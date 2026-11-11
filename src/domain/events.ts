import type { Tx } from "./db";

export async function logEvent(c: Tx, taskId: string, grantId: string | null, type: string, payload: object = {}) {
  await c.query(`INSERT INTO task_events (task_id, grant_id, type, payload) VALUES ($1,$2,$3,$4)`, [
    taskId, grantId, type, JSON.stringify(payload),
  ]);
}

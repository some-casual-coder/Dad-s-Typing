import { createHash } from "node:crypto";
import { DomainError } from "./errors";
import type { Tx } from "./db";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// The key insert makes concurrent duplicates wait for the first to commit
export async function idempotent<T>(
  c: Tx, scope: string, key: string, command: string, params: unknown, run: () => Promise<T>,
): Promise<T> {
  const h = hash({ command, params });
  const ins = await c.query(
    `INSERT INTO idempotency (scope, key, command, request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [scope, key, command, h],
  );
  if (ins.rowCount === 0) {
    const { rows } = await c.query(`SELECT request_hash, result FROM idempotency WHERE scope=$1 AND key=$2`, [scope, key]);
    if (rows[0].request_hash !== h) throw new DomainError("idempotency_mismatch", "Idempotency key reused with different parameters");
    return rows[0].result as T;
  }
  const result = await run();
  await c.query(`UPDATE idempotency SET result=$3 WHERE scope=$1 AND key=$2`, [scope, key, JSON.stringify(result ?? null)]);
  return result;
}

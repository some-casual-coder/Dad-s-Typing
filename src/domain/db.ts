import pg from "pg";

// bigint counts stay far below 2^53
pg.types.setTypeParser(20, (v) => Number(v));

const g = globalThis as unknown as { __dtPool?: pg.Pool };
export const pool = (g.__dtPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 }));

export type Tx = pg.PoolClient;

// Keep short: never await a model, buyer or provider inside
export async function tx<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

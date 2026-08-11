import pg from "pg";
import { config, sslFor } from "./config.js";

// Never let the driver guess: numerics and bigints as numbers where we know the
// range, timestamps as ISO strings so JSON output is stable across timezones.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: `rescue-${config.role}`,
  // Extension objects (geography, vector, gin_trgm_ops) are never qualified in
  // our SQL, because their schema differs per provider. Sent as a startup
  // parameter rather than a `SET` so it survives a transaction-mode pooler,
  // where a session-level SET would be discarded between statements.
  options: `-c search_path=${config.db.searchPath}`,
  ssl: sslFor(config.db.url),
});

pool.on("error", (err) => {
  // A pooler can drop idle connections at any time; that is not fatal.
  console.error(JSON.stringify({ level: "warn", msg: "idle client error", err: err.message }));
});

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T extends Row = Row>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

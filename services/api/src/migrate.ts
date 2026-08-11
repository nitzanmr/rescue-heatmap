// Migration runner. Deliberately boring and vendor-neutral: numbered SQL files,
// applied in order, recorded with their checksum, one advisory lock so that two
// container instances starting at once cannot both migrate.
//
// Why not the provider's CLI: ADR-003 says the schema must not depend on
// Supabase. These same files must apply to Cloud SQL, to a UNGRD server and to
// docker compose. A migration runner is 120 lines; a lock-in is forever.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { config, sslFor } from "./config.js";

const LOCK_ID = 8_140_2026; // arbitrary but stable

function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  // dist/migrate.js -> services/api/dist -> repo/db/migrations
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../db/migrations");
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function runMigrations(opts: { dir?: string; url?: string } = {}) {
  const dir = opts.dir ?? migrationsDir();
  // Migrations use the DIRECT connection, never the pooler: DDL in a transaction
  // pooler is a reliable way to lose an afternoon.
  const url = opts.url ?? config.db.directUrl;
  if (!url) throw new Error("DATABASE_DIRECT_URL / DATABASE_URL is required to migrate");

  const client = new pg.Client({
    connectionString: url,
    application_name: "rescue-migrate",
    ssl: sslFor(url),
  });
  await client.connect();

  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ level: "info", msg, ...extra }));

  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        ms         int
      )`);

    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, "en"));
    if (!files.length) throw new Error(`no .sql files in ${dir}`);

    const applied = new Map<string, string>();
    for (const r of (await client.query(`SELECT version, checksum FROM schema_migration`)).rows) {
      applied.set(r.version, r.checksum);
    }

    let ran = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const sql = await fs.readFile(path.join(dir, file), "utf8");
      const sum = sha256(sql);
      const prev = applied.get(version);

      if (prev) {
        if (prev !== sum) {
          // Our migrations are written idempotent, so re-editing one is tempting
          // and wrong: the drill environment would silently diverge from prod.
          throw new Error(
            `migration ${version} changed after it was applied ` +
              `(recorded ${prev.slice(0, 12)}, file ${sum.slice(0, 12)}). ` +
              `Add a new numbered file instead of editing this one.`
          );
        }
        continue;
      }

      const t0 = Date.now();
      try {
        // Each file is one transaction: a half-applied migration is the worst
        // state to discover at 3 a.m.
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migration (version, checksum, ms) VALUES ($1,$2,$3)`,
          [version, sum, Date.now() - t0]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${version} failed: ${(err as Error).message}`);
      }
      ran++;
      log("migration applied", { version, ms: Date.now() - t0 });
    }

    // Extensions land in schema `extensions`; make them resolvable without a
    // qualified name for interactive use. Best-effort: managed providers differ.
    await client
      .query(`ALTER DATABASE ${client.database ? `"${client.database}"` : "CURRENT"} SET search_path = public, extensions`)
      .catch(() => {});

    log("migrations complete", { applied: ran, total: files.length });
    return { applied: ran, total: files.length };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]).catch(() => {});
    await client.end().catch(() => {});
  }
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runMigrations().catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: err.message }));
    process.exit(1);
  });
}

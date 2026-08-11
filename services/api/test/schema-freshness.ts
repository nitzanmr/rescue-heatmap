// Is the database we are measuring the database this checkout describes?
//
// This exists because of a run that wasted a cycle: the drill died during the
// web build, so 0008-0010 were never applied, and `make test` / `make ablation`
// then ran against the previous schema. What came back was three failures
// reading `column correlation_config.lead_floor does not exist` — a message that
// says "your query is wrong" when the truth was "your database is old". Two very
// different bugs, and the second one wearing the costume of the first is how an
// afternoon disappears.
//
// So: before any measurement touches the engine, compare the migration files on
// disk to schema_migration. If the database is behind, say so in one line, with
// the command that fixes it, and do not report a single precision or recall
// number — a number measured against the wrong schema is worse than no number,
// because it gets quoted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../src/db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function migrationsOnDisk(): string[] {
  return fs
    .readdirSync(path.join(root, "db/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort((a, b) => a.localeCompare(b, "en"));
}

let checked: Promise<SchemaState> | null = null;

/**
 * Fails the calling test with one readable line if the live database is older
 * than db/migrations. Checked once per process: every DB-backed test calls it,
 * and none of them should pay for the round trip twice.
 */
export async function requireFreshSchema(): Promise<void> {
  checked ??= schemaState();
  const state = await checked;
  if (!state.fresh) throw new Error(`STALE DATABASE — ${state.message}`);
}

export interface SchemaState {
  fresh: boolean;
  missing: string[];
  message: string;
}

export async function schemaState(): Promise<SchemaState> {
  const onDisk = migrationsOnDisk();
  let appliedRows: { version: string }[];
  try {
    appliedRows = await query<{ version: string }>(`SELECT version FROM schema_migration`);
  } catch {
    return {
      fresh: false,
      missing: onDisk,
      message:
        "this database has never been migrated (no schema_migration table). " +
        "Run: make drill   (or at minimum: docker compose run --rm migrate)",
    };
  }
  const applied = new Set(appliedRows.map((r) => r.version));
  const missing = onDisk.filter((v) => !applied.has(v));
  if (!missing.length) return { fresh: true, missing: [], message: "" };
  return {
    fresh: false,
    missing,
    message:
      `the live database is BEHIND this checkout by ${missing.length} migration(s): ` +
      `${missing.join(", ")}. Nothing was measured, because a number taken from the ` +
      `wrong schema is not a number. Run: make drill`,
  };
}

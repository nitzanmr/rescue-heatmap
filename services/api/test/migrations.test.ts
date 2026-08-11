// The drill failed on 0001 because the migration named the schema an extension
// lives in ("extensions.geography"), while the postgis image had already created
// the extension in "public". postgis is relocatable = false, so the schema is
// the provider's decision and never ours. These cases pin that rule.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations"
);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));

const statementsOf = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

test("there are migrations to check", () => {
  assert.ok(files.length >= 6, `expected the schema files, found ${files.length}`);
});

for (const file of files) {
  const sql = fs.readFileSync(path.join(dir, file), "utf8");

  test(`${file} never qualifies an extension object by schema`, () => {
    // Comments explain the rule; only statements are checked.
    const code = statementsOf(sql);
    const offenders = [...code.matchAll(/\bextensions\.[a-z_]+/gi)].map((m) => m[0]);
    assert.deepEqual(offenders, [], `schema-qualified extension objects: ${offenders.join(", ")}`);
  });
}

test("0001 puts the extensions schema on the search_path before using it", () => {
  const sql = statementsOf(fs.readFileSync(path.join(dir, "0001_init.sql"), "utf8"));
  const createSchema = sql.indexOf("CREATE SCHEMA IF NOT EXISTS extensions");
  const setPath = sql.indexOf("SET LOCAL search_path");
  const firstExtension = sql.indexOf("CREATE EXTENSION");
  assert.ok(createSchema >= 0, "extensions schema must be created");
  assert.ok(setPath > createSchema, "search_path must be set after the schema exists");
  assert.ok(setPath < firstExtension, "search_path must be set before extensions are used");
});

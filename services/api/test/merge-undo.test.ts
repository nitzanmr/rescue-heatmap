// A merge must be reversible, and "reversible" is a property of the RECORD, not
// of good intentions. These are static checks on the merge/undo pair, because
// the failure they guard against is silent: an undo that restores the reports
// and forgets the private token leaves a family reading a stranger's case, and
// nothing in the system reports an error.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const panel = fs.readFileSync(path.join(ROOT, "services/api/src/routes/panel.ts"), "utf8");
const migrations = fs
  .readdirSync(path.join(ROOT, "db/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => fs.readFileSync(path.join(ROOT, "db/migrations", f), "utf8"))
  .join("\n");

// Comments are allowed to name what the code must not do.
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const decide = (() => {
  const s = code(panel);
  const start = s.indexOf('"/v1/panel/dedup/:id/decide"');
  return s.slice(start, s.indexOf('"/v1/panel/merges"', start));
})();

const undo = (() => {
  const s = code(panel);
  const start = s.indexOf('"/v1/panel/merges/:id/undo"');
  return s.slice(start, s.indexOf('"/v1/panel/cases/:id/status"', start));
})();

test("every table the merge moves is recorded in the ledger", () => {
  for (const [table, column] of [
    ["report", "moved_reports"],
    ["sighting", "moved_sightings"],
    ["media", "moved_media"],
    ["reporter_token", "moved_tokens"],
  ] as const) {
    assert.match(
      decide,
      new RegExp(`UPDATE ${table}[\\s\\S]{0,120}RETURNING`),
      `the merge moves ${table} rows without returning their ids; the undo cannot find them again`
    );
    assert.ok(
      decide.includes(column),
      `${column} must be written by the merge — an unrecorded move is an irreversible one`
    );
  }
});

test("the merge records what public_listed was before it hid the case", () => {
  assert.match(
    decide,
    /merged_public_listed/,
    "merging sets public_listed = false; without the previous value an undo restores an invisible person"
  );
});

test("the undo restores every recorded move, not just the reports", () => {
  assert.match(undo, /UPDATE report\s+SET case_id/, "reports must go back");
  assert.match(undo, /UPDATE sighting SET case_id/, "sightings must go back");
  assert.match(undo, /UPDATE media\s+SET case_id/, "media must go back");
  assert.match(
    undo,
    /UPDATE reporter_token SET case_id[\s\S]{0,120}token_hash = ANY/,
    "the family's private link must go back to their own case"
  );
  assert.match(
    undo,
    /public_listed = \$2/,
    "public visibility must be restored to what it was, not left off"
  );
});

test("an undo cannot be applied twice", () => {
  // case_merge is append-only for the app role (0005), so the undo is a new row
  // pointing at the merge it reverses. The old guard read undone_at on the merge
  // itself, which nothing ever set.
  assert.match(
    undo,
    /NOT EXISTS \(SELECT 1 FROM case_merge u WHERE u\.undoes_merge_id = m\.id\)/,
    "the undo must check for an existing undo row"
  );
  assert.equal(
    /WHERE id = \$1 AND undone_at IS NULL/.test(undo),
    false,
    "undone_at on the merge row is never set; that guard always passes"
  );
  assert.match(
    migrations,
    /CREATE UNIQUE INDEX IF NOT EXISTS case_merge_undo_uq[\s\S]{0,120}undoes_merge_id/,
    "two operators pressing undo at once must be stopped by the schema, not by a race"
  );
});

test("undoing a merge returns the pair to the queue instead of burying it", () => {
  assert.match(
    undo,
    /UPDATE dedup_candidate SET state='pending'/,
    "'I was wrong' is not 'these are different people'; only an explicit reject means that"
  );
});

test("the ledger view hides undo rows and flags partially recorded merges", () => {
  assert.match(migrations, /CREATE OR REPLACE VIEW public\.case_merge_ledger/);
  assert.match(migrations, /\(u\.id IS NOT NULL\)\s+AS undone/);
  assert.match(
    migrations,
    /fully_recorded/,
    "merges made before 0009 can only be partially reversed and the panel must be able to say so"
  );
});

test("the panel offers the undo it promises", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/web/src/app/panel/page.tsx"), "utf8");
  assert.match(page, /api\.undoMerge/, "the panel tells the operator a merge is reversible");
  assert.match(page, /Deshacer/);
  const web = fs.readFileSync(path.join(ROOT, "app/web/src/lib/api.ts"), "utf8");
  assert.match(web, /v1\/panel\/merges\/\$\{mergeId\}\/undo/);
});

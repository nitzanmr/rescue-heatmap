// 0019 closes two holes found by reviewing 0018 against the only thing it
// exists to guarantee: that a collapsed building's head-count is never wrong in
// the direction of "fewer people inside".
//
//   1. A merge — the exact action the operator queue was built for — dropped a
//      person out of the building's count, because the structure link stayed on
//      the swallowed case and every reader filtered merged rows away.
//   2. "clear" could be signed truthfully and then silently stop being true,
//      when a person was attached to the structure after the signature.
//
// Static checks, same discipline as the rest: these failures are not crashes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const migration = read("db/migrations/0019_structure_merge_safe.sql");
const prev = read("db/migrations/0018_structure_entity.sql");
const routes = read("services/api/src/routes/structures.ts");
const panel = read("services/api/src/routes/panel.ts");

// Statements only: this file argues for its rules in comments, and a comment
// naming a table must neither satisfy nor break a check about code.
const code = migration
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const between = (from: string, to?: string) => {
  const a = code.indexOf(from);
  assert.ok(a >= 0, `missing: ${from}`);
  const b = to ? code.indexOf(to, a) : -1;
  return code.slice(a, b > a ? b : undefined);
};

// ---------------------------------------------------------------------------
// Append-only. 0018 is pushed; its checksum is recorded wherever it ran.
// ---------------------------------------------------------------------------

test("0019: nothing already applied is edited", () => {
  // Every database object this migration touches already exists in 0018, so it
  // may only be replaced — never dropped and recreated, which would take the
  // dependent views down with it.
  const creates = code.match(/^CREATE (?:OR REPLACE )?(?:FUNCTION|VIEW)/gm) ?? [];
  assert.ok(creates.length > 0);
  for (const c of creates) assert.match(c, /CREATE OR REPLACE/);
  assert.doesNotMatch(code, /DROP (VIEW|FUNCTION|TABLE|COLUMN)/);
  // Triggers are the exception: they cannot be replaced in place, and dropping
  // one by name is local and idempotent.
  assert.match(code, /DROP TRIGGER IF EXISTS/);
});

// ---------------------------------------------------------------------------
// Hole 1 — a merge must not empty the board
// ---------------------------------------------------------------------------

test("0019: a merge does not quietly reduce a building's head-count", () => {
  assert.match(code, /CREATE OR REPLACE FUNCTION public\.effective_case/);
  const fn = between("CREATE OR REPLACE FUNCTION public.effective_case",
    "COMMENT ON FUNCTION public.effective_case");
  assert.match(fn, /merged_into/);
  assert.match(fn, /i >= 10/, "the merge-chain walk must be bounded");

  const view = between("CREATE OR REPLACE VIEW public.structure_person",
    "COMMENT ON VIEW public.structure_person");
  assert.match(view, /public\.effective_case\(sc\.case_id\)/);
  // Open only if EVERY link for that human is open: an operator who signed
  // "recovered alive" against one of two merged records said it about the
  // person, not about a row.
  assert.match(view, /bool_and\(sc\.resolution = 'unresolved'\) AS is_open/);
});

test("0019: nothing is moved at merge time, so undo stays ignorant of structures", () => {
  // The alternative — re-pointing structure_case rows when a merge happens —
  // would have to be reversed by the undo ledger (0009), and an undo that
  // forgets one table is how a building silently loses a person.
  assert.doesNotMatch(code, /UPDATE structure_case[\s\S]{0,200}structure_id\s*=/);
  assert.doesNotMatch(panel, /structure_case/,
    "merge and undo must not know structures exist");
});

test("0019: every reader that counts or lists people goes through structure_person", () => {
  for (const name of [
    "CREATE OR REPLACE FUNCTION public.structure_no_silent_clear",
    "CREATE OR REPLACE FUNCTION public.structure_blockers",
    "CREATE OR REPLACE VIEW public.structure_board",
    "CREATE OR REPLACE FUNCTION public.project_structure_point",
  ]) {
    const body = between(name);
    const end = body.indexOf("\n$$;");
    const fn = end > 0 ? body.slice(0, end) : body.slice(0, body.indexOf("COMMENT ON"));
    assert.doesNotMatch(fn, /FROM structure_case/, `${name} must read structure_person`);
    assert.match(fn, /structure_person/, `${name} must read structure_person`);
  }
});

test("0019: an erased person cannot block a building forever", () => {
  // Ley 1581/2012 erasure blanks the record but keeps the row. Counting it as
  // an open person would make the structure impossible to sign, ever.
  const guard = between("CREATE OR REPLACE FUNCTION public.structure_no_silent_clear",
    "DROP TRIGGER");
  assert.match(guard, /pc\.anonymised_at IS NULL/);
  const blockers = between("CREATE OR REPLACE FUNCTION public.structure_blockers");
  assert.match(blockers, /pc\.anonymised_at IS NULL/);
});

// ---------------------------------------------------------------------------
// Hole 2 — a clear that stops being true
// ---------------------------------------------------------------------------

test("0019: a signed-clear structure reopens when a new unresolved person arrives", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.structure_reopen_on_open_person",
    "DROP TRIGGER IF EXISTS structure_case_reopen");
  assert.match(fn, /scan_state = 'partial'/);
  assert.match(fn, /scan_state = 'clear'/);
  assert.match(fn, /INSERT INTO structure_event/, "the reopen must say why in the log");
  // It reopens; it does not refuse the link. Refusing new information about a
  // collapsed building would be absurd.
  assert.doesNotMatch(fn, /RAISE EXCEPTION/);
  assert.match(code, /CREATE TRIGGER structure_case_reopen\s+AFTER INSERT OR UPDATE ON structure_case/);
});

test("0019: reopening keeps the original signature instead of erasing it", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.structure_reopen_on_open_person",
    "DROP TRIGGER IF EXISTS structure_case_reopen");
  assert.doesNotMatch(fn, /scan_signed_by\s*=\s*NULL/);
  assert.doesNotMatch(fn, /scan_signed_at\s*=\s*NULL/);
});

// ---------------------------------------------------------------------------
// The projection bug 0018 shipped with
// ---------------------------------------------------------------------------

test("0019: project_structure_point references only aliases it declares", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.project_structure_point");
  const body = fn.slice(0, fn.indexOf("\n$$;"));
  // 0018 renamed the loop's source to sp and left `o.case_id = sc.case_id`
  // behind: the function raised "missing FROM-clause entry for table sc" on
  // its first call, and no static check could see it.
  assert.doesNotMatch(body, /\bsc\./, "sc is not in scope in this function");
  assert.match(body, /WHERE o\.case_id = sp\.case_id/);
  assert.match(prev, /WHERE o\.case_id = sc\.case_id/,
    "this test exists because 0018 shipped that alias; if it is gone, drop this line");
});

test("0019: the projection still refuses coarse points and never overwrites", () => {
  // The guards of 0018 must survive being rewritten. Losing one here is how a
  // town centroid becomes a hotspot where nobody is buried.
  const fn = between("CREATE OR REPLACE FUNCTION public.project_structure_point");
  assert.match(fn, /point_precision NOT IN \('building','street'\)/);
  assert.match(fn, /WHEN 'building' THEN 'building' ELSE 'block'/);
  assert.match(fn, /pi\.last_seen IS NULL/);
  assert.match(fn, /ON CONFLICT \(case_id\) DO NOTHING/);
  assert.match(fn, /refresh_person_index/);
  assert.match(fn, /INSERT INTO structure_event/);
  assert.doesNotMatch(fn, /'exact'/);
});

// ---------------------------------------------------------------------------
// Still not a dedup engine
// ---------------------------------------------------------------------------

test("0019: reading a merge is not performing one", () => {
  assert.doesNotMatch(code, /merged_into\s*=\s*[^ ]/, "this migration must never merge");
  assert.doesNotMatch(code, /INSERT INTO case_merge/);
  assert.doesNotMatch(code, /UPDATE person_case/,
    "a structure being wrong must never write a person off");
});

// ---------------------------------------------------------------------------
// The API side
// ---------------------------------------------------------------------------

test("the panel lists and resolves people through the merge chain", () => {
  assert.match(routes, /FROM structure_person sp/,
    "the detail list must follow merges too, or a deduplicated person vanishes");
  const handler = routes.slice(routes.indexOf("/cases/:caseId/resolve"));
  // A person may reach this structure through a record that was merged away;
  // every link resolving to the same human moves together.
  assert.match(handler, /public\.effective_case\(case_id\) = public\.effective_case\(\$2\)/);
  assert.doesNotMatch(handler, /UPDATE person_case/,
    "a body recovered and a person found elsewhere are still not one click");
});

test("the detail list does not hand out erased people", () => {
  const list = routes.slice(routes.indexOf("FROM structure_person sp"));
  assert.match(list.slice(0, 400), /pc\.anonymised_at IS NULL/);
});

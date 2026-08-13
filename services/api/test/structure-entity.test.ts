// A structure is the unit a rescue team is dispatched to, and "clear" is the
// sentence that stops people digging. These are static checks, same discipline
// as reporter-confirmation.test.ts: the failure modes here are not crashes but
// guarantees quietly going missing — a coordinate with no grade, a signature
// with no name, a "clear" that nothing stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  structureInput, structurePoint, structureScan, structureResolve, structureLink,
} from "../src/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const migration = read("db/migrations/0018_structure_entity.sql");
const routes = read("services/api/src/routes/structures.ts");
const board = read("app/web/src/components/StructureBoard.tsx");
const importer = read("services/api/src/import-structures.ts");
const index = read("services/api/src/index.ts");

// Statements only: the file argues for its rules in comments, and a comment
// mentioning 'merged' must not satisfy or break a check about code.
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
// The invariant this migration exists for
// ---------------------------------------------------------------------------

test("0018: a structure cannot be signed clear while anyone inside is unresolved", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.structure_no_silent_clear", "DROP TRIGGER");
  assert.match(fn, /NEW\.scan_state = 'clear'/);
  assert.match(fn, /resolution = 'unresolved'/);
  assert.match(fn, /RAISE EXCEPTION/);
  // A merged case is represented by its survivor; counting it would block the
  // clear forever and teach operators to work around the guard.
  assert.match(fn, /pc\.merged_into IS NULL/);
  // The refusal explains itself — the screen quotes this.
  assert.match(fn, /HINT =/);
});

test("0018: the guard is a trigger on the table, not advice to the API", () => {
  assert.match(code, /CREATE TRIGGER structure_clear_guard\s+BEFORE INSERT OR UPDATE ON structure/);
  // INSERT too: a row that arrives already 'clear' must hit the same wall.
  assert.match(code, /BEFORE INSERT OR UPDATE/);
});

test("0018: blockers are queryable, so a blocked button can name them", () => {
  assert.match(code, /CREATE OR REPLACE FUNCTION public\.structure_blockers\(p_structure uuid\)/);
  const fn = between("CREATE OR REPLACE FUNCTION public.structure_blockers");
  assert.match(fn, /resolution = 'unresolved'/);
});

// ---------------------------------------------------------------------------
// Nothing invents a coordinate, nothing is signed anonymously
// ---------------------------------------------------------------------------

test("0018: a point must be graded, paired and signed", () => {
  assert.match(code, /CONSTRAINT structure_point_graded_ck CHECK \(lat IS NULL OR point_precision IS NOT NULL\)/);
  assert.match(code, /CONSTRAINT structure_point_pair_ck CHECK \(\(lat IS NULL\) = \(lng IS NULL\)\)/);
  assert.match(code, /structure_point_signed_ck[\s\S]{0,120}point_set_by IS NOT NULL/);
  // Same vocabulary as 0016. One word, one meaning, across the system.
  assert.match(code, /point_precision IN \('building','street','area','town'\)/);
  // 'exact' is not on offer: staff working from an address locate a building.
  assert.doesNotMatch(code, /point_precision IN \([^)]*'exact'/);
});

test("0018: every scan verdict other than 'not yet' carries a name and a time", () => {
  assert.match(code, /structure_scan_signed_ck CHECK \(scan_state = 'not_scanned' OR/);
  assert.match(code, /scan_signed_by IS NOT NULL AND scan_signed_at IS NOT NULL/);
});

test("0018: a resolution is signed too", () => {
  assert.match(code, /structure_case_resolution_signed_ck CHECK \(resolution = 'unresolved' OR/);
});

// ---------------------------------------------------------------------------
// project_structure_point — the field workaround, with the guards it lacked
// ---------------------------------------------------------------------------

test("0018: a coarse structure point is never projected onto people", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.project_structure_point");
  assert.match(fn, /point_precision NOT IN \('building','street'\)/);
  assert.match(fn, /RAISE EXCEPTION/);
  // The grade of the structure's point caps the claim made about each person:
  // a street pin is block-level, never building-level.
  assert.match(fn, /WHEN 'building' THEN 'building' ELSE 'block'/);
  assert.doesNotMatch(fn, /'exact'/, "an inherited point must never claim to be exact");
});

test("0018: projecting never overwrites a location somebody already gave", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.project_structure_point");
  assert.match(fn, /pi\.last_seen IS NULL/);
  assert.match(fn, /NOT EXISTS \(SELECT 1 FROM case_location_override/);
  assert.match(fn, /ON CONFLICT \(case_id\) DO NOTHING/);
  // The map only changes when the index is rebuilt — the gap found by hand
  // during the Pereira load.
  assert.match(fn, /refresh_person_index/);
  // And it leaves provenance.
  assert.match(fn, /INSERT INTO structure_event/);
});

test("0018: erased and merged people are not given locations", () => {
  const fn = between("CREATE OR REPLACE FUNCTION public.project_structure_point");
  assert.match(fn, /pc\.merged_into IS NULL/);
  assert.match(fn, /pc\.anonymised_at IS NULL/);
});

// ---------------------------------------------------------------------------
// Structures are not a second dedup engine
// ---------------------------------------------------------------------------

test("0018: nothing here merges two people", () => {
  assert.doesNotMatch(code, /merged_into\s*=\s*[^ ]/, "this migration must never merge");
  assert.doesNotMatch(code, /INSERT INTO case_merge/);
  // Resolution is a fact about the LINK, not a person's status: a structure
  // being wrong must never write someone off.
  assert.doesNotMatch(code, /UPDATE person_case/);
});

test("0018: the event log is append-only for the application role", () => {
  assert.match(code, /REVOKE UPDATE, DELETE ON structure_event FROM app_rw/);
});

test("0018: forgetting a person takes their structure links with them", () => {
  // Ley 1581/2012 erasure keeps working: the links cascade from person_case.
  assert.match(code, /case_id\s+uuid NOT NULL REFERENCES person_case\(id\) ON DELETE CASCADE/);
});

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

test("the point schema refuses an ungraded or over-precise claim", () => {
  const ok = { lat: 3.41, lng: -76.52, precision: "building" };
  assert.equal(structurePoint.safeParse(ok).success, true);
  assert.equal(structurePoint.safeParse({ lat: 3.41, lng: -76.52 }).success, false,
    "a point with no grade must be refused at the edge");
  assert.equal(structurePoint.safeParse({ ...ok, precision: "exact" }).success, false);
  assert.equal(structurePoint.safeParse({ ...ok, lat: 200 }).success, false);
});

test("scan, resolution and link vocabularies match the database", () => {
  assert.equal(structureScan.safeParse({ scan_state: "clear" }).success, true);
  assert.equal(structureScan.safeParse({ scan_state: "cleared" }).success, false);
  assert.equal(structureResolve.safeParse({ resolution: "not_at_structure" }).success, true);
  assert.equal(structureResolve.safeParse({ resolution: "same_person" }).success, false,
    "structures must not be able to express a dedup decision");
  assert.equal(structureLink.safeParse({ case_id: "not-a-uuid" }).success, false);
});

test("creating a structure cannot smuggle in a coordinate", () => {
  const parsed = structureInput.safeParse({
    key: "edificio-vanessa", name: "Edificio Vanessa", lat: 3.41, lng: -76.52,
  });
  assert.equal(parsed.success, true);
  assert.equal("lat" in (parsed as any).data, false,
    "a name typed in a form and a pin placed on a map are different events");
  assert.equal(structureInput.safeParse({ key: "Edificio Vanessa", name: "x y" }).success, false,
    "key must be a slug so a re-import cannot create a second row for one building");
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test("the routes are registered, or none of this exists at runtime", () => {
  assert.match(index, /import structureRoutes from "\.\/routes\/structures\.js"/);
  assert.match(index, /await app\.register\(structureRoutes\)/);
  // The refusal detail has to survive the error handler, or the panel gets a
  // bare message and can only grey a button out.
  assert.match(index, /\.\.\.\(err\.details \?\? \{\}\)/);
});

test("every structure route is operator-only", () => {
  const handlers = routes.split("app.").slice(1).filter((h) => h.startsWith("get<") || h.startsWith("post<"));
  assert.ok(handlers.length >= 7, `expected the structure routes, found ${handlers.length}`);
  for (const h of handlers) {
    assert.match(h, /requireOperator\(req\.actor\)/, `an unauthenticated structure route: ${h.slice(0, 80)}`);
  }
});

test("a refused clear answers with the people blocking it, not a bare error", () => {
  assert.match(routes, /structure_blockers/);
  assert.match(routes, /structure_has_open_cases/);
  assert.match(routes, /\{ blockers \}/);
  // 409, not 500: this is a rule, not a fault.
  assert.match(routes, /new HttpError\(\s*409/);
});

test("routes sign what they write and log it", () => {
  assert.match(routes, /point_set_by=\$6/);
  assert.match(routes, /scan_signed_by = CASE WHEN \$2 = 'not_scanned' THEN NULL ELSE \$3 END/);
  assert.match(routes, /INSERT INTO structure_event/);
  assert.match(routes, /audit\(req\.actor, "structure\.scan"/);
});

test("projecting a point is not run under the intake statement timeout", () => {
  // One refresh_person_index per person; a big structure has dozens. A timeout
  // halfway through rolls everything back and looks like nothing happened.
  // statement_timeout is armed at statement start, so it must be raised in a
  // separate, earlier statement in the same transaction.
  const handler = routes.slice(routes.indexOf("/project-point"));
  const setLocal = handler.indexOf("SET LOCAL statement_timeout");
  const call = handler.indexOf("project_structure_point($1");
  assert.ok(setLocal > -1 && call > setLocal,
    "the timeout must be raised before the call, inside the same transaction");
  // And not from inside the function, where it would be too late.
  assert.doesNotMatch(code, /set_config\('statement_timeout'/);
});

test("resolving a person in a structure does not touch their case status", () => {
  const handler = routes.slice(routes.indexOf("/cases/:caseId/resolve"));
  assert.doesNotMatch(handler, /UPDATE person_case/,
    "a body recovered and a person found elsewhere are not one click");
});

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

test("the board says why 'clear' was refused instead of greying out", () => {
  assert.match(board, /structure_has_open_cases/);
  assert.match(board, /blockers/);
  assert.match(board, /No se puede despejar todav[ií]a/);
});

test("the board never presents a coarse point as an address", () => {
  assert.match(board, /solo calle/);
  assert.match(board, /solo barrio/);
  assert.match(board, /Sin punto en el mapa/);
  assert.match(board, /location_action/);
});

test("the board pins at building grade and says who is on the hook", () => {
  assert.match(board, /precision: "building"/);
  assert.doesNotMatch(board, /precision: "exact"/);
  assert.match(board, /Queda registrado qui[eé]n puso este punto/);
});

// ---------------------------------------------------------------------------
// Importer — the bridge that lets the outside dossier be deleted
// ---------------------------------------------------------------------------

test("an import cannot declare a building searched, and cannot pin anonymously", () => {
  assert.match(importer, /an import may not mark a structure clear/);
  assert.match(importer, /--actor <name> is required/);
  assert.match(importer, /import:\$\{actor\}/);
});

test("an import neither guesses a precision nor overrides an operator's pin", () => {
  assert.match(importer, /unknown precision/);
  assert.match(importer, /point_source = 'operator_pin' THEN structure\.lat ELSE EXCLUDED\.lat END/);
  // A dossier point with no grade is loaded as no point at all, not as a
  // confident coordinate.
  assert.match(importer, /const withPoint = lat != null && lng != null && !!prec;/);
});

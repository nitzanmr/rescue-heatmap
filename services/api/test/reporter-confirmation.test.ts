// The dedup modal's "yes, same person" answer must reach the operator queue.
//
// Static checks, same discipline as frontend-wiring.test.ts: the failure mode
// here is not a crash but a signal quietly going nowhere — which is exactly the
// state the `sumar` button shipped in. It fired a generic note at the first
// candidate before the new report had an id, the engine never saw it, and the
// field tester read the resulting three cases as a bug. These tests pin every
// link in the new chain: form payload → wire schema → intake call → SQL
// function → queue semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { reportInput } from "../src/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const migration = read("db/migrations/0017_reporter_confirmation.sql");
const intake = read("services/api/src/routes/intake.ts");
const form = read("app/web/src/app/reportar/page.tsx");

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

test("reportInput accepts confirmed_same_as and rejects garbage sizes", () => {
  const base = { full_name: "María Ramírez" };
  assert.equal(reportInput.safeParse({ ...base, confirmed_same_as: "CTB-A1B2C3" }).success, true);
  // Absent and null both fine — the common case is no confirmation at all.
  assert.equal(reportInput.safeParse(base).success, true);
  assert.equal(reportInput.safeParse({ ...base, confirmed_same_as: null }).success, true);
  // Too short to be a reference, too long to be one: both refused at the edge
  // rather than carried to SQL.
  assert.equal(reportInput.safeParse({ ...base, confirmed_same_as: "AB" }).success, false);
  assert.equal(reportInput.safeParse({ ...base, confirmed_same_as: "X".repeat(40) }).success, false);
});

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

test("the confirmation rides the report payload, not a premature network call", () => {
  // On the wire list, so toWire() actually sends it.
  assert.match(form, /"confirmed_same_as"/, "confirmed_same_as missing from WIRE_FIELDS");
  // The modal must not fire a sighting at submit time: the new report has no id
  // yet, and the old note bound to hits[0] regardless of what the reporter meant.
  assert.doesNotMatch(form, /api\.sighting/, "the modal is back to firing an orphan sighting");
  // Per-candidate choice: the confirm handler receives a reference number.
  assert.match(form, /onConfirm\(h\.reference_number\)/, "the reporter cannot pick WHICH candidate");
  // The confirmation goes through commit(extra) — never into the draft, where
  // localStorage would leak it into the next report.
  assert.match(form, /commit\(\{ confirmed_same_as: ref \}\)/);
  assert.doesNotMatch(form, /set\(\{\s*confirmed_same_as/, "confirmation must not be persisted to the draft");
});

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

test("intake links the pair after the case exists, best-effort", () => {
  assert.match(intake, /link_reporter_confirmation/, "intake never calls the link function");
  // The call sits AFTER the transaction that creates the case: the function
  // needs both ids to be real rows.
  const txEnd = intake.indexOf("await enqueue(\"correlate\"");
  const call = intake.indexOf("link_reporter_confirmation");
  assert.ok(txEnd > -1 && call > txEnd, "the link must run after the case is committed");
  // And it is wrapped: a stale reference must never bounce an accepted report.
  const tail = intake.slice(call - 200, call + 600);
  assert.match(tail, /try\s*\{[\s\S]*catch/, "the link call is not best-effort");
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("0017: the confirmation is a column the score upsert cannot erase", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reporter_confirmed boolean NOT NULL DEFAULT false/);
});

test("0017: link_reporter_confirmation queues, floors, badges — and never merges", () => {
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.link_reporter_confirmation"),
    migration.indexOf("CREATE OR REPLACE FUNCTION public.enqueue_correlations")
  );
  // Floor at the operator-queue threshold, not a hardcoded literal and not 1.0:
  // a stranger's certainty is not the system's.
  assert.match(fn, /c\.auto_suggest_floor/);
  assert.doesNotMatch(fn, /score[^\n]*=\s*1(\.0)?\b/, "a confirmation must not claim certainty");
  // Strongest view wins, decided pairs stay decided.
  assert.match(fn, /GREATEST\(dedup_candidate\.score, EXCLUDED\.score\)/);
  assert.match(fn, /state IN \('pending','lead'\)/);
  // The note on the existing case names the NEW reference — the whole point.
  assert.match(fn, /v_new\.reference_number/);
  // Same incident only; merged and erased targets refused.
  assert.match(fn, /incident_id = v_new\.incident_id/);
  assert.match(fn, /merged_into IS NULL/);
  assert.match(fn, /anonymised_at IS NULL/);
  // NEVER a merge: no assignment to merged_into, no 'merged' state anywhere in
  // the function. Nothing merges without a human.
  assert.doesNotMatch(fn, /merged_into\s*=/, "the link function must never merge");
  assert.doesNotMatch(fn, /'merged'/, "the link function must never set a merged state");
});

test("0017: a later engine pass keeps the confirmation visible and queued", () => {
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.enqueue_correlations")
  );
  // The upsert that replaces the signals blob re-attaches the badge…
  assert.match(fn, /dedup_candidate\.reporter_confirmed[\s\S]*jsonb_build_object\('reporter_confirmed', true\)/);
  // …and a confirmed pair can never be demoted back to a lead.
  assert.match(fn, /WHEN dedup_candidate\.reporter_confirmed THEN 'pending'/);
});

test("panel surfaces the badge and sorts confirmed pairs first", () => {
  const panel = read("services/api/src/routes/panel.ts");
  assert.match(panel, /d\.reporter_confirmed/);
  assert.match(panel, /ORDER BY d\.reporter_confirmed DESC, d\.score DESC/);
});

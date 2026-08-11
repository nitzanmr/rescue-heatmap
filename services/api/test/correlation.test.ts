// Measures the correlation engine against known ground truth.
//
// This is the test that matters. Everything else in this service is plumbing;
// this is the one thing the system does that nothing else does, and until it is
// measured the weights in correlation_config are my guess and nothing more.
//
//   docker compose up -d db && docker compose run --rm migrate
//   DATABASE_URL=postgres://rescue:rescue@localhost:5432/rescue npm test
//
// Two failure modes, and they are NOT symmetrical:
//   * a missed duplicate  -> two teams search for one person. Wasteful.
//   * a false suggestion  -> an operator may merge two different people, and a
//     team stops looking for someone who is still under the rubble.
// Hence: recall is the headline number, but precision has the hard floor.
import test from "node:test";
import assert from "node:assert/strict";
import { pool, query } from "../src/db.js";
import { seed } from "../src/seed.js";

const HAVE_DB = !!process.env.DATABASE_URL;

type Pair = string;
const key = (a: string, b: string): Pair => (a < b ? `${a}|${b}` : `${b}|${a}`);

test("correlation engine: precision and recall against seeded ground truth", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");

  const n = Number(process.env.TEST_SEED_CASES ?? 300);
  await query(`TRUNCATE dedup_candidate, seed_truth`).catch(() => {});
  const { incidentId } = await seed(n);

  // Run the real pipeline: the same function the worker calls.
  const cases = await query<{ id: string }>(
    `SELECT id FROM person_case WHERE incident_id = $1`, [incidentId]
  );
  const t0 = Date.now();
  for (const c of cases) {
    await query(`SELECT public.enqueue_correlations($1)`, [c.id]);
  }
  const elapsed = Date.now() - t0;

  const truth = new Set(
    (await query<{ a_case: string; b_case: string }>(
      `SELECT a_case, b_case FROM seed_truth WHERE kind = 'duplicate'`
    )).map((r) => key(r.a_case, r.b_case))
  );
  const suggested = new Set(
    (await query<{ a_case: string; b_case: string }>(
      `SELECT a_case, b_case FROM dedup_candidate WHERE incident_id = $1`, [incidentId]
    )).map((r) => key(r.a_case, r.b_case))
  );

  let tp = 0;
  for (const p of suggested) if (truth.has(p)) tp++;
  const fp = suggested.size - tp;
  const fn = truth.size - tp;
  const precision = suggested.size ? tp / suggested.size : 1;
  const recall = truth.size ? tp / truth.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  console.log(JSON.stringify({
    cases: cases.length,
    truth_pairs: truth.size,
    suggested_pairs: suggested.size,
    true_positives: tp, false_positives: fp, false_negatives: fn,
    precision: +precision.toFixed(3),
    recall: +recall.toFixed(3),
    f1: +f1.toFixed(3),
    ms_total: elapsed,
    ms_per_case: +(elapsed / Math.max(cases.length, 1)).toFixed(1),
  }, null, 2));

  // Thresholds are deliberately loose for now. They are a regression guard, not
  // a quality claim: their job is to make it loud when a weight change makes
  // things worse. Tighten them once we have real reports to calibrate against.
  assert.ok(recall >= 0.6, `recall too low: ${recall.toFixed(3)} (missed duplicates)`);
  assert.ok(precision >= 0.5, `precision too low: ${precision.toFixed(3)} (operator queue noise)`);

  // Latency budget: correlation runs in the worker, but a case that takes a
  // second to correlate means a 20k-report event never catches up.
  assert.ok(elapsed / cases.length < 250,
    `correlation too slow: ${(elapsed / cases.length).toFixed(1)} ms/case`);
});

test("never auto-merges: every candidate lands as 'pending'", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  const rows = await query<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM dedup_candidate GROUP BY state`
  );
  for (const r of rows) {
    assert.equal(r.state, "pending",
      `found ${r.n} candidates in state '${r.state}' — nothing may merge without a human`);
  }
  const merged = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM person_case WHERE merged_into IS NOT NULL`
  );
  assert.equal(merged[0].n, 0, "a case was merged without an operator decision");
});

test("Spanish name normalisation is order- and accent-insensitive", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  const rows = await query<{ a: string; b: string; c: string }>(
    `SELECT public.name_key('María José García Pérez')  AS a,
            public.name_key('Jose Maria Perez Garcia')  AS b,
            public.name_key('  maria  jose garcia perez ') AS c`
  );
  assert.equal(rows[0].a, rows[0].b, "accents / name order changed the key");
  assert.equal(rows[0].a, rows[0].c, "whitespace or case changed the key");
});

test("public projection leaks nothing identifying", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  const cols = (await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'public_case_view'`
  )).map((c) => c.column_name);

  // ADR-001. If one of these ever appears in the public view, a stalker or an
  // armed group gets a targeting list, and that is the failure this project
  // cannot survive.
  const forbidden = ["phone_e164", "national_id_last4", "floor", "apartment",
    "narrative", "medical_info", "reporter_phones", "last_seen"];
  for (const f of forbidden) {
    assert.ok(!cols.includes(f), `public_case_view exposes '${f}'`);
  }
});

test.after(async () => { await pool.end().catch(() => {}); });

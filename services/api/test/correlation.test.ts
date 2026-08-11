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

// A single number at one threshold is not a measurement of the engine, it is a
// measurement of one arbitrary constant. So the test scores every pair ONCE and
// then sweeps the suggestion floor over the scores it already has. Two costs are
// separated on purpose:
//
//   * BLOCKING loss  - the pair never even reached the scorer (radius, trigram
//     floor, no phone/id overlap). No threshold can recover it. Fixing this
//     means changing candidate generation.
//   * THRESHOLD loss - the pair was scored, and the floor threw it away. This
//     one is free to fix, and the sweep says exactly what it costs in precision.
//
// Confusing the two is how a team spends a week tuning weights for recall that
// was never reachable.
test("correlation engine: precision/recall curve against seeded ground truth", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");

  const n = Number(process.env.TEST_SEED_CASES ?? 300);
  await query(`TRUNCATE dedup_candidate, seed_truth`).catch(() => {});
  const previousSeedIncident = process.env.SEED_INCIDENT;
  process.env.SEED_INCIDENT = `test-correlation-${process.pid}-${Date.now()}`;
  const { incidentId } = await seed(n);
  if (previousSeedIncident === undefined) delete process.env.SEED_INCIDENT;
  else process.env.SEED_INCIDENT = previousSeedIncident;

  const cfg = (await query<{ auto_suggest_floor: number }>(
    `SELECT auto_suggest_floor FROM correlation_config WHERE id = 1`
  ))[0];
  const liveFloor = Number(cfg.auto_suggest_floor);

  const cases = await query<{ id: string }>(
    `SELECT id FROM person_case WHERE incident_id = $1`, [incidentId]
  );

  // One scoring pass. correlate_case() is the same function the worker calls;
  // enqueue_correlations() is only that function plus the floor, so scoring here
  // and thresholding in JS measures the production engine, not a copy of it.
  const scores = new Map<Pair, number>();
  const t0 = Date.now();
  for (const c of cases) {
    const rows = await query<{ case_id: string; score: number }>(
      `SELECT case_id, score FROM public.correlate_case($1, 50)`, [c.id]
    );
    for (const r of rows) {
      const k = key(c.id, r.case_id);
      const s = Number(r.score);
      if (!(scores.get(k)! >= s)) scores.set(k, s);   // NaN-safe max
    }
  }
  const elapsed = Date.now() - t0;

  const truthRows = await query<{ a_case: string; b_case: string; pair_type: string | null }>(
    `SELECT a_case, b_case, pair_type FROM seed_truth WHERE kind = 'duplicate'`
  );
  const truth = new Set(truthRows.map((r) => key(r.a_case, r.b_case)));
  const typeOf = new Map<Pair, string>(
    truthRows.map((r) => [key(r.a_case, r.b_case), r.pair_type ?? "unknown"])
  );

  // Everything the scorer ever saw, at any score.
  const scoredTruth = [...truth].filter((p) => scores.has(p));
  const blocked = [...truth].filter((p) => !scores.has(p));
  const recallCeiling = truth.size ? scoredTruth.length / truth.size : 1;

  // Recall split by how hard the pair is. An average over both hides the case a
  // real event produces most of: two strangers each re-telling the same person.
  const byType = (floor: number) => {
    const out: Record<string, { pairs: number; found: number; blocked: number; recall: number }> = {};
    for (const p of truth) {
      const t = typeOf.get(p) ?? "unknown";
      out[t] ??= { pairs: 0, found: 0, blocked: 0, recall: 0 };
      out[t].pairs++;
      const s = scores.get(p);
      if (s === undefined) out[t].blocked++;
      else if (s >= floor) out[t].found++;
    }
    for (const t of Object.keys(out)) out[t].recall = +(out[t].found / out[t].pairs).toFixed(3);
    return out;
  };

  const at = (floor: number) => {
    let tp = 0, suggested = 0;
    for (const [p, s] of scores) {
      if (s < floor) continue;
      suggested++;
      if (truth.has(p)) tp++;
    }
    const precision = suggested ? tp / suggested : 1;
    const recall = truth.size ? tp / truth.size : 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { floor: +floor.toFixed(3), suggested, tp, fp: suggested - tp,
             fn: truth.size - tp, precision: +precision.toFixed(3),
             recall: +recall.toFixed(3), f1: +f1.toFixed(3) };
  };

  const curve = [];
  for (let f = 0.35; f <= 0.7501; f += 0.025) curve.push(at(f));

  // The operating point we are willing to defend out loud. A missed duplicate
  // wastes a team; a false suggestion can make a team stop searching for someone
  // still alive. So: maximise recall subject to a hard precision floor.
  const P_FLOOR = Number(process.env.TARGET_PRECISION ?? 0.90);
  const R_TARGET = Number(process.env.TARGET_RECALL ?? 0.85);
  const feasible = curve.filter((p) => p.precision >= P_FLOOR);
  const best = feasible.length
    ? feasible.reduce((a, b) => (b.recall > a.recall ? b : a))
    : curve.reduce((a, b) => (b.f1 > a.f1 ? b : a));

  const live = at(liveFloor);
  const missedScores = scoredTruth
    .map((p) => scores.get(p)!)
    .filter((s) => s < liveFloor)
    .sort((a, b) => b - a);

  console.log(JSON.stringify({
    cases: cases.length,
    truth_pairs: truth.size,
    pairs_scored: scores.size,
    ms_total: elapsed,
    ms_per_case: +(elapsed / Math.max(cases.length, 1)).toFixed(1),
    // What candidate generation makes possible at ANY threshold.
    recall_ceiling: +recallCeiling.toFixed(3),
    blocked_truth_pairs: blocked.length,
    live_floor: liveFloor,
    live: live,
    live_by_pair_type: byType(liveFloor),
    recommended_by_pair_type: byType(best.floor),
    // Duplicates that WERE scored and lost to the floor alone, best first.
    threshold_losses: missedScores.length,
    threshold_loss_scores_top: missedScores.slice(0, 10).map((s) => +s.toFixed(3)),
    recommended: best,
    curve,
  }, null, 2));

  // Regression guards, not quality claims. They fail loudly when a weight change
  // makes things worse; they do not assert the engine is good enough to ship.
  assert.ok(live.precision >= 0.5,
    `precision too low: ${live.precision} (operator queue noise)`);
  assert.ok(live.recall >= 0.6,
    `recall too low: ${live.recall} (missed duplicates)`);

  // The one thing that must not silently rot: candidate generation. If blocking
  // starts throwing away real duplicates, no threshold work can win them back.
  assert.ok(recallCeiling >= 0.9,
    `candidate generation lost ${blocked.length}/${truth.size} duplicates before scoring ` +
    `(ceiling ${recallCeiling.toFixed(3)}) — this is a blocking bug, not a threshold one`);

  // Reaching the declared operating point is the goal, not yet the contract.
  if (!(best.recall >= R_TARGET && best.precision >= P_FLOOR)) {
    console.log(JSON.stringify({
      level: "warn",
      msg: "no floor reaches the declared operating point",
      target: { recall: R_TARGET, precision: P_FLOOR }, best,
    }));
  }

  // Latency budget: correlation runs in the worker, but a case that takes a
  // second to correlate means a 20k-report event never catches up.
  assert.ok(elapsed / cases.length < 250,
    `correlation too slow: ${(elapsed / cases.length).toFixed(1)} ms/case`);
});

// The sweep thresholds in JS. This proves the production path — the worker's
// enqueue_correlations() — agrees with it at the configured floor, so the curve
// above describes the real system and not a parallel implementation of it.
test("the worker's enqueue path agrees with the swept scores at the live floor", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");

  const previousSeedIncident = process.env.SEED_INCIDENT;
  process.env.SEED_INCIDENT = `test-enqueue-${process.pid}-${Date.now()}`;
  const { incidentId } = await seed(Number(process.env.TEST_ENQUEUE_CASES ?? 60));
  if (previousSeedIncident === undefined) delete process.env.SEED_INCIDENT;
  else process.env.SEED_INCIDENT = previousSeedIncident;

  const floor = Number((await query<{ auto_suggest_floor: number }>(
    `SELECT auto_suggest_floor FROM correlation_config WHERE id = 1`
  ))[0].auto_suggest_floor);

  const cases = await query<{ id: string }>(
    `SELECT id FROM person_case WHERE incident_id = $1`, [incidentId]
  );
  const expected = new Set<Pair>();
  for (const c of cases) {
    const rows = await query<{ case_id: string; score: number }>(
      `SELECT case_id, score FROM public.correlate_case($1, 25)`, [c.id]
    );
    for (const r of rows) if (Number(r.score) >= floor) expected.add(key(c.id, r.case_id));
    await query(`SELECT public.enqueue_correlations($1)`, [c.id]);
  }

  const actual = new Set(
    (await query<{ a_case: string; b_case: string }>(
      `SELECT a_case, b_case FROM dedup_candidate WHERE incident_id = $1`, [incidentId]
    )).map((r) => key(r.a_case, r.b_case))
  );

  const missing = [...expected].filter((p) => !actual.has(p));
  const extra = [...actual].filter((p) => !expected.has(p));
  assert.deepEqual(missing, [], "scored above the floor but never queued for an operator");
  assert.deepEqual(extra, [], "queued a pair the scorer did not put above the floor");
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

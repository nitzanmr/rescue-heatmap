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
import { requireFreshSchema } from "./schema-freshness.js";

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
  await requireFreshSchema();

  const n = Number(process.env.TEST_SEED_CASES ?? 300);
  await query(`TRUNCATE dedup_candidate, seed_truth`).catch(() => {});
  const previousSeedIncident = process.env.SEED_INCIDENT;
  process.env.SEED_INCIDENT = `test-correlation-${process.pid}-${Date.now()}`;
  const { incidentId } = await seed(n);
  if (previousSeedIncident === undefined) delete process.env.SEED_INCIDENT;
  else process.env.SEED_INCIDENT = previousSeedIncident;

  const cfg = (await query<{
    auto_suggest_floor: number; lead_floor: number;
    candidate_limit: number; phonetic_enabled: boolean;
  }>(
    `SELECT auto_suggest_floor, lead_floor, candidate_limit, phonetic_enabled
       FROM correlation_config WHERE id = 1`
  ))[0];
  const liveFloor = Number(cfg.auto_suggest_floor);
  const leadFloor = Number(cfg.lead_floor);

  const cases = await query<{ id: string }>(
    `SELECT id FROM person_case WHERE incident_id = $1`, [incidentId]
  );

  // One scoring pass. correlate_case() is the same function the worker calls;
  // enqueue_correlations() is only that function plus the floor, so scoring here
  // and thresholding in JS measures the production engine, not a copy of it.
  //
  // NO SHORTLIST SIZE IS PASSED. It used to be 50 here and 25 in the worker and
  // the panel, which meant this file reported the recall of an engine that was
  // never going to run in the field. The number now lives once, in
  // correlation_config.candidate_limit, and is printed with the results so a
  // future reader can tell which engine produced them.
  const scores = new Map<Pair, number>();
  const t0 = Date.now();
  for (const c of cases) {
    const rows = await query<{ case_id: string; score: number }>(
      `SELECT case_id, score FROM public.correlate_case($1)`, [c.id]
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
  //
  // AND the point must not sit on a cliff. "Maximise recall subject to a
  // precision floor" on its own picks the last value before precision falls
  // through the floor, which is by definition the most fragile point on the
  // curve: one step further and the guarantee is gone. Since the data will
  // change the day real reports arrive, a candidate is only eligible if the
  // NEXT step down still holds most of its precision. Stability is part of the
  // requirement, not a nicety.
  const P_FLOOR = Number(process.env.TARGET_PRECISION ?? 0.90);
  const R_TARGET = Number(process.env.TARGET_RECALL ?? 0.85);
  const MAX_CLIFF = Number(process.env.MAX_PRECISION_CLIFF ?? 0.03);

  const stepBelow = (p: (typeof curve)[number]) =>
    curve.filter((q) => q.floor < p.floor).sort((a, b) => b.floor - a.floor)[0];
  const cliffOf = (p: (typeof curve)[number]) => {
    const below = stepBelow(p);
    return below ? +(p.precision - below.precision).toFixed(3) : 0;
  };

  const feasible = curve.filter((p) => p.precision >= P_FLOOR);
  const stable = feasible.filter((p) => cliffOf(p) <= MAX_CLIFF);
  const best = stable.length
    ? stable.reduce((a, b) => (b.recall > a.recall ? b : a))
    : feasible.length
      ? feasible.reduce((a, b) => (b.recall > a.recall ? b : a))
      : curve.reduce((a, b) => (b.f1 > a.f1 ? b : a));

  const live = at(liveFloor);
  // What the second band buys. A lead is not queued, so its false positives do
  // not cost an operator a decision — they cost a glance on a case already
  // open. Reported separately precisely so the two are never added together.
  const leadBand = at(leadFloor);
  const leadOnly = {
    lead_floor: leadFloor,
    extra_true_pairs: leadBand.tp - live.tp,
    extra_false_pairs: leadBand.fp - live.fp,
    recall_if_leads_count: leadBand.recall,
    queue_recall: live.recall,
  };
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
    candidate_limit: Number(cfg.candidate_limit),
    phonetic_enabled: cfg.phonetic_enabled,
    live_floor: liveFloor,
    live: live,
    lead_band: leadOnly,
    recommended_cliff: cliffOf(best),
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
  await requireFreshSchema();

  const previousSeedIncident = process.env.SEED_INCIDENT;
  process.env.SEED_INCIDENT = `test-enqueue-${process.pid}-${Date.now()}`;
  const { incidentId } = await seed(Number(process.env.TEST_ENQUEUE_CASES ?? 60));
  if (previousSeedIncident === undefined) delete process.env.SEED_INCIDENT;
  else process.env.SEED_INCIDENT = previousSeedIncident;

  const cfg = (await query<{ auto_suggest_floor: number; lead_floor: number }>(
    `SELECT auto_suggest_floor, lead_floor FROM correlation_config WHERE id = 1`
  ))[0];
  const floor = Number(cfg.auto_suggest_floor);
  const lead = Number(cfg.lead_floor);

  const cases = await query<{ id: string }>(
    `SELECT id FROM person_case WHERE incident_id = $1`, [incidentId]
  );
  // Same call the worker makes: no shortlist size, no floor of its own.
  const expected = new Map<Pair, string>();
  for (const c of cases) {
    const rows = await query<{ case_id: string; score: number }>(
      `SELECT case_id, score FROM public.correlate_case($1)`, [c.id]
    );
    for (const r of rows) {
      const s = Number(r.score);
      if (s < lead) continue;
      const k = key(c.id, r.case_id);
      const band = s >= floor ? "pending" : "lead";
      // Either side of a pair may promote it; a pair seen as a lead once and a
      // suggestion once belongs in the queue.
      if (band === "pending" || !expected.has(k)) expected.set(k, band);
    }
    await query(`SELECT public.enqueue_correlations($1)`, [c.id]);
  }

  const actual = new Map(
    (await query<{ a_case: string; b_case: string; state: string }>(
      `SELECT a_case, b_case, state FROM dedup_candidate WHERE incident_id = $1`, [incidentId]
    )).map((r) => [key(r.a_case, r.b_case), r.state] as const)
  );

  const missing = [...expected.keys()].filter((p) => !actual.has(p));
  const extra = [...actual.keys()].filter((p) => !expected.has(p));
  assert.deepEqual(missing, [], "scored above the lead floor but never recorded");
  assert.deepEqual(extra, [], "recorded a pair the scorer did not put above the lead floor");

  // The band matters as much as the pair: a lead that lands in the queue is
  // exactly the noise the two-band split exists to keep out of it.
  const misbanded = [...expected].filter(([p, band]) => actual.get(p) !== band);
  assert.deepEqual(misbanded, [], "a pair landed in the wrong band");
});

// A shortlist an operator cannot reproduce is not evidence. Ties used to be
// broken by whatever order the planner returned, so the same case gave a
// different shortlist on a re-run — which is what made this suite flap by one
// pair with a different uuid each time.
test("the shortlist is deterministic across repeated calls", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  await requireFreshSchema();
  const cases = await query<{ id: string }>(
    `SELECT case_id AS id FROM person_index ORDER BY case_id LIMIT 40`
  );
  if (!cases.length) return t.skip("no indexed cases");
  for (const c of cases) {
    const shot = async () => (await query<{ case_id: string }>(
      `SELECT case_id FROM public.correlate_case($1)`, [c.id]
    )).map((r) => r.case_id).join(",");
    assert.equal(await shot(), await shot(),
      `correlate_case(${c.id}) returned a different shortlist on a re-run`);
  }
});

test("never auto-merges: every candidate is undecided until a human acts", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  await requireFreshSchema();
  const rows = await query<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM dedup_candidate GROUP BY state`
  );
  for (const r of rows) {
    assert.ok(["pending", "lead"].includes(r.state),
      `found ${r.n} candidates in state '${r.state}' — nothing may merge without a human`);
  }
  // A lead is below the queue floor by construction. If one ever outranks the
  // floor the two bands have crossed and the queue is silently losing pairs.
  const badLead = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dedup_candidate d, correlation_config c
      WHERE c.id = 1 AND d.state = 'lead' AND d.score >= c.auto_suggest_floor`
  );
  assert.equal(badLead[0].n, 0, "a lead scored above the queue floor and was not promoted");
  const merged = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM person_case WHERE merged_into IS NOT NULL`
  );
  assert.equal(merged[0].n, 0, "a case was merged without an operator decision");
});

test("Spanish name normalisation is order- and accent-insensitive", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  await requireFreshSchema();
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
  await requireFreshSchema();
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

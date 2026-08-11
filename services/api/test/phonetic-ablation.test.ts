// Phonetic name matching: an ablation, not an opinion.
//
// Duplicate-vs-duplicate recall is 0.41 — two strangers each re-telling the
// same person, both spellings mangled — and it is the pair type a real event
// produces most of. No threshold fixes it: at 0.50 it only reaches 0.53. The
// reason is structural. name_sim is max(trigram, token overlap), and when BOTH
// sides are misspelled the two measures fail together.
//
// Spanish transliteration noise is phonetically invisible: Jhon/John,
// Gonzales/Gonzalez, Yeison/Jeison, Vasquez/Basquez. dmetaphone collapses
// exactly those. That is a plausible story, which is not the same as a
// measured gain — so the feature ships OFF and this file measures both sides on
// the SAME seed and prints the difference.
//
//   DATABASE_URL=... ABLATION=1 npm test
//
// It only ever fails on a regression that a reviewer should not have to notice:
// phonetics costing precision, or the flag doing nothing at all.
import test from "node:test";
import assert from "node:assert/strict";
import { pool, query } from "../src/db.js";
import { seed } from "../src/seed.js";
import { requireFreshSchema } from "./schema-freshness.js";

const HAVE_DB = !!process.env.DATABASE_URL;
const RUN = !!process.env.ABLATION;

type Pair = string;
const key = (a: string, b: string): Pair => (a < b ? `${a}|${b}` : `${b}|${a}`);

test("ablation: what phonetic name matching actually buys", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  if (!RUN) return t.skip("set ABLATION=1 to run (it re-scores the seed twice)");
  await requireFreshSchema();

  const n = Number(process.env.ABLATION_CASES ?? 300);
  const previous = process.env.SEED_INCIDENT;
  process.env.SEED_INCIDENT = `ablation-${process.pid}-${Date.now()}`;
  const { incidentId } = await seed(n);
  if (previous === undefined) delete process.env.SEED_INCIDENT;
  else process.env.SEED_INCIDENT = previous;

  const cfg0 = (await query<{ phonetic_enabled: boolean; auto_suggest_floor: number }>(
    `SELECT phonetic_enabled, auto_suggest_floor FROM correlation_config WHERE id = 1`
  ))[0];
  const floor = Number(cfg0.auto_suggest_floor);

  const truthRows = await query<{ a_case: string; b_case: string; pair_type: string | null }>(
    `SELECT a_case, b_case, pair_type FROM seed_truth WHERE kind = 'duplicate'`
  );
  const truth = new Set(truthRows.map((r) => key(r.a_case, r.b_case)));
  const typeOf = new Map<Pair, string>(
    truthRows.map((r) => [key(r.a_case, r.b_case), r.pair_type ?? "unknown"])
  );
  const cases = await query<{ id: string }>(
    `SELECT id FROM person_case WHERE incident_id = $1`, [incidentId]
  );

  const measure = async (phonetic: boolean) => {
    await query(`UPDATE correlation_config SET phonetic_enabled = $1 WHERE id = 1`, [phonetic]);
    const scores = new Map<Pair, number>();
    const t0 = Date.now();
    for (const c of cases) {
      const rows = await query<{ case_id: string; score: number }>(
        `SELECT case_id, score FROM public.correlate_case($1)`, [c.id]
      );
      for (const r of rows) {
        const k = key(c.id, r.case_id);
        const s = Number(r.score);
        if (!(scores.get(k)! >= s)) scores.set(k, s);
      }
    }
    const ms = Date.now() - t0;
    let tp = 0, suggested = 0;
    for (const [p, s] of scores) {
      if (s < floor) continue;
      suggested++;
      if (truth.has(p)) tp++;
    }
    const byType: Record<string, { pairs: number; found: number; recall: number }> = {};
    for (const p of truth) {
      const ty = typeOf.get(p) ?? "unknown";
      byType[ty] ??= { pairs: 0, found: 0, recall: 0 };
      byType[ty].pairs++;
      if ((scores.get(p) ?? -1) >= floor) byType[ty].found++;
    }
    for (const ty of Object.keys(byType))
      byType[ty].recall = +(byType[ty].found / byType[ty].pairs).toFixed(3);
    return {
      phonetic, floor,
      precision: +(suggested ? tp / suggested : 1).toFixed(3),
      recall: +(truth.size ? tp / truth.size : 1).toFixed(3),
      suggested, tp, fp: suggested - tp,
      ms_per_case: +(ms / Math.max(cases.length, 1)).toFixed(1),
      by_pair_type: byType,
      scores,
    };
  };

  const off = await measure(false);
  const on = await measure(true);
  // Leave the flag exactly as it was found. An ablation must not become a
  // deploy.
  await query(`UPDATE correlation_config SET phonetic_enabled = $1 WHERE id = 1`,
    [cfg0.phonetic_enabled]);

  const rescued = [...truth].filter(
    (p) => (off.scores.get(p) ?? -1) < floor && (on.scores.get(p) ?? -1) >= floor);
  const newFalse = [...on.scores.keys()].filter(
    (p) => !truth.has(p) && on.scores.get(p)! >= floor && (off.scores.get(p) ?? -1) < floor);

  const strip = (m: Awaited<ReturnType<typeof measure>>) => {
    const { scores, ...rest } = m; return rest;
  };
  console.log(JSON.stringify({
    ablation: "phonetic name matching (dmetaphone)",
    off: strip(off),
    on: strip(on),
    delta: {
      precision: +(on.precision - off.precision).toFixed(3),
      recall: +(on.recall - off.recall).toFixed(3),
      duplicates_rescued: rescued.length,
      new_false_suggestions: newFalse.length,
      cost_ms_per_case: +(on.ms_per_case - off.ms_per_case).toFixed(1),
    },
    rescued_by_pair_type: rescued.reduce<Record<string, number>>((acc, p) => {
      const ty = typeOf.get(p) ?? "unknown"; acc[ty] = (acc[ty] ?? 0) + 1; return acc;
    }, {}),
  }, null, 2));

  // If dmetaphone is unavailable the flag is a no-op; say so instead of
  // reporting a null result as a finding.
  const available = (await query<{ ok: boolean }>(
    `SELECT public.phonetic_tokens(ARRAY['gonzalez']) IS NOT NULL AS ok`
  ))[0].ok;
  if (!available) return t.skip("fuzzystrmatch not installed — phonetic matching is unavailable");

  assert.ok(on.recall >= off.recall,
    `phonetics lost recall (${off.recall} -> ${on.recall}) — it can only widen name_sim`);
  assert.ok(off.precision - on.precision <= 0.05,
    `phonetics cost ${(off.precision - on.precision).toFixed(3)} precision — ` +
    `too much to enable by default`);
});

test.after(async () => { await pool.end().catch(() => {}); });

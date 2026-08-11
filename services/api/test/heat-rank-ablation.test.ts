// Does duplicate detection change the MAP, or only the pair statistics?
//
// The argument this file exists to settle, made in the group on 11 Aug 2026: a
// heat map is a ranking, so a uniform multiplicative error in cell weight
// changes no rescue decision. If that is true, most of docs/dedup-review.md is
// optional and the engine is already good enough to ship. If it is false, it
// will be false in a specific way — and the specific way matters more than the
// average, because an error that is CORRELATED WITH SEVERITY flattens exactly
// the peaks the map exists to find.
//
// So this measures what an operator actually consumes: the ORDER of cells. Four
// regimes over one population, all through the production heat_cells():
//
//   perfect    every true duplicate merged, nothing else. The reference.
//   none       nothing merged at all — the engine switched off.
//   random20   perfect, plus false merges on ~20% of RANDOM unrelated pairs.
//   sibling20  perfect, plus false merges on ~20% of SIBLING pairs (one parent,
//              one address, several children).
//
// Reported per regime, against `perfect`:
//   * Spearman rho over cell weights (union of cells, absent = 0)
//   * top-20 overlap, i.e. would a team be sent to the same twenty places
//   * the weight change of the single heaviest cell
//
// The prediction being tested: random corruption barely moves the ranking, and
// sibling corruption moves the top of it. If BOTH leave top-20 untouched, the
// "good enough" argument wins and F2/F6/F7 can wait. This file does not decide
// that; it prints the number and states what the number would mean.
//
// Nothing is left behind: everything runs inside ONE transaction that is always
// rolled back, because the suite's other invariant ("no case is ever merged
// without an operator") is global and true.
//
//   DATABASE_URL=... RANK_ABLATION=1 npm test        (or: make rank-ablation)
import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { pool } from "../src/db.js";
import { requireFreshSchema } from "./schema-freshness.js";

const HAVE_DB = !!process.env.DATABASE_URL;
const RUN = !!process.env.RANK_ABLATION;

// Deterministic: a measurement that changes between runs is not a measurement.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const GIVEN_M = ["Jose", "Juan", "Carlos", "Luis", "Miguel", "Andres", "Diego", "Jorge", "Ivan", "Nicolas"];
const GIVEN_F = ["Maria", "Ana", "Luisa", "Carmen", "Sofia", "Valentina", "Camila", "Paula", "Daniela", "Lucia"];
const SURNAMES = ["Mosquera", "Renteria", "Palacios", "Cordoba", "Asprilla", "Murillo", "Klinger",
  "Ibarguen", "Moreno", "Perez", "Gomez", "Rojas", "Quinto", "Bejarano", "Mena", "Valencia"];
const CENTRE = { lat: 5.6947, lng: -76.6611 };

interface Built {
  incidentId: string;
  // pairs of case ids that are the SAME person (what a perfect engine merges)
  duplicatePairs: [string, string][];
  // pairs that are DIFFERENT people in one household (what a bad engine merges)
  siblingPairs: [string, string][];
  // pairs that are different people with nothing to do with each other, in the
  // same cell — the "random" corruption, and deliberately the easy error
  strangerPairs: [string, string][];
  cases: number;
}

/**
 * A population with structure, because structure is the whole question.
 *
 * Buildings are placed on a coarse grid so each one owns a 100 m cell. Their
 * occupancy is deliberately NOT uniform: a few catastrophic buildings hold many
 * people (and those are the households where the whole family is missing and
 * nobody is left to file six reports), while most buildings hold one or two.
 * That skew is the thing a uniform-error argument assumes away.
 */
async function build(c: PoolClient, seedNum: number): Promise<Built> {
  const r = rng(seedNum);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const chance = (p: number) => r() < p;

  const slug = `rank-ablation-${process.pid}-${Date.now()}`;
  const inc = await c.query(
    `INSERT INTO incident (slug, name, country, ref_prefix, centre, public_expires_at)
     VALUES ($1,$2,'CO','RNK', ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
             now() + interval '1 day')
     RETURNING id`,
    [slug, "rank ablation (synthetic)", CENTRE.lng, CENTRE.lat]
  );
  const incidentId: string = inc.rows[0].id;

  let refCounter = 0;
  const addCase = async (p: {
    name: string; gender: string; age: number; lat: number; lng: number;
    building: string; reporterPhone: string; status: string; accuracy: string;
    subjectPhone?: string | null;
  }): Promise<string> => {
    const payload = {
      full_name: p.name, gender: p.gender, age_approx: p.age,
      last_seen_lat: p.lat, last_seen_lng: p.lng,
      location_accuracy: p.accuracy, location_source: "map_pick",
      building_name: p.building, reporter_phone: p.reporterPhone,
      subject_phone: p.subjectPhone ?? null,
      last_contact_at: new Date(Date.now() - r() * 12 * 3600_000).toISOString(),
    };
    const cs = await c.query(
      `INSERT INTO person_case (incident_id, status, status_source, reference_number,
                                public_listed, consent_photo_public, is_minor)
       VALUES ($1,$2,'citizen',$3,true,false,$4) RETURNING id`,
      [incidentId, p.status, `RNK-${process.pid}-${++refCounter}`, p.age < 18]
    );
    const caseId: string = cs.rows[0].id;
    await c.query(
      `INSERT INTO report (case_id, incident_id, channel, payload, reporter_phone_e164, submitted_at)
       VALUES ($1,$2,'pwa',$3,$4, now())`,
      [caseId, incidentId, JSON.stringify(payload), p.reporterPhone]
    );
    await c.query(`SELECT public.refresh_person_index($1)`, [caseId]);
    return caseId;
  };

  const buildings = Number(process.env.RANK_BUILDINGS ?? 60);
  const duplicatePairs: [string, string][] = [];
  const siblingPairs: [string, string][] = [];
  const strangerPairs: [string, string][] = [];
  let cases = 0;
  let phoneSeq = 0;
  const nextPhone = () => `+5730${String(1000000 + ++phoneSeq).slice(0, 7)}`;

  for (let b = 0; b < buildings; b++) {
    // 250 m apart on a grid: one building per 100 m cell, no accidental sharing.
    const row = Math.floor(b / 8), col = b % 8;
    const lat = CENTRE.lat + (row * 250) / 111_320;
    const lng = CENTRE.lng + (col * 250) / (111_320 * Math.cos((CENTRE.lat * Math.PI) / 180));
    const building = `Edificio ${b}`;
    // The skew. Most buildings lost one or two people; a handful lost a dozen.
    const severity = chance(0.12) ? 3 + Math.floor(r() * 6) : 1 + Math.floor(r() * 2);
    const collapsed = severity >= 4;              // the peaks the map must find
    const inCell: string[] = [];

    for (let h = 0; h < severity; h++) {
      const female = chance(0.5);
      const s1 = pick(SURNAMES), s2 = pick(SURNAMES);
      const given = pick(female ? GIVEN_F : GIVEN_M);
      const name = `${given} ${s1} ${s2}`;
      const age = 2 + Math.floor(r() * 70);
      // A collapsed building is where "trapped_alive" is heard, and also where
      // there is nobody left to file a second report.
      const status = collapsed && chance(0.35) ? "trapped_alive" : "missing";
      const reporter = nextPhone();
      const first = await addCase({
        name, gender: female ? "f" : "m", age,
        lat: lat + ((r() - 0.5) * 20) / 111_320,
        lng: lng + ((r() - 0.5) * 20) / 111_320,
        building, reporterPhone: reporter, status, accuracy: "building",
      });
      cases++;
      inCell.push(first);

      // A duplicate: a DIFFERENT neighbour re-telling the same person. Less
      // likely in a collapsed building, for the reason above — this is the
      // non-uniformity the "uniform error" argument denies.
      if (chance(collapsed ? 0.12 : 0.35)) {
        const dupName = chance(0.5) ? `${given} ${s1}` : `${given} ${s1} ${s2}`;
        const dup = await addCase({
          name: dupName, gender: female ? "f" : "m", age: age + Math.round((r() - 0.5) * 4),
          lat: lat + ((r() - 0.5) * 60) / 111_320,
          lng: lng + ((r() - 0.5) * 60) / 111_320,
          building, reporterPhone: nextPhone(), status, accuracy: "building",
        });
        cases++;
        duplicatePairs.push([first, dup]);
        inCell.push(dup);
      }
    }

    // A household: one parent, several children, same address, same phone.
    if (chance(0.3)) {
      const s1 = pick(SURNAMES), s2 = pick(SURNAMES);
      const parent = nextPhone();
      const kids: string[] = [];
      const used = new Set<string>();
      const n = 2 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const female = chance(0.5);
        const poolOfNames = (female ? GIVEN_F : GIVEN_M).filter((g) => !used.has(g));
        if (!poolOfNames.length) break;
        const given = pick(poolOfNames);
        used.add(given);
        kids.push(await addCase({
          name: `${given} ${s1} ${s2}`, gender: female ? "f" : "m",
          age: 2 + Math.floor(r() * 16),
          lat: lat + ((r() - 0.5) * 15) / 111_320,
          lng: lng + ((r() - 0.5) * 15) / 111_320,
          building, reporterPhone: parent, status: "missing", accuracy: "building",
        }));
        cases++;
      }
      for (let i = 0; i < kids.length; i++)
        for (let j = i + 1; j < kids.length; j++) siblingPairs.push([kids[i], kids[j]]);
      inCell.push(...kids);
    }

    // Unrelated people who happen to share a cell: the easy false merge.
    for (let i = 0; i < inCell.length; i++)
      for (let j = i + 1; j < inCell.length; j++) {
        const pair: [string, string] = [inCell[i], inCell[j]];
        const isDup = duplicatePairs.some(([a, bb]) =>
          (a === pair[0] && bb === pair[1]) || (a === pair[1] && bb === pair[0]));
        const isSib = siblingPairs.some(([a, bb]) =>
          (a === pair[0] && bb === pair[1]) || (a === pair[1] && bb === pair[0]));
        if (!isDup && !isSib) strangerPairs.push(pair);
      }
  }

  return { incidentId, duplicatePairs, siblingPairs, strangerPairs, cases };
}

// A merge, exactly as the panel performs one: reports move, the case is hidden,
// the survivor's index is rebuilt so reporter_count reflects the union.
async function merge(c: PoolClient, survivor: string, absorbed: string): Promise<boolean> {
  const alive = await c.query(
    `SELECT 1 FROM person_case WHERE id = ANY($1::uuid[]) AND merged_into IS NULL`,
    [[survivor, absorbed]]
  );
  if (alive.rowCount !== 2) return false;   // one of them is already merged away
  await c.query(`UPDATE report SET case_id = $1 WHERE case_id = $2`, [survivor, absorbed]);
  await c.query(
    `UPDATE person_case SET merged_into = $1, public_listed = false WHERE id = $2`,
    [survivor, absorbed]
  );
  await c.query(`SELECT public.refresh_person_index($1)`, [survivor]);
  return true;
}

async function unmergeAll(c: PoolClient, incidentId: string) {
  // Reports cannot be returned to their original case from here, so instead of
  // pretending to undo, each regime is measured from a SAVEPOINT and rolled back
  // to it. This function only exists for the "none" regime, which merges nothing.
  await c.query(
    `UPDATE person_case SET merged_into = NULL WHERE incident_id = $1 AND merged_into IS NOT NULL`,
    [incidentId]
  );
}

type Cells = Map<string, number>;

async function cellsOf(c: PoolClient, incidentId: string): Promise<Cells> {
  const rows = await c.query(
    `SELECT lat, lng, weight FROM public.heat_cells($1, 100)`, [incidentId]
  );
  const out: Cells = new Map();
  for (const row of rows.rows) {
    // Key on the snapped cell centre, rounded well below cell size.
    const k = `${Number(row.lat).toFixed(4)},${Number(row.lng).toFixed(4)}`;
    out.set(k, (out.get(k) ?? 0) + Number(row.weight));
  }
  return out;
}

// Spearman rho over the UNION of cells (a cell missing from one regime is a cell
// with zero weight there — that is exactly what "the map lost it" means).
function spearman(a: Cells, b: Cells): number {
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  if (keys.length < 3) return NaN;
  const rank = (m: Cells) => {
    const vals = keys.map((k) => m.get(k) ?? 0);
    const order = vals.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const ranks = new Array<number>(vals.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const avg = (i + j) / 2 + 1;                      // average rank for ties
      for (let k = i; k <= j; k++) ranks[order[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const ra = rank(a), rb = rank(b);
  const n = keys.length;
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

const topN = (m: Cells, n: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

const overlap = (a: string[], b: string[]) => {
  const s = new Set(b);
  return a.filter((k) => s.has(k)).length / Math.max(a.length, 1);
};

test("ablation: does a dedup failure change where teams are sent?", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  if (!RUN) return t.skip("set RANK_ABLATION=1 to run (it builds a population and merges it four ways)");
  await requireFreshSchema();

  const c = await pool.connect();
  const corruption = Number(process.env.RANK_CORRUPTION ?? 0.2);
  const TOP = Number(process.env.RANK_TOP ?? 20);
  try {
    // ONE transaction, always rolled back. Nothing this test does survives it:
    // the suite asserts globally that no case is ever merged without a human,
    // and that assertion must keep being true.
    await c.query("BEGIN");
    const built = await build(c, Number(process.env.RANK_SEED ?? 20260811));
    const { incidentId } = built;

    const r = rng(Number(process.env.RANK_SEED ?? 20260811) + 7);
    const sample = <T,>(arr: T[], frac: number) =>
      arr.filter(() => r() < frac);

    const regime = async (
      name: string,
      apply: () => Promise<{ merges: number; falseMerges: number }>
    ) => {
      await c.query("SAVEPOINT regime");
      const applied = await apply();
      const cells = await cellsOf(c, incidentId);
      const total = [...cells.values()].reduce((s, v) => s + v, 0);
      await c.query("ROLLBACK TO SAVEPOINT regime");
      return { name, cells, total, ...applied };
    };

    const mergeAll = async (pairs: [string, string][]) => {
      let n = 0;
      for (const [a, b] of pairs) if (await merge(c, a, b)) n++;
      return n;
    };

    const perfect = await regime("perfect", async () => ({
      merges: await mergeAll(built.duplicatePairs), falseMerges: 0,
    }));
    const none = await regime("none", async () => {
      await unmergeAll(c, incidentId);
      return { merges: 0, falseMerges: 0 };
    });
    const randomSample = sample(built.strangerPairs, corruption);
    const random20 = await regime("random20", async () => ({
      merges: await mergeAll(built.duplicatePairs),
      falseMerges: await mergeAll(randomSample),
    }));
    const siblingSample = sample(built.siblingPairs, corruption);
    const sibling20 = await regime("sibling20", async () => ({
      merges: await mergeAll(built.duplicatePairs),
      falseMerges: await mergeAll(siblingSample),
    }));

    const refTop = topN(perfect.cells, TOP);
    const heaviest = refTop[0];
    const report = [none, random20, sibling20].map((g) => ({
      regime: g.name,
      cells: g.cells.size,
      true_merges: g.merges,
      false_merges: g.falseMerges,
      spearman_vs_perfect: +spearman(perfect.cells, g.cells).toFixed(4),
      [`top${TOP}_overlap`]: +overlap(refTop, topN(g.cells, TOP)).toFixed(3),
      total_weight_ratio: +(g.total / perfect.total).toFixed(3),
      heaviest_cell_ratio: heaviest
        ? +((g.cells.get(heaviest) ?? 0) / (perfect.cells.get(heaviest) ?? 1)).toFixed(3)
        : null,
    }));

    console.log(JSON.stringify({
      msg: "heat-map ranking ablation",
      population: {
        cases: built.cases, cells_perfect: perfect.cells.size,
        duplicate_pairs: built.duplicatePairs.length,
        sibling_pairs: built.siblingPairs.length,
        stranger_pairs_in_same_cell: built.strangerPairs.length,
        corruption_fraction: corruption,
      },
      reference: "perfect (every true duplicate merged, nothing else)",
      regimes: report,
      how_to_read:
        "spearman ~1 and topN_overlap ~1 mean the dedup failure did not change " +
        "where teams are sent, and the pairwise metrics are the wrong thing to " +
        "optimise. A LOW sibling20 with a HIGH random20 means the damage is " +
        "specific: merging siblings flattens the cells with whole households " +
        "missing, which are the highest-priority cells on the map.",
    }, null, 2));

    // Measurement validity, not quality claims. Each of these failing means the
    // harness measured nothing and the printed numbers must not be quoted.
    assert.ok(perfect.cells.size >= 20,
      `only ${perfect.cells.size} cells — too few for a ranking claim`);
    assert.ok(built.duplicatePairs.length >= 10,
      `only ${built.duplicatePairs.length} true duplicate pairs in the population`);
    assert.ok(built.siblingPairs.length >= 10,
      `only ${built.siblingPairs.length} sibling pairs — the interesting regime is empty`);
    assert.ok(report[1].false_merges > 0 && report[2].false_merges > 0,
      "no corruption was actually applied; the two corrupted regimes are copies");
    // A corrupted map must not be IDENTICAL to the clean one — if it is, the
    // merges did not reach heat_cells() and the harness is broken.
    assert.ok(report[2].total_weight_ratio < 1,
      "sibling merges did not reduce total map weight; heat_cells is not seeing them");

    await c.query("ROLLBACK");
    const leftover = await c.query(
      `SELECT count(*)::int AS n FROM person_case WHERE merged_into IS NOT NULL`);
    assert.equal(Number(leftover.rows[0].n), 0,
      "the ablation left merged cases behind — the global no-auto-merge invariant is now false");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
});

test.after(async () => { await pool.end().catch(() => {}); });

// The two dedup defects that bias the map where severity is highest, pinned.
//
// Both are false-merge defects, and a false merge is the one error with no
// statistical consolation: heat_cells() and /buscar both filter
// merged_into IS NULL, so merging two children removes one of them from the
// search list. "The ranking barely moves" is an argument about the map; it says
// nothing to the family of the child who is no longer on the list.
//
//   F1  The engine scored the REPORTER's phone as the subject's, so any two
//       cases filed by one person got +0.15 AND escaped the -0.10 same-reporter
//       correction (it was gated on NOT phone_match). A parent reporting three
//       children was the worst-affected case and the most common one.
//
//   F2  A sibling was indistinguishable from a duplicate: name_tokens() sorts
//       away Spanish name structure and name_overlap() divides by the shorter
//       array, so shared surnames carried the score and a given-name
//       disagreement was invisible. Two brothers scored 0.72 with nothing to
//       contradict them.
//
// The static half of this file runs anywhere (it reads the migrations). The
// behavioural half needs a database and is skipped without DATABASE_URL —
// deliberately not silently: skipped is printed by node:test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "../src/db.js";
import { requireFreshSchema } from "./schema-freshness.js";

const HAVE_DB = !!process.env.DATABASE_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrations = path.join(root, "db/migrations");
const strip = (sql: string) =>
  sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const newestDefining = (fn: string) => {
  const files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
  const defining = files.filter((f) =>
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\b`).test(
      fs.readFileSync(path.join(migrations, f), "utf8")));
  assert.ok(defining.length, `${fn} must be defined in some migration`);
  const file = defining[defining.length - 1]!;
  return { file, sql: strip(fs.readFileSync(path.join(migrations, file), "utf8")) };
};

// ---------------------------------------------------------------------------
// Static: the shape of the fix cannot regress without this failing
// ---------------------------------------------------------------------------

test("the index never fills the subject's phone from the reporter's", () => {
  const { file, sql } = newestDefining("refresh_person_index");
  // The whole defect in one line: phone_e164 was aggregated from reporter_phone.
  assert.doesNotMatch(sql, /payload->>'reporter_phone'/,
    `${file}: refresh_person_index still reads the reporter's phone into the index`);
  assert.match(sql, /payload->>'subject_phone'/,
    `${file}: the subject phone must be the only source of person_index.phone_e164`);
});

test("the same-reporter penalty is no longer disabled by the bug it was meant to cover", () => {
  const { file, sql } = newestDefining("correlate_case");
  assert.doesNotMatch(sql, /reporter_overlap\s+AND\s+NOT\s+x?\.?phone_match/i,
    `${file}: the same-reporter correction is still gated on NOT phone_match, ` +
    `which F1 made permanently false for the same reporter`);
  assert.match(sql, /-\s*c\.w_reporter_overlap\s*\*\s*\(x\.reporter_overlap\)::int/,
    `${file}: the same-reporter penalty must apply unconditionally`);
});

test("the sibling term exists, is config-driven, and is published in the signals", () => {
  const { file, sql } = newestDefining("correlate_case");
  assert.match(sql, /-\s*c\.w_sibling_conflict\s*\*\s*\(x\.sibling_conflict\)::int/,
    `${file}: the sibling penalty must come from config, not a literal`);
  assert.match(sql, /'sibling_conflict'/,
    `${file}: an operator must be able to see WHY a pair was demoted`);
});

test("no scoring literals are left in the function body", () => {
  const { file, sql } = newestDefining("correlate_case");
  // The building bonus and the gender penalty were 0.05 and 0.25 inline while
  // every other weight lived in correlation_config. An operator cannot loosen a
  // literal at 3 a.m.
  const body = sql.slice(sql.indexOf("SELECT\n    x.case_id"));
  assert.doesNotMatch(body, /\+\s*0\.05\s*\*\s*\(x\.same_building\)/,
    `${file}: the building bonus must read from config`);
  assert.doesNotMatch(body, /-\s*0\.25\s*\*\s*\(x\.gender_conflict\)/,
    `${file}: the gender penalty must read from config`);
});

test("heat_cells bounds what one reporter can add to one cell", () => {
  const { file, sql } = newestDefining("heat_cells");
  assert.match(sql, /reporter_cell_cap/,
    `${file}: the per-reporter cap must come from heatmap_config`);
  assert.match(sql, /GROUP BY 1,\s*2/,
    `${file}: cells must be aggregated per reporter before being summed`);
  // The displayed case count must stay a count of cases. Capping a number an
  // operator reads as "how many people" would be lying to make the weight and
  // the label agree.
  assert.match(sql, /sum\(n\)::int/,
    `${file}: 'cases' must remain the true number of cases in the cell`);
});

// ---------------------------------------------------------------------------
// Behavioural: the pairs from docs/dedup-review.md, scored by the live engine
// ---------------------------------------------------------------------------

interface Fixture {
  full_name: string;
  gender?: string;
  age_approx?: number;
  reporter_phone?: string;
  subject_phone?: string | null;
  national_id_last4?: string | null;
  lat?: number;
  lng?: number;
  building_name?: string | null;
  hours_ago?: number;
}

const CENTRE = { lat: 5.6947, lng: -76.6611 };

async function fixtureIncident(name: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO incident (slug, name, country, ref_prefix, centre, public_expires_at)
     VALUES ($1,$2,'CO','FIX',
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, now() + interval '1 day')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, "adversarial fixture", CENTRE.lng, CENTRE.lat]
  );
  return rows[0].id;
}

let refCounter = 0;
async function addCase(incidentId: string, f: Fixture): Promise<string> {
  const payload: Record<string, unknown> = {
    full_name: f.full_name,
    gender: f.gender ?? "unknown",
    age_approx: f.age_approx ?? null,
    reporter_phone: f.reporter_phone ?? null,
    subject_phone: f.subject_phone ?? null,
    national_id_last4: f.national_id_last4 ?? null,
    last_seen_lat: f.lat ?? null,
    last_seen_lng: f.lng ?? null,
    location_accuracy: f.lat != null ? "building" : "unknown",
    location_source: f.lat != null ? "map_pick" : "none",
    building_name: f.building_name ?? null,
    last_contact_at: new Date(Date.now() - (f.hours_ago ?? 2) * 3600_000).toISOString(),
  };
  const rows = await query<{ id: string }>(
    `INSERT INTO person_case (incident_id, status, status_source, reference_number,
                              public_listed, consent_photo_public, is_minor)
     VALUES ($1,'missing','citizen',$2,true,false,false) RETURNING id`,
    [incidentId, `FIX-${process.pid}-${++refCounter}`]
  );
  const caseId = rows[0].id;
  await query(
    `INSERT INTO report (case_id, incident_id, channel, payload, reporter_phone_e164, submitted_at)
     VALUES ($1,$2,'pwa',$3,$4, now())`,
    [caseId, incidentId, JSON.stringify(payload),
     (f.reporter_phone ?? "").replace(/[^\d+]/g, "") || null]
  );
  await query(`SELECT public.refresh_person_index($1)`, [caseId]);
  return caseId;
}

async function scoreOf(a: string, b: string): Promise<{ score: number; signals: any }> {
  const rows = await query<{ score: number; signals: any }>(
    `SELECT score, signals FROM public.correlate_case($1) WHERE case_id = $2`, [a, b]
  );
  // A pair the engine never even scored is, for every purpose here, a pair it
  // did not propose. Reported as -Infinity so an assertion reads naturally.
  if (!rows.length) return { score: Number.NEGATIVE_INFINITY, signals: null };
  return { score: Number(rows[0].score), signals: rows[0].signals };
}

test("the adversarial pairs the engine used to get wrong", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  await requireFreshSchema();

  const cfg = (await query<{ auto_suggest_floor: number; lead_floor: number }>(
    `SELECT auto_suggest_floor, lead_floor FROM correlation_config WHERE id = 1`
  ))[0];
  const queueFloor = Number(cfg.auto_suggest_floor);
  const leadFloor = Number(cfg.lead_floor);

  const inc = await fixtureIncident(`fixture-dedup-${process.pid}-${Date.now()}`);
  const near = (m: number) => ({
    lat: CENTRE.lat + m / 111_320, lng: CENTRE.lng,
  });
  const parent = "+573001112233";
  const neighbourA = "+573004445566";
  const neighbourB = "+573007778899";
  const results: Record<string, unknown> = {};

  // --- 1. The false suggestion Nitzan reported: two Marías, different
  //        surnames, both entered by him. Scored 0.60 (queued) purely because
  //        the reporter's phone matched itself.
  const maria1 = await addCase(inc, {
    full_name: "María Gómez", gender: "f", age_approx: 30,
    reporter_phone: parent, building_name: "Edificio Aurora", ...near(0),
  });
  const maria2 = await addCase(inc, {
    full_name: "María Rojas", gender: "f", age_approx: 31,
    reporter_phone: parent, building_name: "Edificio Aurora", ...near(100),
  });
  const twoMarias = await scoreOf(maria1, maria2);
  results.two_marias = twoMarias.score;
  assert.ok(twoMarias.score < queueFloor,
    `two different women entered by one reporter reached the operator queue: ` +
    `${twoMarias.score.toFixed(3)} >= ${queueFloor}`);

  // --- 2. Siblings, same reporter. The parent reporting several children.
  const juan = await addCase(inc, {
    full_name: "Juan Pérez Gómez", gender: "m", age_approx: 9,
    reporter_phone: parent, building_name: "Torre Bolívar", ...near(300),
  });
  const ana = await addCase(inc, {
    full_name: "Ana Pérez Gómez", gender: "f", age_approx: 7,
    reporter_phone: parent, building_name: "Torre Bolívar", ...near(300),
  });
  const brotherSister = await scoreOf(juan, ana);
  results.brother_sister_same_reporter = brotherSister.score;
  assert.ok(brotherSister.score < leadFloor,
    `siblings from one reporter still reachable: ${brotherSister.score.toFixed(3)}`);

  // --- 3. TWO BROTHERS: no gender conflict, nothing to contradict them. This is
  //        the pair the gender penalty used to rescue us from by accident, and
  //        the one F1 alone does not fix when two different neighbours report.
  const carlos = await addCase(inc, {
    full_name: "Carlos Mosquera Rentería", gender: "m", age_approx: 11,
    reporter_phone: neighbourA, building_name: "Bloque 7 Ciudadela", ...near(600),
  });
  const diego = await addCase(inc, {
    full_name: "Diego Mosquera Rentería", gender: "m", age_approx: 13,
    reporter_phone: neighbourB, building_name: "Bloque 7 Ciudadela", ...near(600),
  });
  const brothers = await scoreOf(carlos, diego);
  results.two_brothers_two_reporters = brothers.score;
  assert.ok(brothers.score < queueFloor,
    `two brothers reported by two neighbours reached the queue: ` +
    `${brothers.score.toFixed(3)} >= ${queueFloor}`);
  if (brothers.signals) {
    assert.equal(brothers.signals.sibling_conflict, true,
      "the demotion must be attributed to the sibling rule, not to luck");
  }

  // --- 4. THE PROTECTED CASE: a real duplicate must survive all of the above.
  //        Two strangers describing the same woman, same spot, hours apart, one
  //        of them giving only one surname. If the sibling guard eats this, the
  //        fix has traded one failure for a worse one.
  const dupA = await addCase(inc, {
    full_name: "Luz Marina Palacios Córdoba", gender: "f", age_approx: 42,
    reporter_phone: neighbourA, building_name: "Residencias El Mirador",
    hours_ago: 1, ...near(900),
  });
  const dupB = await addCase(inc, {
    full_name: "Luz Marina Palacios", gender: "f", age_approx: 43,
    reporter_phone: neighbourB, building_name: "Residencias El Mirador",
    hours_ago: 4, ...near(920),
  });
  const dup = await scoreOf(dupA, dupB);
  results.true_duplicate_two_reporters = dup.score;
  assert.ok(dup.score >= queueFloor,
    `a real duplicate stopped reaching the queue: ${dup.score.toFixed(3)} < ${queueFloor}`);

  // --- 5. A one-character typo in the given name is a misspelling, NOT a
  //        sibling. This is the boundary given_conflict_sim defends, and the
  //        variant the seed produces most often.
  const typoA = await addCase(inc, {
    full_name: "María Fernanda Quinto Bejarano", gender: "f", age_approx: 25,
    reporter_phone: neighbourA, ...near(1200),
  });
  const typoB = await addCase(inc, {
    full_name: "Mría Fernanda Quinto Bejarano", gender: "f", age_approx: 25,
    reporter_phone: neighbourB, ...near(1210),
  });
  const typo = await scoreOf(typoA, typoB);
  results.typo_not_sibling = typo.score;
  assert.ok(typo.score >= queueFloor,
    `a misspelt given name was read as a different person: ${typo.score.toFixed(3)}`);
  if (typo.signals) {
    assert.notEqual(typo.signals.sibling_conflict, true,
      "a typo must not trigger the sibling rule");
  }

  // --- 6. An agreeing document number outranks any name argument: same person,
  //        one of the two names is simply wrong.
  const idA = await addCase(inc, {
    full_name: "Yeison Andrés Murillo Asprilla", gender: "m", age_approx: 19,
    national_id_last4: "4821", reporter_phone: neighbourA, ...near(1500),
  });
  const idB = await addCase(inc, {
    full_name: "Jeison Murillo Asprilla", gender: "m", age_approx: 20,
    national_id_last4: "4821", reporter_phone: neighbourB, ...near(1520),
  });
  const sameId = await scoreOf(idA, idB);
  results.same_document_number = sameId.score;
  if (sameId.signals) {
    assert.notEqual(sameId.signals.sibling_conflict, true,
      "an agreeing document number must suppress the sibling rule");
  }

  // --- 7. The subject's own phone, when the family knows it, is real evidence
  //        and must still count.
  const subjA = await addCase(inc, {
    full_name: "Nelson Ibargüen", gender: "m", age_approx: 35,
    subject_phone: "+573101234567", reporter_phone: neighbourA, ...near(1800),
  });
  const subjB = await addCase(inc, {
    full_name: "Nelson Ibargüen Mena", gender: "m", age_approx: 36,
    subject_phone: "+573101234567", reporter_phone: neighbourB, ...near(1830),
  });
  const subject = await scoreOf(subjA, subjB);
  results.subject_phone_pair = subject.score;
  assert.equal(subject.signals?.phone_match, true,
    "a matching SUBJECT phone must register as a phone match");

  // --- 8. And the mirror image: the same reporter filing twice must NOT
  //        register a phone match at all any more.
  const sameReporterA = await addCase(inc, {
    full_name: "Rosa Elena Klinger", gender: "f", age_approx: 60,
    reporter_phone: parent, ...near(2100),
  });
  const sameReporterB = await addCase(inc, {
    full_name: "Hernán Klinger", gender: "m", age_approx: 64,
    reporter_phone: parent, ...near(2100),
  });
  const sameReporter = await scoreOf(sameReporterA, sameReporterB);
  results.same_reporter_pair = sameReporter.score;
  if (sameReporter.signals) {
    assert.notEqual(sameReporter.signals.phone_match, true,
      "the reporter's phone is being scored as the subject's again");
    assert.equal(sameReporter.signals.reporter_overlap, true,
      "the same-reporter signal must still be recorded, just not rewarded");
  }

  console.log(JSON.stringify({
    msg: "adversarial fixture scores",
    queue_floor: queueFloor, lead_floor: leadFloor,
    scores: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, Number.isFinite(v as number)
        ? +(v as number).toFixed(3) : "not scored"])),
  }, null, 2));
});

// The cap has to hold against the shape it exists for: one family, one address,
// many reports. Measured through the real function, on real rows.
test("one reporter cannot manufacture a hotspot", async (t) => {
  if (!HAVE_DB) return t.skip("DATABASE_URL not set");
  await requireFreshSchema();

  const inc = await fixtureIncident(`fixture-heat-${process.pid}-${Date.now()}`);
  const cap = Number((await query<{ reporter_cell_cap: number }>(
    `SELECT reporter_cell_cap FROM heatmap_config WHERE id = 1`))[0].reporter_cell_cap);

  // Cell A: six cases, all from one phone. Cell B: six cases, six phones.
  // Same accuracy, same status, ~1.5 km apart so they cannot share a 100 m cell.
  const cellA = { lat: CENTRE.lat, lng: CENTRE.lng };
  const cellB = { lat: CENTRE.lat + 0.015, lng: CENTRE.lng };
  for (let i = 0; i < 6; i++) {
    await addCase(inc, {
      full_name: `Familia Uno Hijo${i}`, reporter_phone: "+573000000001",
      lat: cellA.lat, lng: cellA.lng,
    });
    await addCase(inc, {
      full_name: `Vecino Distinto Numero${i}`, reporter_phone: `+5731000000${10 + i}`,
      lat: cellB.lat, lng: cellB.lng,
    });
  }

  const cells = await query<{ lat: number; lng: number; weight: number; cases: number }>(
    `SELECT lat, lng, weight, cases FROM public.heat_cells($1, 100)`, [inc]
  );
  const nearest = (lat: number) =>
    cells.reduce((best, c) =>
      Math.abs(c.lat - lat) < Math.abs(best.lat - lat) ? c : best, cells[0]);
  const a = nearest(cellA.lat);
  const b = nearest(cellB.lat);

  console.log(JSON.stringify({
    msg: "per-reporter cell cap",
    cap,
    one_reporter: { weight: +Number(a.weight).toFixed(3), cases: a.cases },
    six_reporters: { weight: +Number(b.weight).toFixed(3), cases: b.cases },
  }));

  assert.equal(a.cases, 6, "the displayed case count must stay honest");
  assert.equal(b.cases, 6, "the displayed case count must stay honest");
  assert.ok(Number(a.weight) < Number(b.weight) * 0.75,
    `one reporter's six reports weigh ${Number(a.weight).toFixed(2)} against ` +
    `${Number(b.weight).toFixed(2)} for six independent reporters — the cap is not biting`);
  // sqrt(6) = 2.449 < cap 3.0, so the compression, not the ceiling, is what
  // limits this cell; the ceiling only matters past nine reports.
  assert.ok(Number(a.weight) <= Number(b.weight) / 6 * Math.min(Math.sqrt(6), cap) + 1e-6,
    "the capped weight exceeds mean x min(sqrt(n), cap)");
});

test.after(async () => { await pool.end().catch(() => {}); });

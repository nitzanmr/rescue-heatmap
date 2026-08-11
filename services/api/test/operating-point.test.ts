// The operating point is a claim we make out loud, so it has to be pinned in
// something that fails when it drifts. Three separate failures live here, and
// none of them needs a database:
//
//   1. A shortlist that is not deterministic. correlate_case() ordered only by
//      score, so two candidates with an equal score straddling the LIMIT swapped
//      places between calls. The same case then produced a different shortlist
//      on a re-run — which is both an unreproducible measurement and, worse, an
//      operator screen that changes when nothing changed.
//
//   2. A measurement engine that is not the production engine. The test called
//      correlate_case(case, 50) while the worker and the panel called it with
//      25. Every recall number we quoted came from a more generous engine than
//      the one that would run in the field, and the gap only opens where
//      duplicates actually cluster: a crowded building. The size now lives once
//      in correlation_config.candidate_limit and callers must not pass one.
//
//   3. Two bands that have crossed. A 'lead' exists precisely because it is
//      BELOW the queue floor; if lead_floor ever rises above
//      auto_suggest_floor, leads silently swallow the operator queue.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrations = path.join(root, "db/migrations");
const read = (p: string) => fs.readFileSync(p, "utf8");
const code = (sql: string) =>
  sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const newestDefining = (fn: string) => {
  const files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
  const defining = files.filter((f) =>
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`).test(read(path.join(migrations, f))));
  assert.ok(defining.length, `${fn} must be defined in some migration`);
  return { file: defining[defining.length - 1]!, sql: code(read(path.join(migrations, defining[defining.length - 1]!))) };
};

test("the newest correlate_case breaks score ties deterministically", () => {
  const { file, sql } = newestDefining("correlate_case");
  const orders = [...sql.matchAll(/ORDER BY\s+score DESC[^\n]*/gi)].map((m) => m[0]);
  assert.ok(orders.length, `${file}: correlate_case must order by score`);
  for (const o of orders) {
    // NULLS FIRST/LAST may sit between the direction and the tie break (0013
    // added NULLS LAST because DESC defaults to NULLS FIRST, which sorted
    // unscorable pairs to the top of every shortlist). The tie break itself is
    // what this test is about and it is still required.
    assert.match(o, /score DESC\s*(NULLS\s+(FIRST|LAST)\s*)?,\s*(x\.)?case_id/i,
      `${file}: "${o.trim()}" has no tie break — the shortlist is not reproducible`);
  }
});

test("the shortlist size comes from config, not from the caller", () => {
  const { file, sql } = newestDefining("correlate_case");
  assert.match(sql, /p_limit\s+int\s+DEFAULT\s+NULL/i,
    `${file}: p_limit must default to NULL so the config decides`);
  assert.match(sql, /COALESCE\(p_limit,\s*c\.candidate_limit\)/i,
    `${file}: the config's candidate_limit must be the fallback`);
});

// The measurement and the field must run the same engine. Any caller that
// passes a literal shortlist size re-opens the gap that made 0.725 look like an
// improvement when it was mostly a wider shortlist.
test("no caller hard-codes a shortlist size", () => {
  const roots = [
    path.join(root, "services/api/src"),
    path.join(root, "services/api/test"),
    path.join(root, "app/web/src"),
    migrations,
  ];
  const offenders: string[] = [];
  // Applied migrations are history and must never be edited: 0003 called it with
  // 25 and 0010 replaces the function. Only migrations from the newest
  // definition onwards describe the engine that runs today.
  const current = newestDefining("correlate_case").file;
  const self = path.basename(fileURLToPath(import.meta.url));
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(ts|tsx|sql)$/.test(e.name)) continue;
      if (e.name === self) continue;                       // this file names the offence
      if (dir === migrations && e.name < current) continue; // superseded history
      const text = code(read(p));
      // correlate_case($1, 25) — a literal second argument. The definition
      // itself (DEFAULT NULL) and config-driven calls are fine.
      for (const m of text.matchAll(/correlate_case\s*\(\s*[^)]*?,\s*(\d+)\s*\)/g)) {
        offenders.push(`${path.relative(root, p)}: correlate_case(..., ${m[1]})`);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [],
    `hard-coded shortlist size — production and measurement must agree:\n${offenders.join("\n")}`);
});

test("the two bands cannot cross, and the queue floor is the one hard number", () => {
  const sql = code(read(path.join(migrations, "0010_operating_point.sql")));
  assert.match(sql, /lead_floor\s*<=\s*auto_suggest_floor/i,
    "a lead must sit below the queue floor — enforce it in the schema, not in review");
  assert.match(sql, /auto_suggest_floor\s*=\s*0\.525/,
    "the operating point chosen from the curve is 0.525");
  assert.match(sql, /WHERE r\.score >= c\.lead_floor/i,
    "enqueue_correlations must record the lead band too");
  assert.match(sql, /THEN 'pending' ELSE 'lead' END/i,
    "only pairs above the queue floor may enter the operator queue");
});

test("a lead never enters the operator queue by default", () => {
  const panel = read(path.join(root, "services/api/src/routes/panel.ts"));
  assert.match(panel, /d\.state = COALESCE\(\$1,'pending'\)/,
    "the dedup queue must default to state='pending', excluding leads");
});

test("an undecided pair — lead or pending — is still decidable by a human", () => {
  const panel = read(path.join(root, "services/api/src/routes/panel.ts"));
  assert.match(panel, /\["pending", "lead"\]\.includes\(cand\.state\)/,
    "an operator who opens a lead must be able to act on it");
  assert.match(panel, /state IN \('pending','lead'\) AND \(a_case=\$1 OR b_case=\$1\)/,
    "a merge must supersede stale leads as well as stale suggestions");
});

// Phonetic matching is the only proposed answer to duplicate-vs-duplicate
// recall (0.41), and it is the kind of change that quietly buys recall with
// precision. It ships OFF; it is turned on for an ablation and compared on the
// same seed before anyone argues about it.
test("phonetic matching is off by default and capped below an exact match", () => {
  const sql = code(read(path.join(migrations, "0010_operating_point.sql")));
  assert.match(sql, /phonetic_enabled\s+boolean\s+NOT NULL DEFAULT false/i,
    "phonetic matching must default to off until an ablation says otherwise");
  assert.match(sql, /w_phonetic_cap\s+real\s+NOT NULL DEFAULT 0\.92/i,
    "phonetic agreement is evidence, not proof — it must be capped");
  assert.match(sql, /GREATEST\(x\.name_orth,\s*\n?\s*COALESCE\(x\.name_phon, 0\) \* c\.w_phonetic_cap\)/,
    "the phonetic measure must never outrank orthographic agreement");
});

// fuzzystrmatch is not installed everywhere and, like every other extension
// here, its schema is the provider's decision. A missing extension must leave
// the feature unavailable, not leave the database unmigrated.
test("a missing fuzzystrmatch does not break the migration", () => {
  const sql = code(read(path.join(migrations, "0010_operating_point.sql")));
  assert.match(sql, /EXCEPTION WHEN OTHERS THEN[\s\S]{0,200}fuzzystrmatch unavailable/i,
    "CREATE EXTENSION fuzzystrmatch must be guarded");
  assert.match(sql, /EXCEPTION WHEN undefined_function THEN/i,
    "phonetic_tokens must degrade to NULL when the extension is absent");
  assert.doesNotMatch(sql, /\bextensions\.dmetaphone\b/i,
    "never qualify an extension object by schema");
});

// Migrations are append-only. 0010 replaces functions; it must not edit the
// applied migrations that defined them.
test("0010 is append-only", () => {
  const sql = read(path.join(migrations, "0010_operating_point.sql"));
  assert.doesNotMatch(code(sql), /DROP FUNCTION|DROP TABLE|ALTER TABLE \w+ DROP COLUMN/i,
    "0010 must add and replace, never remove");
});

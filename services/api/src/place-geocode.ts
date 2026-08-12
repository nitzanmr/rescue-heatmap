// Look up the most-named structures, grade every answer, and write the graded
// suggestion next to the question — never into the answer.
//
//   # no database, no writes: what would we get for the top 30 structures?
//   npx tsx src/place-geocode.ts --file ../../data/external/ctb-full.ndjson --top 30
//
//   # against the queued nominations, writing candidates (still all pending):
//   npx tsx src/place-geocode.ts --incident quibdo-2026 --top 40 --load
//
// The file mode exists so the numbers can be argued about before anything is
// imported, and so a run costs the gazetteer 30 requests instead of 654.

import path from "node:path";
import fs from "node:fs";
import { clusterPlaces, type PlaceRow } from "./place-clusters.js";
import { placeOf } from "./place-nominate.js";
import { GeocodeCache, geocodeAll, type GeocodeCandidate } from "./geocode.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const arg = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const CACHE_FILE =
  process.env.GEOCODE_CACHE ?? path.resolve("../../data/external/geocode-cache.json");

function line(label: string, muni: string | null, count: number, c: GeocodeCandidate) {
  const where = muni ? `, ${muni}` : "";
  const point =
    c.lat !== null ? `${c.lat.toFixed(5)},${c.lng!.toFixed(5)}` : "—".padEnd(17);
  const why = c.reason ? `  (${c.reason})` : "";
  return `  ${String(count).padStart(4)}  ${c.precision.padEnd(6)} ${point}  ${label}${where}${why}`;
}

function summarise(rows: { count: number; c: GeocodeCandidate }[]) {
  const by = (p: string) => rows.filter((r) => r.c.precision === p);
  const people = (p: string) => by(p).reduce((n, r) => n + r.count, 0);
  console.log(`\ngrade        structures   people named`);
  for (const p of ["exact", "street", "area", "town", "none"]) {
    console.log(`  ${p.padEnd(9)} ${String(by(p).length).padStart(8)} ${String(people(p)).padStart(14)}`);
  }
  console.log(
    `\nOnly 'exact' is a structure a team could be sent to, and even that is a\n` +
      `suggestion attached to a question. Nothing here is on the map: a coordinate\n` +
      `reaches the map only through a signed human approval (migration 0015/0016).`
  );
}

async function fromFile(file: string, top: number) {
  const rows: PlaceRow[] = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = JSON.parse(l);
      return { id: r.source_id ?? String(i), place: placeOf(r), municipality: r.place_listing ?? null };
    });

  const clusters = clusterPlaces(rows).slice(0, top);
  console.log(`geocoding the ${clusters.length} most-named structures (cache: ${CACHE_FILE})\n`);
  const cache = new GeocodeCache(CACHE_FILE);
  const cands = await geocodeAll(
    // The readable spelling, not the identity key: a gazetteer parses this as
    // an address, and "cali cauca valle" is not one.
    clusters.map((c) => ({ label: c.label, municipality: c.municipalityLabel ?? c.municipality })),
    cache
  );
  clusters.forEach((c, i) =>
    console.log(line(c.label, c.municipalityLabel ?? c.municipality, c.count, cands[i]))
  );
  summarise(clusters.map((c, i) => ({ count: c.count, c: cands[i] })));
}

async function fromDatabase(incidentSlug: string, source: string, top: number, write: boolean) {
  const { query, one, pool } = await import("./db.js");
  const incident = await one<{ id: string }>(`SELECT id FROM incident WHERE slug = $1`, [
    incidentSlug,
  ]);
  if (!incident) throw new Error(`no incident with slug ${incidentSlug}`);

  const noms = await query<{
    id: string;
    label: string;
    municipality: string | null;
    case_count: number;
  }>(
    `SELECT id, label, municipality, case_count
       FROM place_nomination
      WHERE incident_id = $1 AND source = $2 AND status = 'pending'
      ORDER BY case_count DESC
      LIMIT $3`,
    [incident.id, source, top]
  );

  console.log(`geocoding ${noms.length} pending nominations (cache: ${CACHE_FILE})\n`);
  const cache = new GeocodeCache(CACHE_FILE);
  const cands = await geocodeAll(
    noms.map((n) => ({ label: n.label, municipality: n.municipality })),
    cache
  );
  noms.forEach((n, i) => console.log(line(n.label, n.municipality, n.case_count, cands[i])));
  summarise(noms.map((n, i) => ({ count: n.case_count, c: cands[i] })));

  if (!write) {
    console.log("\ndry run — nothing written. Pass --load to store the suggestions.");
    await pool.end();
    return;
  }

  // Candidates only. status stays 'pending', lat/lng (the signed columns) are
  // not touched: a suggestion must never be able to become a decision by
  // running a script twice.
  let n = 0;
  for (let i = 0; i < noms.length; i++) {
    const c = cands[i];
    await query(
      `UPDATE place_nomination
          SET cand_lat = $2, cand_lng = $3, cand_precision = $4, cand_label = $5,
              cand_category = $6, cand_rank = $7, cand_reason = $8, cand_query = $9,
              cand_provider = $10, cand_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [
        noms[i].id,
        c.lat,
        c.lng,
        c.precision,
        c.displayName,
        c.category && c.type ? `${c.category}/${c.type}` : c.category,
        c.placeRank,
        c.reason,
        c.query,
        c.provider,
      ]
    );
    n++;
  }
  console.log(`\nstored ${n} suggestions. All still pending: no coordinate is live.`);
  await pool.end();
}

async function main() {
  const top = Number(arg("top") ?? 30);
  const file = arg("file");
  if (file) return fromFile(path.resolve(file), top);
  const incident = arg("incident");
  if (!incident) throw new Error("--incident <slug> is required (or use --file)");
  await fromDatabase(incident, arg("source") ?? "colombiatebusca", top, has("load"));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

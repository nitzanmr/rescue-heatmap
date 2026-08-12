// Turn classified place text into a queue of questions for a person.
//
// Two jobs, on purpose separable:
//
//   1. BACKFILL. Write the classifier's verdict onto external_case
//      (place_text / place_resolution / place_eligible). Rows imported before
//      migration 0015 carry the verdict only inside report.payload JSON, where
//      it cannot be grouped or counted. This re-reads their stored source
//      payload — it does NOT re-scrape the site. Nobody's server is touched to
//      answer a question we can answer from what we already hold.
//
//   2. NOMINATE. Group the eligible lines into named structures and upsert one
//      pending nomination per structure. A nomination is a question, not a
//      coordinate: `place_nomination` cannot hold lat/lng in 'pending', and the
//      map reads only `approved_place`, which requires a signature and a date.
//
// Dry run is the default. `--load` writes. `--file` works with no database at
// all, so the numbers can be checked before anyone imports anything.
//
//   npx tsx src/place-nominate.ts --file ../../data/external/ctb-full.ndjson
//   npx tsx src/place-nominate.ts --load --incident quibdo-2026 --source colombiatebusca

import fs from "node:fs";
import path from "node:path";
import { classifyPlace } from "./place-resolution.js";
import { clusterPlaces, type PlaceRow, type PlaceCluster } from "./place-clusters.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const arg = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The shape both the harvested file and the stored source payload share. */
type Rec = {
  source_id?: string;
  place?: string | null;
  place_detail?: string | null;
  last_seen_text?: string | null;
  place_listing?: string | null;
};

export function placeOf(r: Rec): string | null {
  return r.place ?? r.place_detail ?? r.last_seen_text ?? r.place_listing ?? null;
}

function report(clusters: PlaceCluster[], eligible: number, total: number) {
  const crowded = clusters.filter((c) => c.count >= 3);
  console.log(`rows                 ${total}`);
  console.log(`geocodable lines     ${eligible}`);
  console.log(`distinct structures  ${clusters.length}`);
  console.log(`named by 3+ people   ${crowded.length}`);
  console.log(`\ntop structures (a human minute each, biggest first)`);
  for (const c of clusters.slice(0, 20)) {
    const where = c.municipality ? `, ${c.municipality}` : "";
    const folded = c.variants.length > 1 ? `   [folded: ${c.variants.slice(0, 4).join(" | ")}]` : "";
    console.log(`  ${String(c.count).padStart(4)}  ${c.label}${where}${folded}`);
  }
  console.log(
    `\nNothing above is on the map. Each line is a question — "is this one` +
      ` structure, and where exactly?" — and only a signed approval answers it.`
  );
}

function fromFile(file: string) {
  const rows: Rec[] = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Rec);

  const placeRows: PlaceRow[] = rows.map((r, i) => ({
    id: r.source_id ?? String(i),
    place: placeOf(r),
    municipality: r.place_listing ?? null,
  }));
  const eligible = placeRows.filter((r) => classifyPlace(r.place).eligible).length;
  report(clusterPlaces(placeRows), eligible, rows.length);
}

async function fromDatabase(source: string, incidentSlug: string, write: boolean) {
  const { query, one, tx, pool } = await import("./db.js");

  const incident = await one<{ id: string }>(
    `SELECT id FROM incident WHERE slug = $1`,
    [incidentSlug]
  );
  if (!incident) throw new Error(`no incident with slug ${incidentSlug}`);

  const rows = await query<{ case_id: string; source_payload: Rec }>(
    `SELECT ec.case_id, ec.source_payload
       FROM external_case ec
       JOIN person_case pc ON pc.id = ec.case_id
      WHERE ec.source = $1
        AND pc.incident_id = $2
        AND pc.merged_into IS NULL`,
    [source, incident.id]
  );

  const placeRows: PlaceRow[] = rows.map((r) => ({
    id: r.case_id,
    place: placeOf(r.source_payload ?? {}),
    municipality: r.source_payload?.place_listing ?? null,
  }));
  const eligible = placeRows.filter((r) => classifyPlace(r.place).eligible).length;
  const clusters = clusterPlaces(placeRows);
  report(clusters, eligible, rows.length);

  if (!write) {
    console.log("\ndry run — nothing written. Pass --load to backfill and queue.");
    await pool.end();
    return;
  }

  // 1. Backfill the verdict, one statement per case. Idempotent: re-running
  //    rewrites the same answer, and a re-harvest that changes the text changes
  //    the verdict with it.
  let backfilled = 0;
  for (const r of placeRows) {
    const v = classifyPlace(r.place);
    await query(
      `UPDATE external_case
          SET place_text = $3, place_resolution = $4, place_eligible = $5
        WHERE source = $1 AND case_id = $2`,
      [source, r.id, r.place, v.resolution, v.eligible]
    );
    backfilled++;
  }
  console.log(`\nclassified ${backfilled} imported cases`);

  // 2. Upsert nominations. A decision already taken is never asked again: the
  //    unique key is the cluster identity, and an existing row keeps its status,
  //    its coordinate and its signature. Only the count and the variant list
  //    move, because more people naming the same structure is new information
  //    and a reviewer should see it.
  let created = 0;
  let updated = 0;
  for (const c of clusters) {
    await tx(async (client) => {
      const existing = await client.query(
        `SELECT id, status FROM place_nomination
          WHERE incident_id = $1 AND source = $2 AND cluster_key = $3`,
        [incident.id, source, c.key]
      );
      let id: string;
      if (existing.rowCount) {
        id = existing.rows[0].id;
        await client.query(
          `UPDATE place_nomination
              SET label = $2, municipality = $3, variants = $4,
                  case_count = $5, updated_at = now()
            WHERE id = $1`,
          [id, c.label, c.municipality, c.variants, c.count]
        );
        updated++;
      } else {
        const ins = await client.query(
          `INSERT INTO place_nomination
             (incident_id, source, cluster_key, label, municipality, variants, case_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [incident.id, source, c.key, c.label, c.municipality, c.variants, c.count]
        );
        id = ins.rows[0].id;
        created++;
      }
      // Membership is replaced wholesale: a case whose text changed must stop
      // being counted under the old structure, or an approval silently covers a
      // row it was never granted for.
      await client.query(`DELETE FROM place_nomination_case WHERE nomination_id = $1`, [id]);
      for (const caseId of c.ids) {
        const text = placeRows.find((p) => p.id === caseId)?.place ?? "";
        await client.query(
          `INSERT INTO place_nomination_case (nomination_id, case_id, place_text)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, caseId, text]
        );
      }
    });
  }
  console.log(`nominations: ${created} new, ${updated} refreshed, all pending review`);
  await pool.end();
}

async function main() {
  const file = arg("file");
  const source = arg("source") ?? "colombiatebusca";
  if (file) return fromFile(path.resolve(file));
  const incident = arg("incident");
  if (!incident) throw new Error("--incident <slug> is required (or use --file)");
  await fromDatabase(source, incident, has("load"));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// CLI: pull aid sites from OpenStreetMap, and/or load a GeoJSON file into the
// database. Two separate steps on purpose — the file is reviewed by a human
// between them, and it is committed to the repo so an activation with no
// outbound internet still has the layer.
//
//   npm run aid-sites -- --bbox 5.55,-76.80,5.85,-76.55 --out ../../data/aid-sites/quibdo.geojson
//   npm run aid-sites -- --file ../../data/aid-sites/quibdo.geojson --country CO --load
//
// Loading never overwrites a human. A row somebody verified in the field keeps
// its name, status and phone; only geometry and provenance are refreshed.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fetchOverpass, fromGeoJSONFile, toGeoJSON, type AidSite, type BBox } from "./aid-sites.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function parseBBox(s: string): BBox {
  const [south, west, north, east] = s.split(",").map(Number);
  if ([south, west, north, east].some((n) => !Number.isFinite(n))) {
    throw new Error("--bbox expects south,west,north,east");
  }
  return { south, west, north, east };
}

async function load(sites: AidSite[], country: string, incidentSlug?: string) {
  // Imported lazily: pulling a bbox to a file must not require a database.
  const { query, one, pool } = await import("./db.js");

  let incidentId: string | null = null;
  if (incidentSlug) {
    const row = await one<{ id: string }>(`SELECT id FROM incident WHERE slug = $1`, [incidentSlug]);
    if (!row) throw new Error(`no incident with slug ${incidentSlug}`);
    incidentId = row.id;
  }

  let inserted = 0;
  let updated = 0;
  for (const s of sites) {
    const res = await query<{ created: boolean }>(
      `INSERT INTO aid_site (incident_id, country_code, kind, name, geom, address, phone,
                             capacity, source, source_ref, source_url)
       VALUES ($1, upper($2), $3, $4, ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography,
               $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
         geom       = EXCLUDED.geom,
         source_url = EXCLUDED.source_url,
         -- Field verification outranks the import. Silently replacing a name a
         -- liaison corrected on the ground is how a map starts lying quietly.
         name       = CASE WHEN aid_site.verified_at IS NULL THEN EXCLUDED.name ELSE aid_site.name END,
         address    = CASE WHEN aid_site.verified_at IS NULL THEN EXCLUDED.address ELSE aid_site.address END,
         phone      = CASE WHEN aid_site.verified_at IS NULL THEN EXCLUDED.phone ELSE aid_site.phone END,
         updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [
        incidentId,
        country,
        s.kind,
        s.name,
        s.lat,
        s.lng,
        s.address ?? null,
        s.phone ?? null,
        s.capacity ?? null,
        s.source,
        s.source_ref ?? null,
        s.source_url ?? null,
      ]
    );
    if (res[0]?.created) inserted++;
    else updated++;
  }
  await pool.end();
  return { inserted, updated };
}

async function main() {
  const bbox = arg("bbox");
  const file = arg("file");
  const out = arg("out");
  const country = arg("country") ?? "CO";

  let sites: AidSite[];
  if (bbox) {
    sites = await fetchOverpass(parseBBox(bbox));
    console.log(`overpass: ${sites.length} sites`);
  } else if (file) {
    sites = fromGeoJSONFile(path.resolve(file));
    console.log(`file: ${sites.length} sites`);
  } else {
    console.error("usage: --bbox s,w,n,e [--out file.geojson] | --file file.geojson [--load]");
    process.exit(2);
  }

  const counts = sites.reduce<Record<string, number>>((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});
  console.log("by kind:", counts);

  if (out) {
    writeFileSync(path.resolve(out), JSON.stringify(toGeoJSON(sites), null, 1) + "\n");
    console.log(`wrote ${out}`);
  }
  if (has("load")) {
    const r = await load(sites, country, arg("incident"));
    console.log(`loaded: ${r.inserted} new, ${r.updated} refreshed`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

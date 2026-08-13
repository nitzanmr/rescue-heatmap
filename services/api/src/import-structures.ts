// CLI: load a target dossier's STRUCTURES into the database.
//
//   npm run import-structures -- --file ../../data/cali-structures.json \
//        --incident cali-2026 --actor "avishai" [--link-nominations] [--dry-run]
//
// WHY THIS EXISTS
//   The Cali dossier was assembled outside the product — a registry of seven
//   buildings and a tracker of 136 anchor names — because a team lands in 48
//   hours and the database had no concept of a building. 0018 gave it one. This
//   script is the bridge, and the reason the outside copy can be deleted rather
//   than maintained in parallel. Two sources of truth during an event is the
//   worst outcome available: one of them is always the stale one, and nobody
//   knows which.
//
// WHAT IT REFUSES TO DO
//   · It does not import a point without a grade and a signer. `--actor` is
//     mandatory for exactly this reason: someone's name goes on every pin.
//   · It does not upgrade precision. A point the dossier calls "barrio" is
//     loaded as 'area', which project_structure_point() then refuses to push
//     onto people. That refusal is the feature.
//   · It never overwrites a point a person already placed through the panel:
//     an operator pin outranks a re-run of an import.
import { readFileSync } from "node:fs";
import path from "node:path";

interface DossierStructure {
  slug: string;
  structure_name: string;
  address?: string | null;
  barrio?: string | null;
  municipality?: string | null;
  lat?: number | null;
  lon?: number | null;
  lng?: number | null;
  /** Dossier vocabulary, Spanish or English. Mapped below, never guessed. */
  precision?: string | null;
  point_source?: string | null;
  scan_status?: string | null;
  verified_with_authorities?: string | null;
  notes?: string | null;
}

// The dossier and the schema must use one vocabulary. Anything unrecognised is
// an error, not a default: silently degrading an unknown word to 'area' would
// put a building-grade pin behind a refusal, and silently promoting it would do
// something far worse.
const PRECISION: Record<string, "building" | "street" | "area" | "town"> = {
  edificio: "building", estructura: "building", building: "building",
  calle: "street", street: "street", via: "street",
  barrio: "area", area: "area", comuna: "area", sector: "area",
  ciudad: "town", town: "town", municipio: "town",
};

const SCAN: Record<string, string> = {
  "not-scanned": "not_scanned", not_scanned: "not_scanned",
  "in-progress": "in_progress", in_progress: "in_progress",
  partial: "partial", clear: "clear", unsafe: "unsafe", unreachable: "unreachable",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const file = arg("file");
  const slug = arg("incident");
  const actor = arg("actor");
  const dry = has("dry-run");
  if (!file) throw new Error("--file <dossier.json> is required");
  if (!actor) {
    throw new Error("--actor <name> is required: every point carries the name of whoever placed it");
  }

  const raw = JSON.parse(readFileSync(path.resolve(file), "utf8")) as
    DossierStructure[] | { structures: DossierStructure[] };
  const rows = Array.isArray(raw) ? raw : raw.structures;
  if (!Array.isArray(rows)) throw new Error("expected an array of structures");

  // A dry run validates the dossier and touches no database: the first thing
  // anyone does with a file from outside the product is check it, and that must
  // not require Postgres to be up.
  const db = dry ? null : await import("./db.js");

  const inc = db
    ? await db.one<{ id: string }>(
        slug
          ? `SELECT id FROM incident WHERE slug = $1`
          : `SELECT id FROM incident WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        slug ? [slug] : []
      )
    : { id: "00000000-0000-0000-0000-000000000000" };
  if (!inc) throw new Error(`no incident${slug ? ` with slug ${slug}` : ""}`);

  let loaded = 0;
  let pinned = 0;
  let linked = 0;

  for (const r of rows) {
    if (!r.slug || !r.structure_name) throw new Error(`row without slug/structure_name: ${JSON.stringify(r)}`);
    const lat = r.lat ?? null;
    const lng = r.lng ?? r.lon ?? null;
    const precRaw = (r.precision ?? "").toString().trim().toLowerCase();
    const prec = precRaw && precRaw !== "none" ? PRECISION[precRaw] : undefined;
    if (precRaw && precRaw !== "none" && !prec) {
      throw new Error(`unknown precision "${r.precision}" on ${r.slug} — map it explicitly or fix the dossier`);
    }
    const scan = SCAN[(r.scan_status ?? "not-scanned").toString().trim()] ?? "not_scanned";
    if (scan === "clear") {
      // A dossier row must not be able to declare a building searched. That
      // sentence is signed on the panel, against the people actually inside it.
      throw new Error(`${r.slug}: an import may not mark a structure clear`);
    }
    const authority = (r.verified_with_authorities ?? "no").toString().toLowerCase() === "yes"
      ? "confirmed" : "unverified";

    // A point arrives only when it has both a coordinate and a grade.
    const withPoint = lat != null && lng != null && !!prec;

    if (dry) {
      console.log(`${r.slug}\t${r.structure_name}\t${prec ?? "no-point"}\t${scan}`);
      loaded++;
      if (withPoint) pinned++;
      continue;
    }

    const { query, one } = db!;
    const row = await one<{ id: string; pinned: boolean }>(
      `INSERT INTO structure (incident_id, key, name, address_text, neighbourhood,
                              municipality, authority_status, note,
                              lat, lng, point_precision, point_source, point_set_by, point_set_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               $9,$10,$11,$12,
               CASE WHEN $9::double precision IS NULL THEN NULL ELSE $13 END,
               CASE WHEN $9::double precision IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (incident_id, key) DO UPDATE SET
         name          = EXCLUDED.name,
         address_text  = COALESCE(EXCLUDED.address_text, structure.address_text),
         neighbourhood = COALESCE(EXCLUDED.neighbourhood, structure.neighbourhood),
         municipality  = COALESCE(EXCLUDED.municipality, structure.municipality),
         -- An operator's pin outranks a re-run of the import, always.
         lat             = CASE WHEN structure.point_source = 'operator_pin' THEN structure.lat ELSE EXCLUDED.lat END,
         lng             = CASE WHEN structure.point_source = 'operator_pin' THEN structure.lng ELSE EXCLUDED.lng END,
         point_precision = CASE WHEN structure.point_source = 'operator_pin' THEN structure.point_precision ELSE EXCLUDED.point_precision END,
         point_source    = CASE WHEN structure.point_source = 'operator_pin' THEN structure.point_source ELSE EXCLUDED.point_source END,
         point_set_by    = CASE WHEN structure.point_source = 'operator_pin' THEN structure.point_set_by ELSE EXCLUDED.point_set_by END,
         point_set_at    = CASE WHEN structure.point_source = 'operator_pin' THEN structure.point_set_at ELSE now() END
       RETURNING id, (lat IS NOT NULL) AS pinned`,
      [inc.id, r.slug, r.structure_name, r.address ?? null, r.barrio ?? null,
       r.municipality ?? null, authority, r.notes ?? null,
       withPoint ? lat : null, withPoint ? lng : null, withPoint ? prec : null,
       // No point, no provenance for one: a source string next to a NULL
       // coordinate is a claim about nothing.
       withPoint ? (r.point_source ?? "import") : null, `import:${actor}`]
    );
    loaded++;
    if (row?.pinned) pinned++;

    await query(
      `INSERT INTO structure_event (structure_id, kind, to_value, actor, note)
       VALUES ($1,'created',$2,$3,$4)`,
      [row!.id, JSON.stringify({ key: r.slug, precision: prec ?? null, source: file }),
       `import:${actor}`, "loaded from target dossier"]
    );

    // Attach the people. The link comes from the place-nomination fold (0015),
    // which already knows which imported cases named this structure — rather
    // than re-matching strings here, where a second, differently-wrong matcher
    // would quietly disagree with the first.
    if (has("link-nominations")) {
      const res = await query<{ case_id: string }>(
        `INSERT INTO structure_case (structure_id, case_id, link_source, confidence)
         SELECT $1, pnc.case_id, 'nomination', 'reported'
           FROM place_nomination pn
           JOIN place_nomination_case pnc ON pnc.nomination_id = pn.id
           JOIN person_case pc ON pc.id = pnc.case_id
          WHERE pn.incident_id = $2
            AND pc.merged_into IS NULL
            AND (pn.cluster_key = $3
                 OR public.name_norm(pn.label) = public.name_norm($4))
         ON CONFLICT (structure_id, case_id) DO NOTHING
         RETURNING case_id`,
        [row!.id, inc.id, r.slug, r.structure_name]
      );
      linked += res.length;
    }
  }

  console.log(
    `${dry ? "[dry-run] " : ""}structures: ${loaded}, with a point: ${pinned}` +
    (has("link-nominations") ? `, people linked: ${linked}` : "")
  );
  if (pinned < loaded) {
    console.log(
      `${loaded - pinned} structure(s) have no point. They are on the board and ` +
      `explicitly say "place it by hand" — they are not silently missing.`
    );
  }
  if (db) await db.pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

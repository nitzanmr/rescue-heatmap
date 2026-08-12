// CLI: load a harvested external registry (NDJSON) into the database.
//
// Two steps on purpose, exactly like import-aid-sites.ts: a scraper writes a
// file, a human looks at the file, and only then does anything reach Postgres.
// The harvester lives outside this service (ops/scrape/colombiatebusca.py)
// because pulling a public website is not the API's job.
//
//   npm run import-external -- --file ../../data/external/ctb-full.ndjson \
//                              --source colombiatebusca --incident sismo-choco --dry-run
//   npm run import-external -- --file ... --source colombiatebusca --incident sismo-choco --load
//
// THREE RULES THIS FILE ENFORCES, AND WHY
//
//   1. An imported case with no coordinate is not on the map, and says so.
//      The source publishes "Pereira, Risaralda" — a municipality, not a point.
//      Dropping a municipality centroid onto the heat map would invent a hot
//      cell out of nothing and send a team to a plaza. Imported rows land in
//      the same unmapped queue our own address-only reports land in, with
//      location_source 'none', until somebody geocodes them properly.
//
//   2. An imported case never carries a reporter phone.
//      Not because the site hides it (it does), but because our dedup engine
//      penalises same-reporter pairs, and a NULL there is honest while a
//      fabricated one is not.
//
//   3. Re-running updates; it does not duplicate.
//      Keyed on (source, source_ref). Their status changes are recorded in
//      external_case, and only propagate to ours when --adopt-status is passed:
//      a foreign site saying "localizada" is evidence, not a command.
import fs from "node:fs";
import path from "node:path";

type Rec = {
  source_id: string;
  source_code?: string | null;
  source_url?: string | null;
  name?: string | null;
  status?: string | null;
  category?: string | null;
  age?: number | null;
  sex?: string | null;
  place_listing?: string | null;
  last_seen_text?: string | null;
  registered_at_text?: string | null;
  [k: string]: unknown;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

// "12 Aug. 2026, 12:49 am" / "12/08/2026 12:49 AM" -> ISO, or null.
// A date we cannot parse becomes null rather than now(): a wrong timestamp on a
// missing-person record is worse than an absent one, because "last seen" drives
// how a team prioritises.
export function parseSourceDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (dmy) {
    let h = Number(dmy[4]);
    const ap = dmy[6]?.toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return `${dmy[3]}-${dmy[2]}-${dmy[1]}T${String(h).padStart(2, "0")}:${dmy[5]}:00-05:00`;
  }
  const MON: Record<string, string> = {
    ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
    jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12",
    jan: "01", apr: "04", aug: "08", dec: "12",
  };
  const txt = s.match(/^(\d{1,2})\s+([A-Za-zé]{3})\.?\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (txt) {
    const mon = MON[txt[2].slice(0, 3).toLowerCase()];
    if (!mon) return null;
    let h = Number(txt[4]);
    if (txt[6].toLowerCase() === "pm" && h < 12) h += 12;
    if (txt[6].toLowerCase() === "am" && h === 12) h = 0;
    return `${txt[3]}-${mon}-${String(txt[1]).padStart(2, "0")}T${String(h).padStart(2, "0")}:${txt[5]}:00-05:00`;
  }
  return null;
}

// Their vocabulary is not ours, and ours is narrower: person_case_status_chk
// admits missing | trapped_alive | found_safe | found_injured | deceased |
// withdrawn. Their "Localizada" means only "no longer being looked for", so it
// maps to found_safe and nothing else. Anything unrecognised stays 'missing' —
// the safe direction, because a wrongly-found person stops being searched for.
export function mapStatus(s: string | null | undefined): "missing" | "found_safe" {
  return s === "found" || s === "localizada" || s === "Localizada" ? "found_safe" : "missing";
}

export function toPayload(r: Rec, source: string): Record<string, unknown> {
  return {
    // Shaped like an intake payload so correlation and the panel need no special
    // case, but every field that would imply we spoke to a family is absent.
    channel: "import",
    full_name: r.name ?? null,
    age_approx: typeof r.age === "number" ? r.age : null,
    sex: r.sex === "masculino" ? "M" : r.sex === "femenino" ? "F" : null,
    // Address text only. No lat/lng: see rule 1 at the top of this file.
    address_text: r.last_seen_text ?? r.place_listing ?? null,
    municipality: r.place_listing ?? null,
    location_accuracy: "unknown",
    reporter_phone: null,
    subject_phone: null,
    external: {
      source,
      code: r.source_code ?? null,
      url: r.source_url ?? null,
      category: r.category ?? null,
      registered_at: parseSourceDate(r.registered_at_text),
    },
  };
}

function read(file: string): Rec[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Rec);
}

function summarise(rows: Rec[]) {
  const by = (f: (r: Rec) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log(`records            ${rows.length}`);
  console.log(`no name            ${rows.filter((r) => !r.name).length}`);
  console.log(`no age             ${rows.filter((r) => r.age == null).length}`);
  console.log(`no place at all    ${rows.filter((r) => !r.place_listing && !r.last_seen_text).length}`);
  console.log(`status             ${JSON.stringify(by((r) => String(r.status)))}`);
  console.log(`category (top 5)   ${JSON.stringify(by((r) => String(r.category)).slice(0, 5))}`);
  console.log(`place (top 5)      ${JSON.stringify(by((r) => String(r.place_listing)).slice(0, 5))}`);
}

async function load(rows: Rec[], source: string, incidentSlug: string, adoptStatus: boolean) {
  const { query, one, tx, pool } = await import("./db.js");
  const { newReference } = await import("./security.js");

  const incident = await one<{ id: string; ref_prefix: string }>(
    `SELECT id, ref_prefix FROM incident WHERE slug = $1`,
    [incidentSlug]
  );
  if (!incident) throw new Error(`no incident with slug ${incidentSlug}`);

  let created = 0;
  let refreshed = 0;
  let statusChanged = 0;

  for (const r of rows) {
    const existing = await one<{ case_id: string }>(
      `SELECT case_id FROM external_case WHERE source = $1 AND source_ref = $2`,
      [source, r.source_id]
    );

    if (existing) {
      await query(
        `UPDATE external_case
            SET source_status = $3, source_payload = $4, source_synced_at = now()
          WHERE source = $1 AND source_ref = $2`,
        [source, r.source_id, r.status ?? null, JSON.stringify(r)]
      );
      if (adoptStatus && mapStatus(r.status) === "found_safe") {
        // status_source records that this did not come from us. An operator
        // looking at a resolved case must be able to see whose word it is.
        const res = await query(
          `UPDATE person_case SET status = 'found_safe', status_source = $2
            WHERE id = $1 AND status = 'missing'
          RETURNING id`,
          [existing.case_id, `external:${source}`]
        );
        statusChanged += res.length;
      }
      refreshed++;
      continue;
    }

    await tx(async (c) => {
      let ref = "";
      for (let i = 0; i < 8 && !ref; i++) {
        const candidate = newReference(incident.ref_prefix);
        const clash = await c.query(
          `SELECT 1 FROM person_case WHERE incident_id = $1 AND reference_number = $2`,
          [incident.id, candidate]
        );
        if (!clash.rowCount) ref = candidate;
      }
      if (!ref) throw new Error("could not allocate a reference number in 8 attempts");

      const isMinor = typeof r.age === "number" ? r.age < 18 : null;
      const cs = await c.query(
        `INSERT INTO person_case (incident_id, status, status_source, reference_number,
                                  public_listed, consent_photo_public, is_minor, source)
         VALUES ($1,$2,$3,$4,false,false,$5,$6) RETURNING id`,
        // public_listed = false: we hold no consent to republish somebody else's
        // registry entry on our public search. It counts toward the map; it does
        // not get a second public poster with our name on it.
        [incident.id, mapStatus(r.status), `external:${source}`, ref, isMinor, source]
      );
      const caseId: string = cs.rows[0].id;

      const payload = toPayload(r, source);
      await c.query(
        `INSERT INTO report (case_id, incident_id, channel, payload, source_ref, submitted_at)
         VALUES ($1,$2,'import',$3,$4, COALESCE($5::timestamptz, now()))`,
        [caseId, incident.id, JSON.stringify(payload), `${source}:${r.source_id}`,
         parseSourceDate(r.registered_at_text)]
      );
      await c.query(
        `INSERT INTO external_case (case_id, source, source_ref, source_code, source_url,
                                    source_status, source_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [caseId, source, r.source_id, r.source_code ?? null, r.source_url ?? null,
         r.status ?? null, JSON.stringify(r)]
      );
      await c.query(`SELECT public.refresh_person_index($1)`, [caseId]);
      created++;
    });
  }

  console.log(`created ${created}, refreshed ${refreshed}, status adopted ${statusChanged}`);
  // Correlation is queued rather than run inline: importing 4,000 rows must not
  // block on scoring 4,000 x N pairs, and the worker already knows how.
  const q = await query<{ n: number }>(
    `INSERT INTO job (kind, payload, dedupe_key)
     SELECT 'correlate', jsonb_build_object('case_id', ec.case_id), 'correlate:' || ec.case_id
       FROM external_case ec
       JOIN person_case pc ON pc.id = ec.case_id
      WHERE ec.source = $1 AND pc.merged_into IS NULL
     ON CONFLICT (dedupe_key) WHERE done_at IS NULL AND dedupe_key IS NOT NULL
     DO NOTHING
     RETURNING 1 AS n`,
    [source]
  );
  console.log(`queued ${q.length} correlation jobs`);
  await pool.end();
}

async function main() {
  const file = arg("file");
  const source = arg("source") ?? "colombiatebusca";
  const incident = arg("incident");
  if (!file) throw new Error("--file is required");
  const rows = read(path.resolve(file));

  summarise(rows);
  if (!has("load")) {
    console.log("\ndry run — nothing written. Pass --load (with --incident <slug>) to import.");
    return;
  }
  if (!incident) throw new Error("--incident <slug> is required with --load");
  await load(rows, source, incident, has("adopt-status"));
}

// Importing this module for its pure helpers must not run the CLI.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

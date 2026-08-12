// Synthetic incident with KNOWN duplicates.
//
// This file exists for one reason: the weights in correlation_config are a guess
// until something measures them. It generates a population of cases plus
// deliberate near-duplicates that mimic how real reports actually differ —
// Spanish naming (two given names + two surnames, reordered, accents dropped),
// GPS scatter around the same building, partially remembered phone numbers,
// age off by a couple of years, reports hours apart.
//
// Ground truth is written to `seed_truth` so the correlation test can compute
// precision and recall instead of eyeballing a list.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool, query, one, tx } from "./db.js";
import { newReference } from "./security.js";
import { fromGeoJSONFile } from "./aid-sites.js";

const GIVEN_M = ["Jose", "Juan", "Carlos", "Luis", "Miguel", "Andres", "Diego", "Jorge", "Ivan", "Nicolas"];
const GIVEN_F = ["Maria", "Ana", "Luisa", "Carmen", "Sofia", "Valentina", "Camila", "Paula", "Daniela", "Lucia"];
const SURNAMES = ["Garcia", "Rodriguez", "Martinez", "Lopez", "Gonzalez", "Perez", "Sanchez", "Ramirez",
  "Torres", "Flores", "Rivera", "Gomez", "Diaz", "Vargas", "Castro", "Moreno", "Ortiz", "Silva"];
const ACCENTED: Record<string, string> = {
  Jose: "José", Andres: "Andrés", Nicolas: "Nicolás", Sofia: "Sofía", Lucia: "Lucía",
  Garcia: "García", Rodriguez: "Rodríguez", Martinez: "Martínez", Lopez: "López",
  Gonzalez: "González", Perez: "Pérez", Sanchez: "Sánchez", Ramirez: "Ramírez",
  Gomez: "Gómez", Diaz: "Díaz",
};
const BUILDINGS = ["Edificio Aurora", "Torre Bolivar", "Conjunto Los Pinos", "Residencias El Mirador",
  "Bloque 7 Ciudadela", "Edificio San Rafael", "Torre Central"];
const ACCURACY = ["exact", "building", "block", "neighbourhood"] as const;
// Where a point came from, when there is one. The synthetic data has to contain
// the case that broke us in the field: an address in words and no coordinate.
const SOURCE = ["device_gps", "map_pick", "geocoded", "landmark"] as const;
function sourceFor(lat: number | null): string {
  return lat == null ? "none" : pick(SOURCE);
}
const STATUSES = ["missing", "missing", "missing", "trapped_alive"] as const;

// Deterministic PRNG: a seed run must be reproducible or the measurement is not
// a measurement.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const r = rng(Number(process.env.SEED_RANDOM ?? 20260811));
const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
const chance = (p: number) => r() < p;

// The synthetic incident sits where the FRONT END is looking.
//
// It used to sit in Bogotá while app/web/src/lib/incident.ts centred the map on
// Quibdó, 400 km away. Everything worked — cells were computed, the endpoint
// answered, the map rendered — and the map was empty, because the data was off
// screen. Nothing failed, so nothing reported a failure.
// test/map-visibility.test.ts fails if these two ever drift apart again.
const CENTRE = {
  lat: Number(process.env.SEED_CENTRE_LAT ?? 4.8133),
  lng: Number(process.env.SEED_CENTRE_LNG ?? -75.6961),
};

interface Person {
  full_name: string;
  age_approx: number;
  gender: "m" | "f";
  lat: number;
  lng: number;
  building_name: string;
  floor: string;
  apartment: string;
  // The REPORTER's number. Named `phone` for historical reasons and kept that
  // way on purpose: this field is what the old engine scored as if it were the
  // subject's, and renaming it would hide the mistake instead of pinning it.
  phone: string;
  // The SUBJECT's own number, when the family knows it. Often absent — children
  // and older adults frequently have none, and that asymmetry is part of the
  // data. Correlating on this is legitimate; correlating on `phone` is not.
  subject_phone: string | null;
  id4: string;
  distinguishing_info: string;
}

function makePerson(): Person {
  const female = chance(0.5);
  const g1 = pick(female ? GIVEN_F : GIVEN_M);
  const g2 = pick(female ? GIVEN_F : GIVEN_M);
  const s1 = pick(SURNAMES);
  const s2 = pick(SURNAMES);
  return {
    full_name: `${g1} ${g2} ${s1} ${s2}`,
    age_approx: 3 + Math.floor(r() * 80),
    gender: female ? "f" : "m",
    // ~0.02 degrees ≈ 2 km box
    lat: CENTRE.lat + (r() - 0.5) * 0.04,
    lng: CENTRE.lng + (r() - 0.5) * 0.04,
    building_name: pick(BUILDINGS),
    floor: String(1 + Math.floor(r() * 12)),
    apartment: `${1 + Math.floor(r() * 12)}0${1 + Math.floor(r() * 4)}`,
    phone: `+57 3${Math.floor(r() * 10)}${Math.floor(1000000 + r() * 8999999)}`,
    subject_phone: chance(0.35)
      ? `+57 3${Math.floor(r() * 10)}${Math.floor(1000000 + r() * 8999999)}` : null,
    id4: String(1000 + Math.floor(r() * 9000)),
    distinguishing_info: `camisa ${pick(["azul", "blanca", "roja", "negra", "verde"])}, ${pick(["delgado", "estatura media", "cabello largo", "gafas", "cicatriz en el brazo"])}`,
  };
}

// The interesting part: how a SECOND person reports the SAME human being.
function makeVariant(p: Person): Record<string, unknown> {
  const parts = p.full_name.split(" ");
  let name = p.full_name;

  const style = Math.floor(r() * 5);
  if (style === 0) {
    // Only one given name and both surnames — extremely common.
    name = `${parts[0]} ${parts[2]} ${parts[3]}`;
  } else if (style === 1) {
    // Given names swapped: "Maria Jose" vs "Jose Maria".
    name = `${parts[1]} ${parts[0]} ${parts[2]} ${parts[3]}`;
  } else if (style === 2) {
    // Accents written this time (or a typo where accents were dropped).
    name = parts.map((w) => ACCENTED[w] ?? w).join(" ");
  } else if (style === 3) {
    // One surname only.
    name = `${parts[0]} ${parts[2]}`;
  } else {
    // A single-character typo: OCR, a phone keypad, or a shaking hand.
    const i = Math.floor(r() * name.length);
    name = name.slice(0, i) + name.slice(i + 1);
  }

  // Location scatter: same building, different phone GPS. 30-180 m.
  const metres = 30 + r() * 150;
  const bearing = r() * 2 * Math.PI;
  const dLat = (metres * Math.cos(bearing)) / 111_320;
  const dLng = (metres * Math.sin(bearing)) / (111_320 * Math.cos((p.lat * Math.PI) / 180));

  return {
    full_name: name,
    // Nobody is sure of an age. Off by up to 3 years.
    age_approx: chance(0.75) ? Math.max(0, p.age_approx + Math.round((r() - 0.5) * 6)) : null,
    gender: chance(0.9) ? p.gender : "unknown",
    ...(() => {
      const has = chance(0.85);
      const lat = has ? p.lat + dLat : null;
      return {
        last_seen_lat: lat,
        last_seen_lng: has ? p.lng + dLng : null,
        // No point, no precision claim — the same invariant the API enforces.
        location_accuracy: has ? pick(ACCURACY) : "unknown",
        location_source: sourceFor(lat),
        last_seen_address: has ? null : `${p.building_name ?? "casa"} cerca del parque`,
      };
    })(),
    building_name: chance(0.7) ? p.building_name : null,
    floor: chance(0.5) ? p.floor : null,
    apartment: chance(0.4) ? p.apartment : null,
    // A DIFFERENT person is re-telling this case, so their contact number is
    // normally their own. This used to be the same number half the time, which
    // was pure leakage: the old engine scored the reporter's phone as the
    // subject's, so synthetic duplicates handed the scorer +0.15 on a field that
    // carries no signal at all in the field (docs/dedup-review.md F4.1). The
    // measured recall was partly a measurement of that leak.
    //
    // It is not zero: a family sometimes files a second form instead of using
    // the `sumar` path on their private link. It is rare, and now it costs the
    // pair 0.10 instead of gaining it 0.15 — which is the correct direction, and
    // is the hardest true pair in the seed.
    reporter_phone: chance(0.12) ? p.phone : `+57 3${Math.floor(r() * 10)}${Math.floor(1000000 + r() * 8999999)}`,
    // A second reporter who knows the person's own number usually gives the
    // same one. This is a real, discriminative signal — unlike the reporter's
    // number, which used to leak into the score as if it were this one.
    subject_phone: p.subject_phone && chance(0.6) ? p.subject_phone : null,
    national_id_last4: chance(0.35) ? p.id4 : null,
    distinguishing_info: chance(0.6) ? p.distinguishing_info : `ropa ${pick(["oscura", "clara"])}`,
    // Reports arrive hours apart.
    last_contact_at: new Date(Date.now() - r() * 36 * 3600_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Families: the hard negative the seed did not contain.
//
// Every false positive we have actually observed belongs to a class this file
// used to generate none of. makePerson() scatters strangers with independent
// random names over a 2 km box, so precision 0.976 was precision against a
// population in which nothing collides. The real population collides in one
// specific way: ONE parent reports SEVERAL children — same surnames, same
// building, same apartment, same reporter phone, minutes apart, and for two
// brothers not even a gender disagreement.
//
// These are labelled `distinct` in seed_truth. Merging any of these pairs is
// the worst outcome the system can produce: a living child removed from the
// search list, and a collapsed building whose cell weight goes DOWN because the
// household inside it was collapsed into one case.
//
// Given names are drawn from disjoint halves of the name lists so that siblings
// never accidentally share one; the point of a hard negative is that it is hard
// for the right reason.
// ---------------------------------------------------------------------------
function makeFamily(): { reporterPhone: string; members: Person[] } {
  const s1 = pick(SURNAMES);
  const s2 = pick(SURNAMES.filter((s) => s !== s1));
  const building = pick(BUILDINGS);
  const apartment = `${1 + Math.floor(r() * 12)}0${1 + Math.floor(r() * 4)}`;
  const floor = String(1 + Math.floor(r() * 12));
  const lat = CENTRE.lat + (r() - 0.5) * 0.04;
  const lng = CENTRE.lng + (r() - 0.5) * 0.04;
  const reporterPhone = `+57 3${Math.floor(r() * 10)}${Math.floor(1000000 + r() * 8999999)}`;
  // Two to four children, occasionally all of the same sex — the pair with no
  // contradicting signal whatsoever.
  const count = 2 + Math.floor(r() * 3);
  const allSameSex = chance(0.5);
  const familyFemale = chance(0.5);
  const used = new Set<string>();
  const members: Person[] = [];
  for (let i = 0; i < count; i++) {
    const female = allSameSex ? familyFemale : chance(0.5);
    const pool = (female ? GIVEN_F : GIVEN_M).filter((g) => !used.has(g));
    if (!pool.length) break;
    const given = pick(pool);
    used.add(given);
    const jitter = 15;
    members.push({
      // One given name plus both surnames: how a parent writes a child's name on
      // a form at 3 a.m.
      full_name: `${given} ${s1} ${s2}`,
      age_approx: 2 + Math.floor(r() * 16),
      gender: female ? "f" : "m",
      lat: lat + ((r() - 0.5) * jitter) / 111_320,
      lng: lng + ((r() - 0.5) * jitter) / 111_320,
      building_name: building,
      floor,
      apartment,
      // The same parent files all of them. This is what used to hand the scorer
      // +0.15 per pair.
      phone: reporterPhone,
      // Children usually have no phone of their own; when one does, it is theirs
      // alone and it is the signal that tells them apart.
      subject_phone: chance(0.2)
        ? `+57 3${Math.floor(r() * 10)}${Math.floor(1000000 + r() * 8999999)}` : null,
      id4: String(1000 + Math.floor(r() * 9000)),
      distinguishing_info: `camisa ${pick(["azul", "blanca", "roja", "negra", "verde"])}`,
    });
  }
  return { reporterPhone, members };
}

function baseReport(p: Person): Record<string, unknown> {
  return {
    full_name: p.full_name,
    age_approx: p.age_approx,
    gender: p.gender,
    last_seen_lat: p.lat,
    last_seen_lng: p.lng,
    location_accuracy: pick(ACCURACY),
    location_source: pick(SOURCE),
    building_name: p.building_name,
    floor: p.floor,
    apartment: p.apartment,
    reporter_phone: p.phone,
    subject_phone: p.subject_phone,
    national_id_last4: chance(0.4) ? p.id4 : null,
    distinguishing_info: p.distinguishing_info,
    last_contact_at: new Date(Date.now() - r() * 48 * 3600_000).toISOString(),
  };
}

// The seed allocates references the same way intake does, from the same
// function, WITH THE SAME RETRY. It used to have its own private 4-character
// copy and no retry, and it died on run one against a real database:
// `duplicate key value violates unique constraint "person_case_ref_uq"`. A seed
// that cannot survive its own collision budget is a drill that fails for a
// reason that has nothing to do with what the drill measures.
async function insertCase(incidentId: string, prefix: string, payload: Record<string, unknown>) {
  return tx(async (c) => {
    let cs: { rows: Array<{ id: string }> } | null = null;
    for (let attempt = 0; attempt < 8 && cs === null; attempt++) {
      const candidate = newReference(prefix);
      const clash = await c.query(
        `SELECT 1 FROM person_case WHERE incident_id = $1 AND reference_number = $2`,
        [incidentId, candidate]
      );
      if (clash.rowCount) continue;
      cs = await c.query(
        `INSERT INTO person_case (incident_id, status, status_source, reference_number,
                                  public_listed, consent_photo_public, is_minor)
         VALUES ($1,$2,'citizen',$3,true,false,$4) RETURNING id`,
        [incidentId, pick(STATUSES), candidate, (payload.age_approx as number ?? 99) < 18]
      );
    }
    if (!cs) throw new Error("seed could not allocate a reference number in 8 attempts");
    const caseId: string = cs.rows[0].id;
    await c.query(
      `INSERT INTO report (case_id, incident_id, channel, payload, reporter_phone_e164, submitted_at)
       VALUES ($1,$2,'pwa',$3,$4, now() - make_interval(mins => $5))`,
      [
        caseId, incidentId, JSON.stringify(payload),
        String(payload.reporter_phone ?? "").replace(/[^\d+]/g, "") || null,
        Math.floor(r() * 2880),
      ]
    );
    await c.query(`SELECT public.refresh_person_index($1)`, [caseId]);
    return caseId;
  });
}

// ---------------------------------------------------------------------------
// Aid sites: load every reviewed GeoJSON committed to the repo.
//
// This is a seed step, not an import step: it reads files that a human already
// reviewed and committed, and it never touches the network. The two-step
// pull/review/commit workflow in import-aid-sites.ts is unchanged — what changed
// is that a fresh database is no longer left with an empty aid layer, which is
// indistinguishable, on screen, from a broken one.
//
// Rows a person verified in the field are never overwritten (same rule as the
// importer), so re-running seed on a live database cannot erase field work.
// ---------------------------------------------------------------------------
function aidSitesDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AID_SITES_DIR,
    path.resolve(here, "../data/aid-sites"),      // inside the image (/app/dist -> /app/data)
    path.resolve(here, "../../../data/aid-sites"), // services/api/src -> repo root
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(d)) ?? null;
}

export async function seedAidSites(country = process.env.SEED_AID_COUNTRY ?? "CO"): Promise<number> {
  const dir = aidSitesDir();
  if (!dir) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".geojson"));
  let loaded = 0;
  for (const f of files) {
    for (const s of fromGeoJSONFile(path.join(dir, f))) {
      await query(
        `INSERT INTO aid_site (country_code, kind, name, geom, address, phone, capacity,
                               source, source_ref, source_url)
         VALUES (upper($1), $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
                 $6, $7, $8, $9, $10, $11)
         ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
           geom       = EXCLUDED.geom,
           name       = CASE WHEN aid_site.verified_at IS NULL THEN EXCLUDED.name ELSE aid_site.name END,
           updated_at = now()`,
        [country, s.kind, s.name, s.lat, s.lng, s.address ?? null, s.phone ?? null,
         s.capacity ?? null, s.source, s.source_ref ?? null, s.source_url ?? null]
      );
      loaded++;
    }
  }
  return loaded;
}

export async function seed(total = Number(process.env.SEED_CASES ?? 500)) {
  const slug = process.env.SEED_INCIDENT ?? "drill-quibdo";

  const inc = await one<{ id: string; ref_prefix: string }>(
    `INSERT INTO incident (slug, name, country, ref_prefix, centre, public_expires_at)
     VALUES ($1,$2,'CO','DRL',
             ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
             now() + interval '30 days')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, ref_prefix`,
    [slug, "Simulacro Pereira (datos sintéticos)", CENTRE.lng, CENTRE.lat]
  );
  if (!inc) throw new Error("could not create incident");

  // Ground truth for the correlation test. Not part of the production schema.
  await query(`
    CREATE TABLE IF NOT EXISTS seed_truth (
      a_case uuid NOT NULL,
      b_case uuid NOT NULL,
      kind   text NOT NULL,          -- duplicate | distinct
      note   text,
      PRIMARY KEY (a_case, b_case)
    )`);
  // Not every duplicate pair is equally hard, and averaging them hides which
  // kind we are losing:
  //   base-variant    - the original report against a re-telling of it.
  //   variant-variant - two re-tellings of the same person, neither of them the
  //                     original. Both names mangled, both GPS points scattered
  //                     independently, often no shared phone. This is the pair a
  //                     real event produces most of, and the one a single
  //                     averaged recall number quietly buries.
  await query(`ALTER TABLE seed_truth ADD COLUMN IF NOT EXISTS pair_type text`);
  await query(`DELETE FROM seed_truth`);

  // 30% of people are reported more than once — that is roughly what a real
  // event looks like once a form is shared on WhatsApp.
  const dupRate = Number(process.env.SEED_DUP_RATE ?? 0.3);
  let people = 0, cases = 0, pairs = 0;

  // ---------------------------------------------------------------------------
  // Households first, so that a smaller seed still contains some. Around 15% of
  // the population is a family reported by one parent: distinct people who look
  // like duplicates on every signal except the given name. Without them the
  // precision number describes a world we are not deploying into.
  // ---------------------------------------------------------------------------
  const familyShare = Number(process.env.SEED_FAMILY_SHARE ?? 0.15);
  const familyBudget = Math.min(Math.floor(total * familyShare), total);
  let families = 0, siblingPairs = 0;
  while (cases < familyBudget) {
    const fam = makeFamily();
    const ids: string[] = [];
    for (const m of fam.members) {
      if (cases >= familyBudget) break;
      // Deliberately the easiest possible location claim: one parent standing
      // outside one building points at it once. Nothing about the geography
      // separates these children, which is the whole point.
      const payload = {
        ...baseReport(m),
        location_accuracy: "building",
        location_source: "map_pick",
        last_contact_at: new Date(Date.now() - r() * 6 * 3600_000).toISOString(),
      };
      ids.push(await insertCase(inc.id, inc.ref_prefix, payload));
      cases++; people++;
    }
    families++;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        await query(
          `INSERT INTO seed_truth (a_case, b_case, kind, note, pair_type)
           VALUES ($1,$2,'distinct',$3,'sibling')
           ON CONFLICT DO NOTHING`,
          [a, b, `siblings, one reporter: ${fam.members[0]?.full_name ?? ""}`]
        );
        siblingPairs++;
      }
    }
  }

  while (cases < total) {
    const p = makePerson();
    const first = await insertCase(inc.id, inc.ref_prefix, baseReport(p));
    cases++; people++;

    if (chance(dupRate) && cases < total) {
      const copies = chance(0.25) ? 2 : 1; // occasionally three reports for one person
      const ids = [first];
      for (let i = 0; i < copies && cases < total; i++) {
        const dup = await insertCase(inc.id, inc.ref_prefix, makeVariant(p));
        cases++;
        ids.push(dup);
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          // ids[0] is the original report; anything else is a re-telling.
          const pairType = i === 0 ? "base-variant" : "variant-variant";
          await query(
            `INSERT INTO seed_truth (a_case, b_case, kind, note, pair_type)
             VALUES ($1,$2,'duplicate',$3,$4)
             ON CONFLICT DO NOTHING`,
            [a, b, p.full_name, pairType]
          );
          pairs++;
        }
      }
    }
  }

  // Exercise the real asynchronous path in drills: the worker must correlate
  // every seeded case, not just the unrelated HTTP smoke-test report.
  //
  // Opt-in, and off by default, because this is not free anywhere else: the
  // correlation test calls seed() in-process while a worker from a previous
  // drill is still running. The worker would then correlate the test's own cases
  // concurrently with the test's synchronous pass — the result stays correct (the
  // insert upserts) but the timing becomes a measurement of two racing processes
  // and is not reproducible. The drill's seed service sets SEED_ENQUEUE=1.
  const enqueue = process.env.SEED_ENQUEUE === "1";
  if (enqueue) await query(
    `INSERT INTO job (kind, payload, dedupe_key)
     SELECT 'correlate', jsonb_build_object('case_id', pc.id), 'correlate:' || pc.id::text
       FROM person_case pc
      WHERE pc.incident_id = $1
     ON CONFLICT (dedupe_key) WHERE done_at IS NULL AND dedupe_key IS NOT NULL
     DO UPDATE SET payload = EXCLUDED.payload`,
    [inc.id]
  );

  // The aid layer is data too, and a map with no shelters on it is the same
  // empty screen as a map with no reports on it. The reviewed GeoJSON is
  // committed to the repo precisely so this needs no outbound network.
  const aidLoaded = process.env.SEED_AID === "0" ? 0 : await seedAidSites();

  console.log(JSON.stringify({
    level: "info", msg: "seed complete",
    incident: slug, cases, people, duplicate_pairs: pairs, enqueued: enqueue,
    // Reported separately from the duplicates: these are the pairs the engine
    // must NOT propose, and a precision figure that never met one is not a
    // precision figure.
    families, sibling_pairs: siblingPairs,
    aid_sites: aidLoaded,
  }));
  return { incidentId: inc.id, cases, people, pairs, families, siblingPairs, aidLoaded };
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(JSON.stringify({ level: "fatal", msg: err.message }));
      process.exit(1);
    });
}

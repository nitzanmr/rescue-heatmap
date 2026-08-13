// The public map: weighting, clustering, tile failover, and the privacy line.
//
// All static / pure — no database, no browser. That is not a compromise: every
// rule checked here is one that a green drill would NOT catch, because a map can
// render beautifully while leaking a person or while ranking the wrong building
// first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clusterPoints, project } from "../../../app/web/src/lib/cluster.ts";
import { PROVIDERS, shouldFailover, tileChain } from "../../../app/web/src/lib/tiles.ts";
import { classify, fromOverpass, overpassQuery, toGeoJSON } from "../src/aid-sites.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migration = fs.readFileSync(path.join(root, "db/migrations/0008_public_map.sql"), "utf8");

// ---------------------------------------------------------------------------
// 1 · Weighting. The SQL is the source of truth; this mirror exists ONLY to
// assert the properties we argued about, and the test below pins the mirror to
// the migration so the two cannot drift silently.
// ---------------------------------------------------------------------------
const ACCURACY: Record<string, number> = { exact: 1.0, building: 0.9, block: 0.6, neighbourhood: 0.35 };
const URGENCY: Record<string, number> = { trapped_alive: 2.5, missing: 1.0 };

function caseWeight(accuracy: string, status: string, reporters: number) {
  return (ACCURACY[accuracy] ?? 0.15) * (URGENCY[status] ?? 0.2) * Math.min(Math.sqrt(Math.max(reporters, 1)), 3.0);
}

test("corroboration is compressed, not the whole weight", () => {
  // The bug 0004 had: sqrt() over the SUM pulled a lone trapped_alive towards
  // the middle of the ramp. One person confirmed alive under a slab must still
  // outrank a well-corroborated 'missing' pin.
  const alive = caseWeight("building", "trapped_alive", 1);
  const missingWellReported = caseWeight("building", "missing", 4);
  assert.ok(alive > missingWellReported, `${alive} should outrank ${missingWellReported}`);
});

test("the second report matters much more than the ninth", () => {
  const gain = (n: number) => caseWeight("building", "missing", n + 1) - caseWeight("building", "missing", n);
  // Diminishing returns are the point of sqrt: monotonically decreasing, and by
  // the ninth report an extra voice is worth less than half of what the second
  // one was worth.
  for (let n = 1; n < 8; n++) assert.ok(gain(n) > gain(n + 1), `gain must fall at n=${n}`);
  assert.ok(gain(1) > gain(8) * 2);
});

test("corroboration cannot be farmed without limit", () => {
  // Six relatives filing separately is normal. Six hundred is an attack, or a
  // WhatsApp chain. The cap is what keeps one address from owning the map.
  assert.equal(caseWeight("exact", "missing", 9), caseWeight("exact", "missing", 900));
});

test("accuracy still separates a building from a neighbourhood", () => {
  assert.ok(caseWeight("building", "missing", 1) > caseWeight("neighbourhood", "missing", 1) * 2);
});

test("0008 keeps sqrt on corroboration and drops the outer sqrt", () => {
  const body = migration.replace(/--.*$/gm, "");
  assert.match(body, /LEAST\(sqrt\(GREATEST\(COALESCE\(reporter_count/, "corroboration must be sqrt-compressed");
  assert.doesNotMatch(body, /SELECT ST_Y\([^)]*\)[^,]*,[^,]*,\s*sqrt\(w\)/, "the outer sqrt(w) must be gone");
});

test("the heat function is never given a public cell finer than 250 m by the API", () => {
  const route = fs.readFileSync(path.join(root, "services/api/src/routes/public.ts"), "utf8");
  assert.match(route, /Math\.max\(250,/, "a 50 m cell with one case is an address");
});

// ---------------------------------------------------------------------------
// 2 · The privacy line between the two maps.
// ---------------------------------------------------------------------------
test("the public map component never touches an operator endpoint", () => {
  const src = fs.readFileSync(path.join(root, "app/web/src/components/PublicMap.tsx"), "utf8");
  const page = fs.readFileSync(path.join(root, "app/web/src/app/mapa/page.tsx"), "utf8");
  for (const [name, code] of [["PublicMap.tsx", src], ["mapa/page.tsx", page]] as const) {
    assert.doesNotMatch(code.replace(/\/\/.*$/gm, ""), /panelHeat|dedupQueue|operatorToken|"operator"/, `${name} must hold no operator surface`);
  }
});

test("aid_sites() joins no case table", () => {
  const fn = migration.slice(migration.indexOf("FUNCTION public.aid_sites"));
  for (const table of ["person_case", "person_index", "report", "public_case_view"]) {
    assert.doesNotMatch(fn, new RegExp(`\\b${table}\\b`), `aid_sites() must not reach ${table}`);
  }
});

// ---------------------------------------------------------------------------
// 3 · Clustering.
// ---------------------------------------------------------------------------
test("clustering keeps every point exactly once", () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({
    lat: 5.69 + (i % 20) * 0.0008,
    lng: -76.66 + Math.floor(i / 20) * 0.0008,
    id: i,
  }));
  const clusters = clusterPoints(pts, 13);
  const ids = clusters.flatMap((c) => c.items.map((p) => p.id)).sort((a, b) => a - b);
  assert.deepEqual(ids, pts.map((p) => p.id));
});

test("clustering is deterministic across calls", () => {
  const pts = Array.from({ length: 60 }, (_, i) => ({ lat: 5.69 + i * 0.0003, lng: -76.66 + i * 0.0004 }));
  const a = clusterPoints(pts, 14).map((c) => c.items.length);
  const b = clusterPoints(pts, 14).map((c) => c.items.length);
  assert.deepEqual(a, b);
});

test("zooming in splits clusters, never merges them", () => {
  const pts = Array.from({ length: 120 }, (_, i) => ({ lat: 5.69 + (i % 12) * 0.001, lng: -76.66 + Math.floor(i / 12) * 0.001 }));
  const coarse = clusterPoints(pts, 12).length;
  const fine = clusterPoints(pts, 16).length;
  assert.ok(fine >= coarse, `zoom 16 produced ${fine} clusters vs ${coarse} at zoom 12`);
});

test("a cluster sits on its members, not on the grid line", () => {
  const pts = [
    { lat: 5.6900, lng: -76.6600 },
    { lat: 5.6901, lng: -76.6601 },
  ];
  const [c] = clusterPoints(pts, 13);
  assert.ok(Math.abs(c.lat - 5.69005) < 1e-6 && Math.abs(c.lng + 76.66005) < 1e-6);
});

test("projection is stable at the equator and far from it", () => {
  // Same pixel distance at any latitude is the whole reason clustering is done
  // in pixel space rather than in metres.
  const d = (lat: number) => project(lat, 0.01, 13).x - project(lat, 0, 13).x;
  assert.ok(Math.abs(d(0) - d(60)) < 1e-6);
});

// ---------------------------------------------------------------------------
// 4 · Tiles.
// ---------------------------------------------------------------------------
test("the chain only offers providers that are configured", () => {
  const chain = tileChain([
    { id: "self", url: "", attribution: "", maxZoom: 19, ready: false },
    { id: "carto", url: "x", attribution: "", maxZoom: 19, ready: true },
  ]);
  assert.deepEqual(chain.map((p) => p.id), ["carto"]);
});

test("openstreetmap.org is last in the chain", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(ids[ids.length - 1], "osm", "the community tile servers are a last resort, never a default");
});

test("a few failed tiles do not trigger a failover", () => {
  assert.equal(shouldFailover(10, 3), false, "a phone in a tunnel is not a blocked provider");
});

test("a sustained failure rate does trigger a failover", () => {
  assert.equal(shouldFailover(30, 12), true);
});

// ---------------------------------------------------------------------------
// 5 · Aid site import.
// ---------------------------------------------------------------------------
test("a school is a candidate, never an open shelter", () => {
  assert.equal(classify({ amenity: "school" }), "shelter_candidate");
  assert.equal(classify({ emergency: "shelter" }), "shelter");
});

test("unnamed and geometry-less elements are dropped", () => {
  const sites = fromOverpass([
    { type: "node", id: 1, lat: 5.69, lon: -76.66, tags: { amenity: "hospital" } }, // no name
    { type: "way", id: 2, tags: { amenity: "hospital", name: "Hospital San Francisco" } }, // no centre
    { type: "way", id: 3, center: { lat: 5.7, lon: -76.65 }, tags: { amenity: "hospital", name: "San Francisco" } },
  ]);
  assert.deepEqual(sites.map((s) => s.source_ref), ["way/3"]);
});

test("fuel and markets classify as logistics kinds, separate from aid", () => {
  assert.equal(classify({ amenity: "fuel" }), "fuel");
  assert.equal(classify({ shop: "supermarket" }), "market");
  assert.equal(classify({ amenity: "marketplace" }), "market");
  // A pharmacy must not fall into the logistics bucket: it is an aid kind and
  // civilians are sent there.
  assert.equal(classify({ amenity: "pharmacy", shop: "convenience" }), "pharmacy");
});

test("an unnamed pump is kept; an unnamed hospital is not", () => {
  const sites = fromOverpass([
    { type: "node", id: 11, lat: 3.4, lon: -76.5, tags: { amenity: "fuel" } },
    { type: "node", id: 12, lat: 3.4, lon: -76.5, tags: { amenity: "hospital" } },
    { type: "node", id: 13, lat: 3.4, lon: -76.5, tags: { shop: "supermarket", brand: "Éxito" } },
  ]);
  assert.deepEqual(sites.map((s) => s.source_ref), ["node/11", "node/13"]);
  assert.match(sites[0].name, /sin nombre/);
  assert.equal(sites[1].name, "Éxito");
});

test("the overpass query asks for fuel and shops", () => {
  const q = overpassQuery({ south: 3.3, west: -76.6, north: 3.55, east: -76.42 });
  assert.match(q, /fuel/);
  assert.match(q, /supermarket\|convenience\|wholesale/);
});

test("imported sites carry provenance and are unverified by construction", () => {
  const sites = fromOverpass([
    { type: "node", id: 7, lat: 5.69, lon: -76.66, tags: { amenity: "pharmacy", name: "Farmacia Central" } },
  ]);
  assert.equal(sites[0].source, "osm");
  assert.match(sites[0].source_url!, /openstreetmap\.org\/node\/7/);
  assert.equal(toGeoJSON(sites).attribution.includes("OpenStreetMap"), true, "ODbL attribution is mandatory");
});

// A kind that exists in the classifier but not in the CHECK constraint fails on
// the first import row, and a kind missing from the legend renders as a grey
// "Otro" dot nobody can filter. Both are silent until an activation, so they are
// checked statically here.
test("every classifier kind is accepted by the schema and drawn by the legend", () => {
  const src = fs.readFileSync(path.join(root, "services/api/src/aid-sites.ts"), "utf8");
  const kinds = (src.match(/export type AidKind =([\s\S]*?);/)![1].match(/"([a-z_]+)"/g) ?? [])
    .map((k) => k.replaceAll('"', ""));
  assert.ok(kinds.includes("fuel") && kinds.includes("market"));

  const migrations = fs
    .readdirSync(path.join(root, "db/migrations"))
    .map((f) => fs.readFileSync(path.join(root, "db/migrations", f), "utf8"))
    .join("\n");
  const legend = fs.readFileSync(path.join(root, "app/web/src/lib/aid-kinds.ts"), "utf8");
  for (const k of kinds) {
    assert.match(migrations, new RegExp(`'${k}'`), `kind ${k} is not allowed by any CHECK`);
    assert.match(legend, new RegExp(`\\b${k}:`), `kind ${k} has no colour/label`);
  }
});

test("the committed datasets are loadable and non-trivial", () => {
  for (const name of ["pereira-co.geojson", "cali-co.geojson"]) checkDataset(name);
});

function checkDataset(name: string) {
  const file = path.join(root, "data/aid-sites", name);
  const fc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(fc.features.length > 50, `only ${fc.features.length} sites committed`);
  // Every feature must be usable offline: name + coordinates, no exceptions.
  for (const f of fc.features) {
    assert.ok(f.properties.name, "a site without a name cannot be read out loud");
    assert.equal(f.geometry.coordinates.length, 2);
  }
}

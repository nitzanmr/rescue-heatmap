// An empty map is a failure, and it is the failure our tests were blindest to.
//
// Everything was green while /mapa rendered nothing at all. No endpoint errored,
// no migration failed, no assertion broke — the synthetic incident simply sat
// 400 km from where the front end was pointing its camera, and the reviewed
// aid-site GeoJSON in the repo was never loaded into any database. Both layers
// answered 200 with an empty array, which is exactly what an unaffected city
// looks like.
//
// So these tests check the seams BETWEEN the components, because that is where
// this class of bug lives: the front end's viewport against the seed's
// coordinates, the committed data file against the loader, and the drill against
// its own incident slug. Static on purpose — no database, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, tileChain } from "../../../app/web/src/lib/tiles.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const incidentTs = read("app/web/src/lib/incident.ts");
const seedTs = read("services/api/src/seed.ts");
const makefile = read("Makefile");

function num(src: string, key: string): number {
  const m = src.match(new RegExp(`${key}:\\s*(-?\\d+(?:\\.\\d+)?)`));
  assert.ok(m, `could not read ${key}`);
  return Number(m![1]);
}

const bbox = {
  minLat: num(incidentTs.split("bbox:")[1], "minLat"),
  minLng: num(incidentTs.split("bbox:")[1], "minLng"),
  maxLat: num(incidentTs.split("bbox:")[1], "maxLat"),
  maxLng: num(incidentTs.split("bbox:")[1], "maxLng"),
};

const inside = (lat: number, lng: number) =>
  lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;

// ---------------------------------------------------------------------------
// 1 · The data has to be where the camera is pointing.
// ---------------------------------------------------------------------------
test("the seeded incident centre falls inside the front end's incident bbox", () => {
  const centre = seedTs.split("const CENTRE = {")[1];
  const lat = Number(centre.match(/SEED_CENTRE_LAT \?\? (-?\d+(?:\.\d+)?)/)![1]);
  const lng = Number(centre.match(/SEED_CENTRE_LNG \?\? (-?\d+(?:\.\d+)?)/)![1]);
  assert.ok(
    inside(lat, lng),
    `seed centre ${lat},${lng} is outside ${JSON.stringify(bbox)} — the map will render empty`
  );
});

test("the seed's scatter stays inside the bbox, not just its centre", () => {
  // The generator scatters ±0.02° around the centre. A centre inside the box
  // with a scatter wider than the box still puts pins off screen.
  const spread = Number(seedTs.match(/\(r\(\) - 0\.5\) \* (\d*\.?\d+)/)![1]) / 2;
  const lat = Number(seedTs.match(/SEED_CENTRE_LAT \?\? (-?\d+(?:\.\d+)?)/)![1]);
  const lng = Number(seedTs.match(/SEED_CENTRE_LNG \?\? (-?\d+(?:\.\d+)?)/)![1]);
  assert.ok(inside(lat - spread, lng - spread) && inside(lat + spread, lng + spread),
    `the ±${spread}° scatter leaves the incident bbox`);
});

// ---------------------------------------------------------------------------
// 2 · A data file in the repo that nothing loads is not data.
// ---------------------------------------------------------------------------
test("every committed aid-site file matches the area it declares", () => {
  // This used to compare every file against the INCIDENT bbox, which was right
  // while one city was in scope and wrong the moment a second one was: pulling
  // Cali (the delegation's landing point) made a correct file look like the
  // wrong city had been downloaded. A file now carries the bbox it was pulled
  // for, and is checked against its own claim. The "did we pull the wrong city"
  // guard survives — it is just no longer tied to the map's current view.
  const dir = path.join(root, "data/aid-sites");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".geojson"));
  assert.ok(files.length > 0, "no reviewed aid-site file is committed");
  let anyInIncident = false;
  for (const f of files) {
    const fc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.ok(fc.features.length > 0, `${f} has no features`);
    assert.ok(fc.area?.bbox, `${f} does not say which area it covers`);
    const b = fc.area.bbox;
    const off = fc.features.filter(
      (x: any) =>
        x.geometry.coordinates[1] < b.minLat || x.geometry.coordinates[1] > b.maxLat ||
        x.geometry.coordinates[0] < b.minLng || x.geometry.coordinates[0] > b.maxLng
    );
    assert.equal(off.length, 0, `${f}: ${off.length} sites outside the bbox the file declares`);
    if (fc.features.some((x: any) => inside(x.geometry.coordinates[1], x.geometry.coordinates[0]))) {
      anyInIncident = true;
    }
  }
  // At least one file must cover what the map actually shows, or the public map
  // renders an aid layer nobody can see.
  assert.ok(anyInIncident, "no committed aid-site file falls inside the incident bbox");
});

test("seeding loads the aid layer, so a fresh database is never a blank map", () => {
  assert.match(seedTs, /export async function seedAidSites/);
  assert.match(seedTs, /INSERT INTO aid_site/);
  assert.match(seedTs, /SEED_AID === "0"/, "the loader must be skippable, but on by default");
});

test("candidate shelters are visible by default — the warning is on the marker, not the toggle", () => {
  // Decision 11.8: the first real tester never found the hidden layer. A point
  // that is off by default reads as "does not exist". Safety lives in the
  // rendering (dashed, faint, 'sin confirmar' in the popup), not in hiding.
  const mapa = read("app/web/src/app/mapa/page.tsx");
  assert.match(mapa, /\[showCandidates, setShowCandidates\] = useState\(true\)/,
    "shelter candidates went back to hidden-by-default; that was reversed on purpose");
  // And the warning that justifies showing them must still exist on the marker.
  const pm = read("app/web/src/components/PublicMap.tsx");
  assert.match(pm, /dashArray/, "unverified sites lost their dashed rendering");
  assert.match(pm, /Sin verificar/, "unverified sites lost the in-popup warning");
});

test("the API image ships the reviewed aid-site files", () => {
  // The seeder runs inside the image; a file that exists only in a git checkout
  // is not there at 3 a.m. on a VPS.
  assert.match(read("services/api/Dockerfile"), /COPY data\/aid-sites/);
});

test("field verification survives a re-seed", () => {
  // Same rule as the importer: re-running seed on a live database must not
  // overwrite a name a liaison corrected on the ground.
  assert.match(seedTs, /verified_at IS NULL THEN EXCLUDED\.name ELSE aid_site\.name/);
});

// ---------------------------------------------------------------------------
// 3 · The drill has to fail when the map is empty.
// ---------------------------------------------------------------------------
test("the drill asserts both public layers actually carry data", () => {
  assert.match(makefile, /PUBLIC HEAT IS EMPTY/);
  assert.match(makefile, /AID SITE LAYER IS EMPTY/);
  assert.match(makefile, /HEAT OUTSIDE THE INCIDENT BBOX/);
});

test("the drill posts into the incident the seed actually creates", () => {
  // The previous bug in miniature: the drill smoke-tested one incident slug
  // while the seed created another, and each half passed on its own.
  const slug = seedTs.match(/SEED_INCIDENT \?\? "([^"]+)"/)![1];
  for (const m of makefile.matchAll(/"incident_slug":"([^"]+)"/g)) {
    assert.equal(m[1], slug, `the drill posts to ${m[1]} but the seed creates ${slug}`);
  }
  assert.ok(makefile.includes(`incident=${slug}`), "the drill must read heat from the seeded incident");
});

// ---------------------------------------------------------------------------
// 4 · Free tiers only — a provider that needs a card needs a legal entity.
// ---------------------------------------------------------------------------
test("no basemap provider in the chain requires a card on file", () => {
  const billable = ["mapbox", "google", "here", "tomtom", "esri"];
  for (const p of PROVIDERS) {
    assert.ok(!billable.includes(p.id), `${p.id} is billable — the chain is free tiers only`);
    assert.ok(!/needs a card|billed/i.test(p.note ?? ""), `${p.id}'s own note says it is billable`);
  }
});

test("the fallback chain still has more than one option, with OSM last", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.ok(ids.length >= 4, "removing billable providers must not leave a chain of one");
  assert.equal(ids[ids.length - 1], "osm", "tile.openstreetmap.org is always the last resort");
  // With no keys configured at build time, what is left must still work.
  const chain = tileChain();
  assert.ok(chain.length >= 1);
});

// ---------------------------------------------------------------------------
// 5 · A published cell must be VISIBLE, and a discarded point must be SAID.
//
// Second field report, same tester, same theme as everything above: work that
// exists but cannot be seen. He filed three reports of one child, each with a
// confirmed geocoder point, and saw nothing — because (a) heat intensity was
// normalised against the hottest seeded cell, so a legitimate 3-report cell
// rendered below the first gradient stop, and (b) editing the address after
// picking a result silently discarded the coordinate, with no visible event.
// ---------------------------------------------------------------------------
const publicMapTsx = read("app/web/src/components/PublicMap.tsx");
const reportarTsx = read("app/web/src/app/reportar/page.tsx");

test("public heat has an intensity floor: passing the k-anon gate earns visibility", () => {
  const m = publicMapTsx.match(/HEAT_FLOOR = (\d*\.?\d+)/);
  assert.ok(m, "PublicMap must define HEAT_FLOOR — without it a quiet cell renders invisibly");
  const floor = Number(m![1]);
  assert.ok(floor >= 0.25, `floor ${floor} sits below the gradient's first stop — still invisible`);
  assert.ok(floor <= 0.6, `floor ${floor} flattens the gradient — the map stops ranking cells`);
  assert.match(publicMapTsx, /HEAT_FLOOR \+ \(1 - HEAT_FLOOR\)/, "intensity must interpolate above the floor, not clip at it");
});

test("editing the address after a geocoded pick announces the discarded point", () => {
  // The discard itself is correct and must stay (a stale point on new text is
  // worse than no point). What must never come back is the silence around it.
  assert.match(reportarTsx, /setPointLost\(true\)/, "clearing the point must raise the pointLost event");
  assert.match(reportarTsx, /Al cambiar la dirección se quitó el punto del mapa/,
    "the banner must say, in words, that the point was removed");
  // And it must survive further typing: geoError is wiped per keystroke, so the
  // notice may not live in geoError.
  const cleared = reportarTsx.match(/setGeoError\(null\)/g) ?? [];
  assert.ok(cleared.length >= 1);
  assert.ok(!/setGeoError\([^)]*quitó el punto/.test(reportarTsx), "the notice must not be stored in geoError");
});

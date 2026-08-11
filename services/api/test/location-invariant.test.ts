// A location is a point, a claim about that point, and a source. All three, or
// none of them.
//
// The incident: the intake form took a written address, never geocoded it, and
// still offered "punto exacto" as a precision. The payload therefore claimed a
// precision for a coordinate that did not exist; the API stored no geography —
// correctly — and the case vanished from the heat map without a single error
// anywhere. The family had told us where to look and we had thrown it away
// quietly.
//
// These are static and pure-function checks: they run in seconds, without a
// database or a browser, and they fail the moment the form is allowed to make a
// claim the data cannot support again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normaliseLocation } from "../src/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WEB = path.join(ROOT, "app/web/src");
const read = (f: string) => readFileSync(f, "utf8");

test("no coordinate means no precision claim, and the report is still accepted", () => {
  const r = normaliseLocation({
    last_seen_address: "Cra 1 con Calle 24, casa azul",
    location_accuracy: "exact",
  } as never);
  assert.equal(r.location_accuracy, "unknown", "precision without a point must be downgraded");
  assert.equal(r.location_source, "none");
  assert.equal(r.unmapped, true, "the case must be flagged for an operator, not silently dropped");
});

test("a claim may never exceed what its source can support", () => {
  const geocoded = normaliseLocation({
    last_seen_lat: 5.69, last_seen_lng: -76.66,
    location_source: "geocoded", location_accuracy: "exact",
  } as never);
  assert.equal(geocoded.location_accuracy, "building",
    "a street match is a building at best — a geocoder does not know which house fell");

  const landmark = normaliseLocation({
    last_seen_lat: 5.69, last_seen_lng: -76.66,
    location_source: "landmark", location_accuracy: "building",
  } as never);
  assert.equal(landmark.location_accuracy, "block");

  const gps = normaliseLocation({
    last_seen_lat: 5.69, last_seen_lng: -76.66,
    location_source: "device_gps", location_accuracy: "exact",
  } as never);
  assert.equal(gps.location_accuracy, "exact", "a device fix is allowed to be exact");
});

test("a less precise claim than the source allows is respected", () => {
  // The reporter is permitted to be more humble than the machine. "I pressed
  // GPS but I was standing across the street" is real, and overriding it upward
  // would be the same lie in the other direction.
  const r = normaliseLocation({
    last_seen_lat: 5.69, last_seen_lng: -76.66,
    location_source: "device_gps", location_accuracy: "block",
  } as never);
  assert.equal(r.location_accuracy, "block");
});

test("the form cannot post a precision it has no point for", () => {
  const src = read(path.join(WEB, "app/reportar/page.tsx"));
  assert.match(
    src,
    /const hasPoint = draft\.last_seen_lat != null && draft\.last_seen_lng != null;/,
    "toWire() must decide the location claim from whether a point exists"
  );
  assert.match(src, /out\.location_accuracy = "unknown"/,
    "a draft with no coordinate must be posted as unknown precision");
  assert.match(src, /location_source/, "the wire payload must carry where the point came from");
});

test("the form says out loud when an address has no point", () => {
  const src = read(path.join(WEB, "app/reportar/page.tsx"));
  assert.match(
    src,
    /sin punto en el mapa/,
    "the family must be told that a typed address is not on the map yet — " +
      "silence here is what caused the incident this test exists for"
  );
});

test("the geocoder suggests, it never assigns", () => {
  const src = read(path.join(WEB, "lib/geo.ts"));
  // geocode() returns a list. Nothing in it may write a draft.
  assert.equal(/\bset\s*\(/.test(src), false, "lib/geo.ts must not mutate the draft");
  assert.match(src, /Promise<Place\[\]>/, "geocode must return candidates");
  const form = read(path.join(WEB, "app/reportar/page.tsx"));
  const auto = /geocode\([^)]*\)[\s\S]{0,120}applyPlace\(/.test(form);
  assert.equal(auto, false, "a geocoder result must be applied by a tap, never automatically");
});

test("every geocoder result is bounded to the incident", () => {
  const src = read(path.join(WEB, "lib/geo.ts"));
  assert.match(src, /bounded:\s*"1"/, "the query must be bounded to the incident viewbox");
  assert.match(src, /withinIncident\(p\.lat, p\.lng\)/,
    "results must be filtered again locally — a mirror may ignore the bounding box, " +
      "and a point 500 km away reads as a second collapse site, not as an error");
});

test("shipped landmarks carry coordinates and sit inside the incident box", () => {
  const src = read(path.join(WEB, "lib/incident.ts"));
  const mod = src.replace(/process\.env\.[A-Z_]+/g, '""');
  const lats = [...mod.matchAll(/lat:\s*(-?\d+\.?\d*),\s*lng:\s*(-?\d+\.?\d*)/g)];
  assert.ok(lats.length >= 6, "a landmark without coordinates is the original bug in list form");
  const box = /bbox:\s*\{\s*minLat:\s*(-?\d+\.?\d*),\s*minLng:\s*(-?\d+\.?\d*),\s*maxLat:\s*(-?\d+\.?\d*),\s*maxLng:\s*(-?\d+\.?\d*)/.exec(mod);
  assert.ok(box, "the incident must declare a bounding box");
  const [minLat, minLng, maxLat, maxLng] = box.slice(1).map(Number);
  for (const m of lats) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    assert.ok(lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng,
      `landmark at ${lat},${lng} is outside the incident box`);
  }
});

test("the point for a case is chosen, never averaged", () => {
  // avg(lat), avg(lng) over a case's reports puts it between a GPS fix and a
  // neighbourhood guess — a spot nobody named, and in Quibdó quite possibly the
  // river. 0011 takes the most precise point instead.
  const dir = path.join(ROOT, "db/migrations");
  const latest = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().reverse();
  const withRefresh = latest.find((f) => read(path.join(dir, f)).includes("FUNCTION public.refresh_person_index"));
  assert.ok(withRefresh, "refresh_person_index must exist");
  const sql = read(path.join(dir, withRefresh!));
  assert.equal(
    /avg\(\(r\.payload->>'last_seen_lat'\)/.test(sql),
    false,
    "the newest definition of refresh_person_index still averages coordinates"
  );
  assert.match(sql, /ORDER BY pri DESC, at DESC/, "the point must be picked by precision, then recency");
  assert.match(sql, /case_location_override/, "an operator-placed point must win over reported ones");
});

test("unmapped cases are a queue, not an absence", () => {
  const sql = read(path.join(ROOT, "db/migrations/0011_location_provenance.sql"));
  assert.match(sql, /CREATE OR REPLACE VIEW public\.unmapped_case/);
  const panel = read(path.join(ROOT, "services/api/src/routes/panel.ts"));
  assert.match(panel, /\/v1\/panel\/unmapped/, "operators must be able to see the queue");
  assert.match(panel, /\/v1\/panel\/cases\/:id\/location/, "and to resolve it");
  assert.match(panel, /case_location_override/,
    "an operator's point goes to the override table — a report is what a citizen said " +
      "and must not be rewritten to record what staff later worked out");
});

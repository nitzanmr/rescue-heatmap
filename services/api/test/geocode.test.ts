// The geocoder's job here is to be distrusted correctly. These tests use real
// shapes returned by Nominatim on 12 Aug 2026 for this data — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { grade, pickBest, buildQuery, municipalityMatches, type RawResult } from "../src/geocode.js";

const UTP: RawResult = {
  lat: "4.7943151",
  lon: "-75.6888918",
  display_name: "Universidad Tecnológica de Pereira, Pereira, Risaralda, Colombia",
  category: "amenity",
  type: "university",
  place_rank: 30,
  addresstype: "amenity",
  address: { amenity: "Universidad Tecnológica de Pereira", city: "Pereira", state: "Risaralda" },
};

// The trap: the NAME matched, the PLACE did not. This is the sector named
// after the park, ~900 m across, centred on nothing in particular.
const PARQUE_SECTOR: RawResult = {
  lat: "4.8149048",
  lon: "-75.6882306",
  display_name: "Sector Parque La Libertad, Centro, Pereira, Risaralda, Colombia",
  category: "boundary",
  type: "administrative",
  place_rank: 18,
  addresstype: "suburb",
  address: { suburb: "Sector Parque La Libertad", city: "Pereira", state: "Risaralda" },
};

const CITY: RawResult = {
  lat: "4.8133",
  lon: "-75.6961",
  display_name: "Pereira, Risaralda, Colombia",
  category: "place",
  type: "city",
  place_rank: 16,
  addresstype: "city",
  address: { city: "Pereira", state: "Risaralda" },
};

const WRONG_TOWN: RawResult = {
  lat: "4.6097",
  lon: "-74.0817",
  display_name: "Parque Central, Bogotá, Colombia",
  category: "leisure",
  type: "park",
  place_rank: 30,
  addresstype: "leisure",
  address: { leisure: "Parque Central", city: "Bogotá", state: "Bogotá D.C." },
};

test("a campus is a structure a team can be sent to", () => {
  const g = grade(UTP, "Pereira, Risaralda");
  assert.equal(g.precision, "exact");
  assert.equal(g.reason, null);
  assert.ok(g.lat && g.lat > 4 && g.lat < 5);
});

test("a boundary named after the place is not the place", () => {
  const g = grade(PARQUE_SECTOR, "Pereira, Risaralda");
  assert.equal(g.precision, "area");
  // The coordinate is kept for a reviewer to look at, but the grade forbids it
  // from ever being treated as a dig site.
  assert.ok(g.reason?.includes("named after"));
});

test("falling back to the municipality centroid is named and shamed", () => {
  assert.equal(grade(CITY, "Pereira, Risaralda").precision, "town");
});

test("a perfect match in the wrong municipality yields no coordinate at all", () => {
  const g = grade(WRONG_TOWN, "Quibdó, Chocó");
  assert.equal(g.precision, "none");
  assert.equal(g.lat, null, "a point 400 km away must not survive as a suggestion");
  assert.ok(g.reason?.includes("wrong municipality"));
});

test("the most precise result wins, not the most popular one", () => {
  // Nominatim ranks by importance: the famous sector comes back first.
  const best = pickBest([PARQUE_SECTOR, UTP], "Pereira");
  assert.equal(best.precision, "exact");
});

test("nothing found is a graded answer too, not an exception", () => {
  const best = pickBest([], "Pereira");
  assert.equal(best.precision, "none");
  assert.equal(best.lat, null);
});

test("the query is the label plus the town, never the whole sentence", () => {
  assert.equal(buildQuery("Hotel Dibeni", "Pereira, Risaralda"), "Hotel Dibeni, Pereira, Risaralda, Colombia");
  assert.equal(buildQuery("Hotel Dibeni", null), "Hotel Dibeni, Colombia");
});

test("municipality check ignores accents and word order, but not the town", () => {
  assert.ok(municipalityMatches("Quibdó, Chocó", { city: "Quibdo", state: "Chocó" }));
  assert.ok(!municipalityMatches("Quibdó", { city: "Cali", state: "Valle del Cauca" }));
  // Nothing claimed by the source: nothing to contradict, so it passes and the
  // grade alone decides.
  assert.ok(municipalityMatches(null, { city: "Cali" }));
});

test("a category is never sent to a gazetteer, but a town's one airport is", async () => {
  const { isGenericLabel } = await import("../src/place-clusters.js");
  assert.ok(isGenericLabel("clinica"), "bare 'clinica' names a kind, not a building");
  assert.ok(isGenericLabel("el edificio"));
  assert.ok(isGenericLabel("clinica, Pereira"), "a town has forty clinics");
  assert.ok(!isGenericLabel("aeropuerto de Pereira"), "a town has one airport");
  assert.ok(!isGenericLabel("Hotel Dibeni"));
  assert.ok(!isGenericLabel("clinica Comfamiliar"));
});

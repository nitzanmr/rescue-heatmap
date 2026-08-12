// Folding spellings into structures: the useful half and the dangerous half.
//
// The useful half is that one hotel written three ways is one hotel, and a
// count of 86 is the most actionable number in the whole import. The dangerous
// half is that the same machinery, one notch looser, merges Torre 1 into Torre
// 2 and sends a team into the building that did not fall. Most of the tests
// below are about the second half.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterKey, clusterPlaces, editDistance, mayFold } from "../src/place-clusters.js";

test("the same structure written three ways is one structure", () => {
  const rows = [
    { id: "1", place: "Hotel Dibeni - Pereira, Risaralda", municipality: "Pereira" },
    { id: "2", place: "hotel debani - Pereira, Risaralda", municipality: "Pereira" },
    { id: "3", place: "Dibeni Hotel - Pereira, Risaralda", municipality: "Pereira" },
    { id: "4", place: "HOTEL DIBENI - Pereira, Risaralda", municipality: "Pereira" },
  ];
  const clusters = clusterPlaces(rows);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 4);
  // The label is what most people wrote, and the fold is shown, not hidden.
  assert.ok(clusters[0].label.includes("dibeni"));
  assert.ok(clusters[0].variants.length >= 3);
});

test("word order does not split a building in half", () => {
  assert.equal(clusterKey("Hotel Dibeni"), clusterKey("Dibeni Hotel"));
  assert.equal(clusterKey("Edificio Ana Pilar"), clusterKey("Ana Pilar"));
});

test("a digit is never folded away: torre 1 is not torre 2", () => {
  const rows = [
    { id: "1", place: "Torres del Limonar bloque 1 - Cali, Valle del Cauca", municipality: "Cali" },
    { id: "2", place: "Torres del Limonar bloque 2 - Cali, Valle del Cauca", municipality: "Cali" },
  ];
  assert.equal(clusterPlaces(rows).length, 2);
  assert.equal(mayFold("limonar 1", "limonar 2"), false);
});

test("the same name in two municipalities is two places", () => {
  const rows = [
    { id: "1", place: "Parque Central - Pereira, Risaralda", municipality: "Pereira" },
    { id: "2", place: "Parque Central - Quibdó, Chocó", municipality: "Quibdó" },
  ];
  assert.equal(clusterPlaces(rows).length, 2);
});

test("short names are not folded — one letter would be the whole word", () => {
  assert.equal(mayFold("kena", "lena"), false);
  // Same consonants, different vowels: one name, spelled by two upset people.
  assert.equal(mayFold("dibeni", "debani"), true);
  // Different consonants at two edits: two names that merely look alike.
  assert.equal(mayFold("san jose", "san juan"), false);
  // s/z is the same sound in Colombian Spanish.
  assert.equal(mayFold("villa hermosa", "villa hermoza"), true);
});

test("bounded edit distance gives up instead of counting to infinity", () => {
  assert.equal(editDistance("abc", "abc"), 0);
  assert.equal(editDistance("abc", "abd"), 1);
  assert.ok(editDistance("abc", "xyzzy", 2) > 2);
});

test("only geocodable lines are nominated at all", () => {
  const rows = [
    // Municipality: real, common, and must never become a structure.
    { id: "1", place: "Pereira, Risaralda", municipality: "Pereira" },
    { id: "2", place: "Pereira, Risaralda", municipality: "Pereira" },
    { id: "3", place: "Pereira, Risaralda", municipality: "Pereira" },
    // A landmark inside a sentence about travelling: a sighting, not a site.
    { id: "4", place: "salió hacia el Parque la Libertad", municipality: "Pereira" },
    { id: "5", place: "no se sabe", municipality: "Pereira" },
    { id: "6", place: "Hotel Dibeni - Pereira, Risaralda", municipality: "Pereira" },
  ];
  const clusters = clusterPlaces(rows);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 1);
});

test("a line that is only a category word gathers no crowd", () => {
  const rows = [
    { id: "1", place: "Edificio Vanessa - Cali, Valle del Cauca", municipality: "Cali" },
    { id: "2", place: "edificio vanessa - Cali, Valle del Cauca", municipality: "Cali" },
  ];
  const c = clusterPlaces(rows);
  assert.equal(c.length, 1);
  assert.equal(c[0].key, "vanessa");
});

test("clusters come back biggest first — the queue is a priority order", () => {
  const rows = [
    { id: "a", place: "Edificio Ana Pilar - Cali, Valle del Cauca", municipality: "Cali" },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `h${i}`,
      place: "Hotel Dibeni - Pereira, Risaralda",
      municipality: "Pereira",
    })),
  ];
  const clusters = clusterPlaces(rows);
  assert.equal(clusters[0].count, 5);
  assert.ok(clusters[0].label.includes("dibeni"));
});

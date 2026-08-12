// What a free-text place is worth, before anyone geocodes it.
//
// Every string below is either taken from the harvested colombiatebusca file or
// modelled directly on one. The tests that matter most are the negative ones:
// this classifier's job is to REFUSE precision, and a bug here is invisible —
// it does not throw, it just puts a red cell on an empty plaza.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPlace, summariseResolutions, normalize } from "../src/place-resolution.js";

test("a named landmark is the only thing that earns a coordinate", () => {
  for (const s of [
    "Parque la Libertad - Pereira, Risaralda",
    "Iglesia San Francisco, Quibdó",
    "Colegio Carrasquilla, Quibdó, Chocó",
    "Terminal de Transportes de Pereira",
  ]) {
    const v = classifyPlace(s);
    assert.equal(v.resolution, "point", s);
    assert.equal(v.eligible, true, s);
  }
});

test("an address with a house number is a point; a street without one is not", () => {
  assert.equal(classifyPlace("Calle 12 # 34-56, Quibdó").resolution, "point");
  assert.equal(classifyPlace("Cra 8 No 12-30 barrio Yesquita").resolution, "point");
  assert.equal(classifyPlace("Avenida 6 con calle 4").resolution, "point");
  // Kilometres of asphalt. Useful to ask along, useless to dig on.
  const v = classifyPlace("Carrera 8, Quibdó");
  assert.equal(v.resolution, "neighbourhood");
  assert.equal(v.eligible, false);
});

test("a municipality is never a point, however confidently it is written", () => {
  for (const s of ["Pereira, Risaralda", "Quibdó, Chocó", "Chocó", "Cali"]) {
    const v = classifyPlace(s);
    assert.equal(v.resolution, "municipality", s);
    assert.equal(v.eligible, false, s);
  }
});

test("barrio-level text stops at neighbourhood", () => {
  for (const s of [
    "Barrio San Judas, Quibdó",
    "Comuna 5, Pereira",
    "Vereda Guayabal, Certeguí",
    "Corregimiento de Tutunendo",
  ]) {
    assert.equal(classifyPlace(s).resolution, "neighbourhood", s);
  }
});

test("a story about movement is not a location, even when it names a park", () => {
  // This is the case that would quietly poison the map: the landmark is real,
  // the sentence is about a route, and our cell claims "someone is under here".
  const v = classifyPlace("salió de la casa hacia el Parque la Libertad");
  assert.equal(v.resolution, "point");
  assert.equal(v.eligible, false);
  assert.ok(v.signals.some((s) => s.startsWith("movement:")));
  assert.ok(v.signals.includes("demoted:movement"));

  const plain = classifyPlace("salió de la casa hacia el trabajo");
  assert.equal(plain.resolution, "narrative");
  assert.equal(plain.eligible, false);
});

test("declared ignorance beats every other signal in the line", () => {
  // A town name does not rescue a sentence that says nobody knows.
  for (const s of ["No se sabe", "se desconoce el lugar, Pereira", "Sin información", "N/A"]) {
    const v = classifyPlace(s);
    assert.equal(v.resolution, "narrative", s);
    assert.equal(v.eligible, false, s);
  }
  // A lone dash is not a statement about knowledge, it is an unfilled field.
  assert.equal(classifyPlace("-").resolution, "none");
});

test("empty is 'none', not 'unknown place'", () => {
  for (const s of [null, undefined, "", "   "]) {
    assert.equal(classifyPlace(s as string | null).resolution, "none");
  }
});

test("a bare landmark noun names a category, not an address", () => {
  // "el parque" — which one? There are eleven. Not a point.
  assert.equal(classifyPlace("el parque").resolution, "neighbourhood");
  assert.equal(classifyPlace("la iglesia del barrio").resolution, "neighbourhood");
});

test("accents and casing are not part of the answer", () => {
  assert.equal(normalize("Parque la Libertad  -  PEREIRA"), "parque la libertad - pereira");
  assert.deepEqual(
    classifyPlace("PARQUE LA LIBERTAD, PEREIRA").resolution,
    classifyPlace("parque la libertad, pereira").resolution
  );
});

test("an unfamiliar short string is coarse, not precise", () => {
  // Being too coarse costs a row in a list. Being too precise costs a team's
  // hour at the wrong address, so the default has only one honest direction.
  const v = classifyPlace("Puerto Meluk");
  assert.equal(v.resolution, "municipality");
  assert.equal(v.eligible, false);
});

test("the histogram counts what the map is allowed to consider", () => {
  const s = summariseResolutions([
    "Parque la Libertad - Pereira",       // point, eligible
    "salió hacia el Parque la Libertad",  // point, not eligible
    "Barrio San Judas",                   // neighbourhood
    "Pereira, Risaralda",                 // municipality
    null,                                 // none
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.counts.point, 2);
  assert.equal(s.eligible, 1);
  assert.equal(s.counts.none, 1);
});

test("Colombian address shorthand is still an address", () => {
  // Real lines from the harvested file. The '#' is optional in practice and the
  // building family "Torres del ..." is the most common named block in Cali.
  assert.equal(classifyPlace("Cra 17 82 103 - Pereira, Risaralda").resolution, "point");
  assert.equal(classifyPlace("Carrera 53 14c-31 - Cali, Valle del Cauca").resolution, "point");
  assert.equal(classifyPlace("Cr 9 cll 13 - PEREIRA, Risaralda").resolution, "point");
  assert.equal(classifyPlace("Torres de limonar - Cali, Valle del Cauca").resolution, "point");
});

test("the appended municipality never drowns the line a relative typed", () => {
  // The harvester writes "<detail> - <municipality on the card>". Judging the
  // whole string made "Pampalinda - Cali, Valle del Cauca" a municipality,
  // because "cali" is in it; the head is what carries the precision.
  const v = classifyPlace("Barrio San Judas - Quibdó, Chocó");
  assert.equal(v.resolution, "neighbourhood");
  assert.ok(v.signals.includes("from:detail-head"));
  // And when the head says nothing, the coarse tail is the honest answer.
  assert.equal(classifyPlace("Pereira - Pereira, Risaralda").resolution, "municipality");
});

test("a place with no address is not a place we can map", () => {
  // "Su casa" is perfectly precise to the family and unusable to us. Making it
  // narrative keeps it out of the geocoder and into the questions-to-ask list.
  for (const s of ["Su casa - Pereira, Risaralda", "Estaba en casa - Pereira", "Su trabajo"]) {
    const v = classifyPlace(s);
    assert.equal(v.resolution, "narrative", s);
    assert.equal(v.eligible, false, s);
  }
  // Unless an actual address follows it.
  assert.equal(classifyPlace("Su casa en la calle 12 # 4-30").resolution, "point");
});

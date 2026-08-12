// The importer's pure half, tested without a database.
//
// These three functions are where an import can lie quietly: a misparsed date
// becomes a wrong "last seen", a permissive status mapping stops a search, and
// a payload that invents a coordinate puts a team on a plaza. Everything below
// is a case we actually saw in the harvested file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSourceDate, mapStatus, toPayload } from "../src/import-external.js";

test("parses both date shapes the source emits", () => {
  // Card listing format.
  assert.equal(parseSourceDate("12 Aug. 2026, 12:49 am"), "2026-08-12T00:49:00-05:00");
  assert.equal(parseSourceDate("11 Aug. 2026, 09:43 pm"), "2026-08-11T21:43:00-05:00");
  // Detail drawer format.
  assert.equal(parseSourceDate("12/08/2026 12:49 AM"), "2026-08-12T00:49:00-05:00");
});

test("an unparseable date is null, never now()", () => {
  // A fabricated timestamp on a missing-person record silently changes triage
  // order. Absent is honest; approximate is not.
  for (const s of [null, undefined, "", "ayer", "12 Xyz 2026, 01:00 am"]) {
    assert.equal(parseSourceDate(s as string | null), null);
  }
});

test("status mapping only ever moves toward 'still missing'", () => {
  assert.equal(mapStatus("found"), "found_safe");
  assert.equal(mapStatus("Localizada"), "found_safe");
  // Anything we do not recognise must keep the person on the list.
  assert.equal(mapStatus("desconocido"), "missing");
  assert.equal(mapStatus(null), "missing");
  assert.equal(mapStatus("missing"), "missing");
});

test("an imported record carries address text and never a coordinate", () => {
  const p = toPayload(
    {
      source_id: "x",
      name: "Oscuro Hugo Lince",
      age: 58,
      sex: "masculino",
      place_listing: "Pereira, Risaralda",
      last_seen_text: "Parque la Libertad - Pereira, Risaralda",
      status: "missing",
    },
    "colombiatebusca"
  );
  assert.equal(p.address_text, "Parque la Libertad - Pereira, Risaralda");
  assert.equal(p.location_accuracy, "unknown");
  // The whole point: a municipality name is not a point, and pretending it is
  // would manufacture a hot cell nobody reported.
  assert.equal((p as Record<string, unknown>).lat, undefined);
  assert.equal((p as Record<string, unknown>).lng, undefined);
});

test("an imported record never carries a reporter phone", () => {
  // Dedup penalises same-reporter pairs. A NULL is a true statement about what
  // we know; anything else corrupts the signal we tuned the engine on.
  const p = toPayload({ source_id: "x", name: "Ana", status: "missing" }, "colombiatebusca");
  assert.equal(p.reporter_phone, null);
  assert.equal(p.subject_phone, null);
});

test("falls back to the municipality when there is no detail text", () => {
  const p = toPayload(
    { source_id: "x", name: "Ana", place_listing: "Cali, Valle del Cauca", status: "missing" },
    "colombiatebusca"
  );
  assert.equal(p.address_text, "Cali, Valle del Cauca");
});

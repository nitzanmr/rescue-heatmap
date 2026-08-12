// Ask a gazetteer where a named structure is — and refuse to believe the answer
// more than it deserves.
//
// WHY THIS FILE IS SUSPICIOUS OF ITS OWN OUTPUT
//   A geocoder always answers. Ask it for "Parque la Libertad, Pereira" and it
//   returns a coordinate with the same confident shape whether it found the
//   park gate (20 m) or the administrative boundary of the neighbourhood named
//   after the park (900 m across). Live check, 12 Aug 2026:
//
//     Universidad Tecnológica de Pereira -> amenity/university, place_rank 30
//     Parque la Libertad, Pereira        -> boundary/administrative, rank 18
//
//   Both are "results". Only the first is a place a team can be sent to. So
//   every answer here is graded, and the grade travels with the coordinate:
//
//     exact   a building/amenity/aeroway feature, rank >= 26 — worth a visit
//     street  a road or an address line — a block, not a door
//     area    a boundary, suburb or neighbourhood — the NAME matched, the
//             PLACE did not. Never eligible for a cell.
//     town    the gazetteer fell back to the municipality centroid — this is
//             the failure mode that puts a hot cell on a town square.
//     none    nothing found, or found in the wrong municipality.
//
// WHAT IT STILL DOES NOT DO
//   It does not approve anything. A graded candidate is a suggestion attached
//   to a question; migration 0016 keeps it in separate columns from the
//   human-signed lat/lng, so no query can accidentally read a machine's guess
//   as a person's decision. `approved_place` is untouched.
//
// NETWORK MANNERS
//   Nominatim's usage policy: one request per second, a real User-Agent, and
//   cache what you already asked. All three are enforced below, and the cache
//   is on disk so a re-run costs nobody anything.

import fs from "node:fs";
import path from "node:path";
import { isGenericLabel } from "./place-clusters.js";

export type Precision = "exact" | "street" | "area" | "town" | "none";

export type GeocodeCandidate = {
  query: string;
  lat: number | null;
  lng: number | null;
  precision: Precision;
  /** The gazetteer's own name for what it found, for a reviewer to read. */
  displayName: string | null;
  category: string | null;
  type: string | null;
  placeRank: number | null;
  /** Why it is not usable, when it is not. Empty when precision is 'exact'. */
  reason: string | null;
  provider: string;
};

export const NO_MATCH: Omit<GeocodeCandidate, "query"> = {
  lat: null,
  lng: null,
  precision: "none",
  displayName: null,
  category: null,
  type: null,
  placeRank: null,
  reason: "no result",
  provider: "nominatim",
};

/** A Nominatim jsonv2 row, only the fields we are willing to depend on. */
export type RawResult = {
  lat: string;
  lon: string;
  display_name?: string;
  category?: string;
  class?: string;
  type?: string;
  place_rank?: number;
  addresstype?: string;
  address?: Record<string, string>;
};

const AREA_TYPES = new Set([
  "administrative", "suburb", "neighbourhood", "quarter", "borough",
  "city_district", "district", "residential", "locality", "hamlet",
]);

const TOWN_TYPES = new Set(["city", "town", "municipality", "village", "county", "state"]);

const POINT_CATEGORIES = new Set([
  "building", "amenity", "aeroway", "tourism", "shop", "leisure", "office",
  "healthcare", "man_made", "historic", "emergency", "railway",
]);

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Did the gazetteer answer about the town we asked about?
 *
 * This is the guard against the quiet catastrophe: "Parque Central" exists in
 * every municipality in Colombia, and a geocoder happily returns the one in
 * Bogotá for a case in Quibdó. A coordinate 400 km from the incident is not a
 * near miss, it is a team sent to another department.
 */
export function municipalityMatches(
  expected: string | null | undefined,
  address: Record<string, string> | undefined
): boolean {
  if (!expected) return true; // nothing claimed, nothing to contradict
  if (!address) return false;
  const hay = fold(Object.values(address).join(" "));
  const words = fold(expected).split(" ").filter((w) => w.length >= 4);
  if (!words.length) return true;
  // One municipality word is enough ("pereira" out of "pereira risaralda"),
  // because the department name alone would match half the country.
  return words.some((w) => hay.includes(w));
}

/** Grade a raw result. Exported so it can be tested without a network. */
export function grade(
  raw: RawResult | undefined,
  expectedMunicipality: string | null | undefined
): Omit<GeocodeCandidate, "query"> {
  if (!raw) return { ...NO_MATCH };

  const lat = Number(raw.lat);
  const lng = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ...NO_MATCH, reason: "unparseable coordinate" };
  }

  const category = raw.category ?? raw.class ?? null;
  const type = raw.type ?? null;
  const rank = typeof raw.place_rank === "number" ? raw.place_rank : null;
  const addressType = raw.addresstype ?? null;
  const base = {
    lat,
    lng,
    displayName: raw.display_name ?? null,
    category,
    type,
    placeRank: rank,
    provider: "nominatim",
  };

  if (!municipalityMatches(expectedMunicipality, raw.address)) {
    return {
      ...base,
      lat: null,
      lng: null,
      precision: "none" as const,
      reason: `wrong municipality (${raw.display_name ?? "?"})`,
    };
  }

  const t = type ?? "";
  const at = addressType ?? "";
  if (TOWN_TYPES.has(t) || TOWN_TYPES.has(at) || (rank !== null && rank <= 16)) {
    return { ...base, precision: "town", reason: "municipality centroid, not a structure" };
  }
  if (AREA_TYPES.has(t) || AREA_TYPES.has(at) || category === "boundary") {
    return { ...base, precision: "area", reason: "an area named after the place, not the place" };
  }
  if (t === "road" || at === "road" || category === "highway") {
    return { ...base, precision: "street", reason: "a street, not a structure" };
  }
  if (category && POINT_CATEGORIES.has(category) && (rank === null || rank >= 26)) {
    return { ...base, precision: "exact", reason: null };
  }
  if (rank !== null && rank >= 26) {
    return { ...base, precision: "street", reason: `unfamiliar feature (${category}/${type})` };
  }
  return {
    ...base,
    precision: "area",
    reason: `coarse feature (${category}/${type}, rank ${rank ?? "?"})`,
  };
}

/**
 * The text we send. Deliberately built from the label the reviewer sees plus
 * the municipality the source card carried — never from the whole free-text
 * line, which often contains a sentence about travelling to work.
 */
export function buildQuery(label: string, municipality: string | null | undefined): string {
  const muni = (municipality ?? "").trim();
  return [label.trim(), muni, "Colombia"].filter(Boolean).join(", ");
}

// --------------------------------------------------------------------- cache

type Cache = Record<string, Omit<GeocodeCandidate, "query">>;

export class GeocodeCache {
  private data: Cache = {};
  constructor(private file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8")) as Cache;
    } catch {
      this.data = {};
    }
  }
  get(q: string) {
    return this.data[q];
  }
  set(q: string, v: Omit<GeocodeCandidate, "query">) {
    this.data[q] = v;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }
  get size() {
    return Object.keys(this.data).length;
  }
}

// ------------------------------------------------------------------ provider

const UA =
  process.env.GEOCODER_USER_AGENT ??
  "rescue-heatmap/0.1 (disaster missing-persons triage; contact: github.com/nitzanmr/rescue-heatmap)";

const ENDPOINT = process.env.GEOCODER_URL ?? "https://nominatim.openstreetmap.org/search";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One structure -> one graded candidate. Rate-limited, cached, and it asks for
 * more than one result so that a boundary in first place does not hide a
 * building in second.
 */
export async function geocodeOne(
  label: string,
  municipality: string | null | undefined,
  cache?: GeocodeCache
): Promise<GeocodeCandidate> {
  const query = buildQuery(label, municipality);

  // A category is not a building. Asking anyway is worse than not asking: the
  // provider answers with a real, precise, arbitrary point.
  if (isGenericLabel(label)) {
    return {
      query,
      ...NO_MATCH,
      reason: "generic name — names a kind of building, not one building",
    };
  }

  const hit = cache?.get(query);
  if (hit) return { query, ...hit };

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "co");
  url.searchParams.set("addressdetails", "1");

  let graded: Omit<GeocodeCandidate, "query"> = { ...NO_MATCH };
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es" } });
    if (!res.ok) {
      graded = { ...NO_MATCH, reason: `provider said ${res.status}` };
    } else {
      const rows = (await res.json()) as RawResult[];
      graded = pickBest(rows, municipality);
    }
  } catch (e) {
    graded = { ...NO_MATCH, reason: `provider unreachable: ${(e as Error).message}` };
  }

  cache?.set(query, graded);
  return { query, ...graded };
}

/**
 * Prefer the most precise answer among the candidates, not the most "important"
 * one. Nominatim ranks by importance, which is popularity — and a famous
 * neighbourhood outranks the building inside it every time.
 */
export function pickBest(
  rows: RawResult[],
  expectedMunicipality: string | null | undefined
): Omit<GeocodeCandidate, "query"> {
  const order: Precision[] = ["exact", "street", "area", "town", "none"];
  let best: Omit<GeocodeCandidate, "query"> | null = null;
  for (const r of rows.slice(0, 5)) {
    const g = grade(r, expectedMunicipality);
    if (!best || order.indexOf(g.precision) < order.indexOf(best.precision)) best = g;
    if (best.precision === "exact") break;
  }
  return best ?? { ...NO_MATCH };
}

/** Geocode many, politely: one request per second, cache written as we go. */
export async function geocodeAll(
  items: { label: string; municipality: string | null }[],
  cache: GeocodeCache,
  opts: { delayMs?: number; onProgress?: (i: number, total: number, c: GeocodeCandidate) => void } = {}
): Promise<GeocodeCandidate[]> {
  const delay = opts.delayMs ?? 1100;
  const out: GeocodeCandidate[] = [];
  for (let i = 0; i < items.length; i++) {
    const cached = cache.get(buildQuery(items[i].label, items[i].municipality));
    const c = await geocodeOne(items[i].label, items[i].municipality, cache);
    out.push(c);
    opts.onProgress?.(i + 1, items.length, c);
    if (!cached && i < items.length - 1) await sleep(delay);
  }
  cache.save();
  return out;
}

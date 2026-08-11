// Turning what a person typed into a point on the map.
//
// The bug this module exists to fix: the form accepted an address as free text,
// nothing ever converted it into coordinates, and the form still let the family
// label that address "punto exacto". The report arrived complete-looking, the
// backend correctly indexed no location, and the person silently never appeared
// on the heat map. Nothing failed loudly anywhere.
//
// Three rules encoded here:
//
//   1. A geocoder SUGGESTS. It never assigns. Even a single result is shown for
//      confirmation, because "Calle 24" matches thousands of streets and the
//      cost of being wrong is a rescue team digging in the wrong place.
//   2. Everything is bounded to the incident. A result outside the incident box
//      is discarded, not ranked lower — a point 500 km away does not look like
//      an error on a map, it looks like a second collapse site.
//   3. Failure is stated, never swallowed. Offline, blocked, timed out: the UI
//      must say "saved as text, not on the map yet". Silence is what caused
//      this in the first place.
import { incident } from "./incident";

export type PlaceSource = "device_gps" | "map_pick" | "geocoded" | "landmark";

export interface Place {
  label: string;
  detail?: string;
  lat: number;
  lng: number;
  source: PlaceSource;
}

export class GeocoderUnavailable extends Error {
  constructor(public reason: "offline" | "network" | "timeout" | "disabled") {
    super(`geocoder unavailable: ${reason}`);
  }
}

export function withinIncident(lat: number, lng: number): boolean {
  const b = incident.bbox;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/** Offline gazetteer: the landmarks shipped with the build, matched loosely. */
export function searchLandmarks(q: string): Place[] {
  const needle = norm(q);
  if (!needle) return [];
  return incident.landmarks
    .filter((l) => norm(l.name).includes(needle) || needle.includes(norm(l.name)))
    .map((l) => ({ label: l.name, lat: l.lat, lng: l.lng, source: "landmark" as const }));
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Nominatim's usage policy allows this volume of interactive, user-triggered
// queries; it does NOT allow bulk or automatic ones. Hence: only on an explicit
// tap, never on keystroke. A self-hosted geocoder can be pointed at with
// NEXT_PUBLIC_GEOCODER_URL and is what a real activation should use.
const GEOCODER = process.env.NEXT_PUBLIC_GEOCODER_URL ?? "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 7000;

export async function geocode(q: string): Promise<Place[]> {
  const text = q.trim();
  if (text.length < 3) return [];
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new GeocoderUnavailable("offline");
  }
  const b = incident.bbox;
  const params = new URLSearchParams({
    q: `${text}, ${incident.city}, ${incident.country}`,
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    countrycodes: incident.countryCode.toLowerCase(),
    // viewbox is left,top,right,bottom; bounded=1 makes it a hard filter.
    viewbox: `${b.minLng},${b.maxLat},${b.maxLng},${b.minLat}`,
    bounded: "1",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let raw: unknown;
  try {
    const res = await fetch(`${GEOCODER}?${params}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new GeocoderUnavailable("network");
    raw = await res.json();
  } catch (e) {
    if (e instanceof GeocoderUnavailable) throw e;
    throw new GeocoderUnavailable(ctrl.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }

  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return rows
    .map((r) => ({
      label: String(r.display_name ?? "").split(",").slice(0, 2).join(",").trim(),
      detail: String(r.display_name ?? ""),
      lat: Number(r.lat),
      lng: Number(r.lon),
      source: "geocoded" as const,
    }))
    // Belt and braces over `bounded=1`: the server-side filter is not ours to
    // trust, and a mirror or a self-hosted instance may ignore it entirely.
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && withinIncident(p.lat, p.lng));
}

/**
 * How precise a point is allowed to claim to be, given where it came from.
 *
 * "exact" is a statement about a coordinate, not about a sentence. A geocoded
 * street match is a building at best; a landmark is a block. Letting the family
 * tick "punto exacto" over an address nobody resolved is how a text string ends
 * up weighted like a GPS fix in the heat map.
 */
export const ACCURACY_CEILING: Record<PlaceSource, "exact" | "building" | "block"> = {
  device_gps: "exact",
  map_pick: "exact",
  geocoded: "building",
  landmark: "block",
};

// Aid sites: shelters, hospitals, pharmacies, fire/police, collection points.
//
// This is the layer that makes the public map worth opening for someone who has
// not lost anybody — "where do I go" — and it is the only layer we can build
// BEFORE an event. Which is the point: after the Venezuela event we were three
// days late, and three days late is the same as absent.
//
// Source of record is OpenStreetMap via Overpass, because it is the only global
// dataset that (a) exists for a mid-size Latin American city before a disaster,
// (b) is licensed for redistribution (ODbL — attribution is mandatory, see
// ATTRIBUTION below), and (c) can be re-pulled in minutes for a new bbox.
//
// OSM is a STARTING POINT, never truth: `source: 'osm'` rows are unverified by
// construction. A site a liaison physically confirmed carries verified_at, and
// the map draws the two differently. Telling a family to walk to a shelter that
// collapsed is a failure mode we own.
import { readFileSync } from "node:fs";

export const ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

export type AidKind =
  | "shelter"
  | "shelter_candidate"
  | "medical"
  | "pharmacy"
  | "responder"
  | "supply"
  | "water"
  | "morgue"
  | "info_point"
  | "other";

export interface AidSite {
  kind: AidKind;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  phone?: string | null;
  capacity?: number | null;
  source: string;
  source_ref?: string | null;
  source_url?: string | null;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

type Tags = Record<string, string>;

// OSM tags -> our kinds. Order matters: the first match wins.
//
// The interesting one is `school -> shelter_candidate`. In Latin American
// disaster response schools are the default mass shelter, but a school is NOT a
// shelter until somebody opens it. Publishing them as "shelter" would send
// people to locked gates; publishing them as nothing throws away the list every
// coordinator asks for on day one. So: a separate kind, drawn muted, off by
// default in the public layer.
const RULES: Array<[(t: Tags) => boolean, AidKind]> = [
  [(t) => t.emergency === "shelter" || t.amenity === "shelter" || t.social_facility === "shelter", "shelter"],
  [(t) => t.amenity === "hospital" || t.healthcare === "hospital", "medical"],
  [(t) => t.amenity === "clinic" || t.amenity === "doctors" || Boolean(t.healthcare), "medical"],
  [(t) => t.amenity === "pharmacy", "pharmacy"],
  [(t) => t.amenity === "fire_station" || t.amenity === "police", "responder"],
  [(t) => t.amenity === "community_centre" || Boolean(t.social_facility), "shelter_candidate"],
  [(t) => t.amenity === "school" || t.amenity === "college" || t.amenity === "university", "shelter_candidate"],
  [(t) => t.amenity === "drinking_water" || t.man_made === "water_tower", "water"],
];

export function classify(tags: Tags): AidKind | null {
  for (const [match, kind] of RULES) if (match(tags)) return kind;
  return null;
}

function addressOf(t: Tags): string | null {
  const parts = [
    [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "),
    t["addr:suburb"] || t["addr:neighbourhood"],
    t["addr:city"],
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
}

// Overpass -> AidSite[]. Pure, so the mapping is testable without a network.
export function fromOverpass(elements: OverpassElement[]): AidSite[] {
  const out: AidSite[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    // An unnamed point is unusable on a map a frightened person reads out loud.
    const name = tags.name || tags["name:es"] || tags.operator;
    if (!name) continue;
    out.push({
      kind,
      name,
      lat,
      lng,
      address: addressOf(tags),
      phone: tags.phone || tags["contact:phone"] || null,
      capacity: tags.capacity ? Number(tags.capacity) || null : null,
      source: "osm",
      source_ref: `${el.type}/${el.id}`,
      source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    });
  }
  return out;
}

export function overpassQuery(bbox: BBox): string {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:90];
(
  nwr["amenity"~"^(hospital|clinic|doctors|pharmacy|fire_station|police|shelter|community_centre|school|college|university|drinking_water)$"](${b});
  nwr["emergency"="shelter"](${b});
  nwr["healthcare"](${b});
  nwr["social_facility"](${b});
);
out center tags;`;
}

export async function fetchOverpass(bbox: BBox, endpoint = "https://overpass-api.de/api/interpreter"): Promise<AidSite[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Overpass answers 406 to a request with no identifiable agent, and its
      // usage policy asks for a contact. Not optional politeness: an anonymous
      // bulk puller is the first thing they block.
      "user-agent": "rescue-heatmap/0.1 (+https://github.com/nitzanmr/rescue-heatmap)",
    },
    body: new URLSearchParams({ data: overpassQuery(bbox) }),
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const json = (await res.json()) as { elements: OverpassElement[] };
  return fromOverpass(json.elements ?? []);
}

// GeoJSON is the interchange format on disk: it opens in QGIS, in geojson.io and
// in any browser, so a non-programmer on the delegation can eyeball the file
// before it becomes the map 8,000 people are looking at.
export function toGeoJSON(sites: AidSite[]) {
  return {
    type: "FeatureCollection" as const,
    attribution: ATTRIBUTION,
    features: sites.map((s) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      properties: {
        kind: s.kind,
        name: s.name,
        address: s.address ?? null,
        phone: s.phone ?? null,
        capacity: s.capacity ?? null,
        source: s.source,
        source_ref: s.source_ref ?? null,
        source_url: s.source_url ?? null,
      },
    })),
  };
}

export function fromGeoJSONFile(file: string): AidSite[] {
  const fc = JSON.parse(readFileSync(file, "utf8"));
  return (fc.features ?? []).map((f: any) => ({
    kind: f.properties.kind as AidKind,
    name: f.properties.name,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    address: f.properties.address ?? null,
    phone: f.properties.phone ?? null,
    capacity: f.properties.capacity ?? null,
    source: f.properties.source ?? "file",
    source_ref: f.properties.source_ref ?? null,
    source_url: f.properties.source_url ?? null,
  }));
}

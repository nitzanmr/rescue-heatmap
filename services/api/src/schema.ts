import { z } from "zod";

// Mirrors app/web/src/lib/schema.ts and docs/form-spec.md.
// A channel that cannot capture a field leaves it null — the intake schema is
// deliberately permissive: rejecting a report during an earthquake because a
// field failed validation is the worst possible failure mode.
export const genderEnum = z.enum(["m", "f", "other", "unknown"]);
export const accuracyEnum = z.enum(["exact", "building", "block", "neighbourhood", "unknown"]);
// Where the coordinate came from. Accuracy is a claim ABOUT a coordinate; this
// records whether one exists at all. A report whose source is "none" carries an
// address as text and is invisible to the heat map until an operator maps it.
export const locationSourceEnum = z.enum(["device_gps", "map_pick", "geocoded", "landmark", "none"]);

/**
 * The one location invariant, applied to every channel, in one place.
 *
 * The bug it closes: the form let a family label a typed address "exact" while
 * no geocoding ever happened, so the payload claimed precision it did not have
 * and the case dropped out of the map without an error anywhere. Precision
 * without a point is not a small inaccuracy, it is a false statement that a
 * later operator reads as verified.
 *
 * Deliberately a normaliser and NOT a rejection: refusing a report during an
 * earthquake is the worst failure mode there is. We accept, and we downgrade
 * the claim to what the data supports.
 */
export function normaliseLocation<T extends {
  last_seen_lat?: number | null;
  last_seen_lng?: number | null;
  location_accuracy?: string;
  location_source?: string;
}>(r: T): T & { location_source: string; unmapped: boolean } {
  const hasPoint = r.last_seen_lat != null && r.last_seen_lng != null;
  if (!hasPoint) {
    return { ...r, last_seen_lat: null, last_seen_lng: null, location_accuracy: "unknown", location_source: "none", unmapped: true };
  }
  const ceiling: Record<string, string> = {
    device_gps: "exact", map_pick: "exact", geocoded: "building", landmark: "block",
  };
  const source = r.location_source && r.location_source !== "none" ? r.location_source : "map_pick";
  const rank: Record<string, number> = { exact: 3, building: 2, block: 1, neighbourhood: 0, unknown: 0 };
  const cap = ceiling[source] ?? "block";
  const claimed = r.location_accuracy ?? cap;
  const accuracy = rank[claimed] > rank[cap] ? cap : claimed;
  return { ...r, location_accuracy: accuracy, location_source: source, unmapped: false };
}
export const statusEnum = z.enum([
  "missing", "trapped_alive", "found_safe", "found_injured", "deceased", "withdrawn",
]);
export const channelEnum = z.enum(["pwa", "whatsapp", "sms", "paper", "node", "field", "import"]);

export const reportInput = z.object({
  // system
  uuid: z.string().min(8).max(64).optional(),          // device-generated, idempotency key
  incident_slug: z.string().min(1).max(64).optional(),
  channel: channelEnum.default("pwa"),
  node_id: z.string().max(64).nullish(),
  created_at_device: z.string().datetime().optional(),
  source_ref: z.string().max(200).nullish(),

  // missing person
  full_name: z.string().min(2).max(200),
  age_approx: z.number().int().min(0).max(120).nullish(),
  gender: genderEnum.optional(),
  distinguishing_info: z.string().max(4000).nullish(),
  medical_info: z.string().max(2000).nullish(),
  national_id_last4: z.string().regex(/^\d{4}$/).nullish(),
  is_minor: z.boolean().optional(),
  // The MISSING PERSON's own number, not the reporter's. Two fields, because
  // the engine used to score the reporter's phone as if it identified the
  // subject: "the same person filed both reports" then looked like "the same
  // human being", which was the strongest false-merge signal we had and fired
  // hardest on a parent reporting several children (docs/dedup-review.md F1).
  // Often unknown; when present it is highly discriminative.
  subject_phone: z.string().max(40).nullish(),

  // location
  last_seen_lat: z.number().min(-90).max(90).nullish(),
  last_seen_lng: z.number().min(-180).max(180).nullish(),
  location_accuracy: accuracyEnum.optional(),
  location_source: locationSourceEnum.optional(),
  last_seen_address: z.string().max(500).nullish(),
  building_name: z.string().max(200).nullish(),
  floor: z.string().max(20).nullish(),
  apartment: z.string().max(20).nullish(),

  // timing
  last_contact_at: z.string().datetime().nullish(),
  last_contact_precision: z.enum(["exact", "same_day", "approximate", "unknown"]).optional(),

  // reporter — this phone identifies whoever filled the form. It is contact
  // information and a rate-limit key, never evidence about the subject.
  reporter_name: z.string().max(200).nullish(),
  reporter_phone: z.string().max(40).nullish(),
  reporter_relation: z
    .enum(["family", "neighbour", "friend", "colleague", "witness", "other"]).optional(),
  reporter_lang: z.string().max(10).optional(),

  // consent — two separate decisions (ADR-001)
  consent_public_listing: z.boolean().default(true),
  consent_photo_public: z.boolean().default(false),

  status: statusEnum.default("missing"),

  // The dedup modal's answer, travelling WITH the report instead of firing an
  // orphan note at submit time. The reference number of the existing case the
  // reporter picked when asked "¿Es la misma persona?". It has to ride the
  // payload because the new report has no id until the server accepts it —
  // any client-side attempt to link the two runs before one of them exists
  // (docs: 0017). Resolved server-side by link_reporter_confirmation(); a bad
  // or stale reference never rejects the report.
  confirmed_same_as: z.string().min(4).max(24).nullish(),
});
export type ReportInput = z.infer<typeof reportInput>;

export const sightingInput = z.object({
  kind: z.enum(["seen", "safe", "hospital", "shelter", "deceased", "correction"]),
  note: z.string().max(2000).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  reported_at: z.string().datetime().nullish(),
  contact_phone: z.string().max(40).nullish(),
});

export const reporterUpdate = z.object({
  // What a family may correct from their private link. Deliberately narrow:
  // the identity of the person is not editable, only what we know about them.
  last_seen_address: z.string().max(500).nullish(),
  last_seen_lat: z.number().min(-90).max(90).nullish(),
  last_seen_lng: z.number().min(-180).max(180).nullish(),
  location_accuracy: accuracyEnum.optional(),
  location_source: locationSourceEnum.optional(),
  building_name: z.string().max(200).nullish(),
  floor: z.string().max(20).nullish(),
  apartment: z.string().max(20).nullish(),
  distinguishing_info: z.string().max(4000).nullish(),
  medical_info: z.string().max(2000).nullish(),
  last_contact_at: z.string().datetime().nullish(),
  status: z.enum(["missing", "found_safe", "withdrawn"]).optional(),
  consent_public_listing: z.boolean().optional(),
  consent_photo_public: z.boolean().optional(),
});

// An operator placing the point an address never resolved to. 'exact' is not
// offered: staff working from a written address are locating a building at best,
// and a coordinate that claims to be exact is one nobody re-checks.
export const operatorLocation = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.enum(["building", "block", "neighbourhood"]).default("building"),
  note: z.string().max(500).nullish(),
});

// ---------------------------------------------------------------------------
// Structures (0018). A building is the unit a rescue team is dispatched to, and
// "clear" is the sentence that stops people digging — so every write here is
// narrow, graded and signed.
// ---------------------------------------------------------------------------

// Same vocabulary as the database and as place_nomination.cand_precision. Note
// what is missing: 'exact'. Staff working from a written address are locating a
// building at best.
export const structurePrecisionEnum = z.enum(["building", "street", "area", "town"]);
export const scanStateEnum = z.enum([
  "not_scanned", "in_progress", "partial", "clear", "unsafe", "unreachable",
]);
export const structureResolutionEnum = z.enum([
  "unresolved", "recovered_alive", "recovered_deceased", "not_at_structure", "withdrawn",
]);

export const structureInput = z.object({
  key: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/,
    "key is a slug: lowercase letters, digits and hyphens"),
  name: z.string().min(2).max(200),
  address_text: z.string().max(300).nullish(),
  neighbourhood: z.string().max(120).nullish(),
  municipality: z.string().max(120).nullish(),
  authority_status: z.enum(["unverified", "reported", "confirmed"]).default("unverified"),
  authority_source: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
});

// A point is never part of creation: it arrives through its own signed call, so
// that "somebody typed a building name" and "somebody put a pin on the map" can
// never be the same event.
export const structurePoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  precision: structurePrecisionEnum,
  source: z.enum(["operator_pin", "osm", "nominatim", "reported", "import"]).default("operator_pin"),
  note: z.string().max(500).nullish(),
});

export const structureScan = z.object({
  scan_state: scanStateEnum,
  note: z.string().max(1000).nullish(),
});

export const structureLink = z.object({
  case_id: z.string().uuid(),
  link_source: z.enum(["reported", "nomination", "operator", "import"]).default("operator"),
  confidence: z.enum(["reported", "inferred", "confirmed"]).default("reported"),
  note: z.string().max(500).nullish(),
});

export const structureResolve = z.object({
  resolution: structureResolutionEnum,
  note: z.string().max(1000).nullish(),
});

export const statusUpdate = z.object({
  status: statusEnum,
  status_source: z.enum(["citizen", "verified_field", "official"]).default("verified_field"),
  note: z.string().max(1000).nullish(),
});

export const publicSearchQuery = z.object({
  // A name is mandatory: without it this is a downloadable list of vulnerable
  // people, which is exactly what we promised not to build.
  q: z.string().min(3).max(120),
  incident: z.string().max(64).optional(),
  status: statusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const decisionInput = z.object({
  decision: z.enum(["merge", "reject"]),
  survivor_case_id: z.string().uuid().optional(),
  note: z.string().max(1000).nullish(),
});

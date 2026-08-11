import { z } from "zod";

// Mirrors app/web/src/lib/schema.ts and docs/form-spec.md.
// A channel that cannot capture a field leaves it null — the intake schema is
// deliberately permissive: rejecting a report during an earthquake because a
// field failed validation is the worst possible failure mode.
export const genderEnum = z.enum(["m", "f", "other", "unknown"]);
export const accuracyEnum = z.enum(["exact", "building", "block", "neighbourhood", "unknown"]);
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

  // location
  last_seen_lat: z.number().min(-90).max(90).nullish(),
  last_seen_lng: z.number().min(-180).max(180).nullish(),
  location_accuracy: accuracyEnum.optional(),
  last_seen_address: z.string().max(500).nullish(),
  building_name: z.string().max(200).nullish(),
  floor: z.string().max(20).nullish(),
  apartment: z.string().max(20).nullish(),

  // timing
  last_contact_at: z.string().datetime().nullish(),
  last_contact_precision: z.enum(["exact", "same_day", "approximate", "unknown"]).optional(),

  // reporter
  reporter_name: z.string().max(200).nullish(),
  reporter_phone: z.string().max(40).nullish(),
  reporter_relation: z
    .enum(["family", "neighbour", "friend", "colleague", "witness", "other"]).optional(),
  reporter_lang: z.string().max(10).optional(),

  // consent — two separate decisions (ADR-001)
  consent_public_listing: z.boolean().default(true),
  consent_photo_public: z.boolean().default(false),

  status: statusEnum.default("missing"),
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

// Single shared report schema — every intake channel writes THIS.
// Mirrors docs/form-spec.md. A channel that cannot capture a field leaves it null.

export type Gender = "m" | "f" | "other" | "unknown";
export type LocationAccuracy = "exact" | "building" | "block" | "neighbourhood" | "unknown";
// WHERE the coordinate came from. Accuracy describes a point; this says whether
// a point exists at all and who put it there. "none" means the report carries an
// address as text only and is invisible to the heat map until somebody maps it.
export type LocationSource = "device_gps" | "map_pick" | "geocoded" | "landmark" | "none";
export type Status = "missing" | "trapped_alive" | "found_safe" | "found_injured" | "deceased" | "withdrawn";
export type StatusSource = "citizen" | "verified_field" | "official";
export type Channel = "pwa" | "whatsapp" | "sms" | "paper" | "node" | "field";
export type SyncState = "queued" | "sent" | "acked" | "conflict";

export interface Report {
  // system
  uuid: string;
  reference_number: string;
  incident_id: string;
  channel: Channel;
  node_id?: string | null;
  created_at_device: string;
  received_at_server?: string | null;
  sync_state: SyncState;

  // missing person
  full_name: string;
  age_approx?: number | null;
  gender?: Gender;
  photo_data_url?: string | null;
  distinguishing_info?: string | null;
  medical_info?: string | null;
  national_id_last4?: string | null;
  is_minor?: boolean;
  // The missing person's own number — NOT reporter_phone below. Kept apart on
  // purpose: the reporter's number identifies who filled the form, and scoring
  // it as the subject's is what made one parent's four reports look like one
  // child (docs/dedup-review.md F1).
  subject_phone?: string | null;

  // location
  last_seen_lat?: number | null;
  last_seen_lng?: number | null;
  location_accuracy?: LocationAccuracy;
  location_source?: LocationSource;
  last_seen_address?: string | null;
  building_name?: string | null;
  floor?: string | null;
  apartment?: string | null;

  // timing
  last_contact_at?: string | null;
  last_contact_precision?: "exact" | "same_day" | "approximate" | "unknown";

  // The dedup modal's answer: the reference number of the existing case this
  // reporter said is the same person. Rides the payload through the offline
  // outbox — the new report has no server id until it is accepted, so the link
  // can only be made on arrival. Passed to commit() directly, never written to
  // the draft: a confirmation about THIS submission must not survive into the
  // next family's report via localStorage.
  confirmed_same_as?: string | null;

  // reporter
  reporter_name?: string | null;
  reporter_phone?: string | null;
  reporter_relation?: "family" | "neighbour" | "friend" | "colleague" | "witness" | "other";
  reporter_lang?: string;

  // consent — deliberately GRANULAR (ADR-001).
  // Listing and photo are two separate decisions: agreeing to be searchable by
  // name is not agreeing to have your face on a public page.
  consent_public_listing?: boolean; // name, approx age, area, status in public search
  consent_photo_public?: boolean;   // photo shown publicly — opt-IN, never default on
  consent_recorded_at?: string | null;

  // lifecycle
  status: Status;
  status_source: StatusSource;
  status_updated_at: string;

  // dedup
  dedup_cluster_id?: string | null;
  dedup_reviewed?: boolean;
  reporter_count?: number; // how many people reported this same person = signal strength
}

// Deliberately NOT here any more:
//
//   newReferenceNumber() — the reference is issued by the server. A client that
//     mints one prints a different number on every retry of the same report, and
//     the family writes down the one that does not exist.
//   reportWeight()       — the heat weighting lives in SQL (public.heat_cells).
//     Two implementations of the same formula drift, and the one on the map
//     would stop matching the one the rescue teams are ranked by.
//   findDuplicates()     — correlation is the server's job (correlate_case).
//     A weaker second opinion in the browser is how you get a family told
//     "no duplicates" about a person the engine already flagged.

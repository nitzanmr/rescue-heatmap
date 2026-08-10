// Single shared report schema — every intake channel writes THIS.
// Mirrors docs/form-spec.md. A channel that cannot capture a field leaves it null.

export type Gender = "m" | "f" | "other" | "unknown";
export type LocationAccuracy = "exact" | "building" | "block" | "neighbourhood" | "unknown";
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

  // location
  last_seen_lat?: number | null;
  last_seen_lng?: number | null;
  location_accuracy?: LocationAccuracy;
  last_seen_address?: string | null;
  building_name?: string | null;
  floor?: string | null;
  apartment?: string | null;

  // timing
  last_contact_at?: string | null;
  last_contact_precision?: "exact" | "same_day" | "approximate" | "unknown";

  // reporter
  reporter_name?: string | null;
  reporter_phone?: string | null;
  reporter_relation?: "family" | "neighbour" | "friend" | "colleague" | "witness" | "other";
  reporter_lang?: string;

  // lifecycle
  status: Status;
  status_source: StatusSource;
  status_updated_at: string;

  // dedup
  dedup_cluster_id?: string | null;
  dedup_reviewed?: boolean;
  reporter_count?: number; // how many people reported this same person = signal strength
}

export function newReferenceNumber(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${s}`;
}

export function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Heatmap weighting: confidence × urgency. This is what makes the map useful.
export function reportWeight(r: Report): number {
  const acc: Record<LocationAccuracy, number> = {
    exact: 1,
    building: 0.9,
    block: 0.6,
    neighbourhood: 0.35,
    unknown: 0.15,
  };
  const base = acc[r.location_accuracy ?? "unknown"];
  const urgency = r.status === "trapped_alive" ? 2.5 : r.status === "missing" ? 1 : 0.2;
  const corroboration = Math.min(1 + ((r.reporter_count ?? 1) - 1) * 0.25, 2);
  return base * urgency * corroboration;
}

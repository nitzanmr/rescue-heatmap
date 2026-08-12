// What the OUTSIDE world is allowed to see about a report.
// Single source of truth: the public search page, the shareable card and the
// personal /r/<ref> page all read from here. If a field is not returned by this
// module it must never leave the coordination panel.
import { Report } from "./schema";
import { incident } from "./incident";
import type { PublicCase } from "./api";

export function isMinor(r: Report): boolean {
  return Boolean(r.is_minor) || (typeof r.age_approx === "number" && r.age_approx < 18);
}

export function canListPublicly(r: Report): boolean {
  // Listing consent is opt-OUT: undefined means consent. Only an explicit false hides it.
  return r.consent_public_listing !== false && r.status !== "withdrawn";
}

export function canShowPhotoPublicly(r: Report): boolean {
  return Boolean(r.photo_data_url) && r.consent_photo_public === true;
}

// Building-level words. Naming the exact building on a card broadcast to
// thousands of strangers is a precise location, not an "area" — it tells anyone
// which pile of rubble to walk to, and which flat is now empty.
const BUILDING_WORDS =
  /\b(edificio|edif|torre|bloque|conjunto|residencial|apartamento|apto|casa|piso|manzana|mz|cra|carrera|calle|cl|av|avenida|diagonal|transversal|kr)\b/i;

// Coarsen the location to roughly neighbourhood level.
// "Cra 1 con Calle 24, casa azul" must never be broadcast on a public card —
// segments with street numbers or building words are dropped, and we fall back
// to the city. A vaguer card is one we can live with; a precise one is not.
export function coarseArea(r: Report): string {
  const fallback = incident.city || incident.country;
  const raw = (r.last_seen_address ?? "").trim();
  if (!raw) return fallback;
  const segments = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const safe = segments.filter((s) => !/\d/.test(s) && !BUILDING_WORDS.test(s));
  const area = (safe.length ? safe[safe.length - 1] : "") || fallback;
  const withCity =
    incident.city && !area.toLowerCase().includes(incident.city.toLowerCase())
      ? `${area}, ${incident.city}`
      : area;
  return withCity.length > 46 ? `${withCity.slice(0, 45)}…` : withCity;
}

// Spanish is gendered: a card that says "ATRAPADA" about a man reads as careless,
// and carelessness is exactly what makes people distrust the whole thing.
export function statusLabelEs(status: Report["status"], gender?: Report["gender"]): string {
  const a = gender === "f" ? "a" : "o";
  switch (status) {
    case "trapped_alive":
      return `ATRAPAD${a} CON VIDA`;
    case "found_safe":
      return "APARECIÓ CON VIDA";
    case "found_injured":
      return `ENCONTRAD${a} HERID${a}`;
    case "deceased":
      return `FALLECID${a}`;
    case "withdrawn":
      return "RETIRADO";
    default:
      return "SE BUSCA";
  }
}

export interface PublicCardData {
  name: string;
  /** "a" or "o" — Spanish agreement for pronouns and participles. */
  gsuffix: "a" | "o";
  ageLine: string;
  area: string;
  statusLabel: string;
  urgent: boolean;
  found: boolean;
  reference: string;
  url: string;
  photo: string | null;
  blurPhoto: boolean;
  incidentName: string;
}

// The link printed on every shared card and QR.
//
// Order matters. NEXT_PUBLIC_BASE_URL is the deliberate override (a short host
// that reads well over the radio, or a staging build that must not emit
// production links). Absent that we use the origin the browser is on right now,
// so a card shared from the tailscale deployment, from localhost, or from a
// future production host all point back at the deployment that issued them.
// The literal host is only a last resort for server-side rendering, where there
// is no origin to read — and every consumer of this URL (share sheet, canvas
// poster, QR) runs in the browser.
export function publicUrlFor(reference: string): string {
  const base =
    incident.publicBaseUrlExplicit ||
    (typeof window !== "undefined" ? window.location.origin : incident.publicBaseUrl);
  return `${base.replace(/\/$/, "")}/r/${reference}`;
}

// The server-side projection of the same card.
//
// Note what is NOT here: coarseArea(). The API already coarsened the location to
// ~1 km before it left the database (public_case_view), and it never returns an
// address at all. Re-deriving an "area" in the browser from a string we no
// longer receive would be theatre — the redaction happens where the data lives.
export function cardFromPublicCase(c: PublicCase): PublicCardData {
  const age = typeof c.age_approx === "number" ? `${c.age_approx} años` : "";
  const gender = c.gender === "f" ? "Mujer" : c.gender === "m" ? "Hombre" : "";
  const minor = typeof c.age_approx === "number" && c.age_approx < 18;
  return {
    name: c.name,
    gsuffix: c.gender === "f" ? "a" : "o",
    ageLine: [gender, age].filter(Boolean).join(" · "),
    area: c.area ? `${incident.city || incident.country} (zona aproximada)` : incident.city || incident.country,
    statusLabel: statusLabelEs(c.status as Report["status"], (c.gender ?? undefined) as Report["gender"]),
    urgent: c.status === "trapped_alive",
    found: c.status.startsWith("found"),
    reference: c.reference_number,
    url: publicUrlFor(c.reference_number),
    // The API decides whether a photo may be shown at all; if it returned a URL,
    // consent and minor-redaction were already applied server-side.
    photo: c.photo_url ?? null,
    blurPhoto: minor,
    incidentName: incident.name,
  };
}

export function toPublicCard(r: Report): PublicCardData {
  const minor = isMinor(r);
  const age = typeof r.age_approx === "number" ? `${r.age_approx} años` : "";
  const gender =
    r.gender === "f" ? "Mujer" : r.gender === "m" ? "Hombre" : "";
  return {
    name: r.full_name,
    gsuffix: r.gender === "f" ? "a" : "o",
    ageLine: [gender, age].filter(Boolean).join(" · "),
    area: coarseArea(r),
    statusLabel: statusLabelEs(r.status, r.gender),
    urgent: r.status === "trapped_alive",
    found: r.status.startsWith("found"),
    reference: r.reference_number,
    url: publicUrlFor(r.reference_number),
    photo: canShowPhotoPublicly(r) ? r.photo_data_url! : null,
    blurPhoto: minor,
    incidentName: incident.name,
  };
}

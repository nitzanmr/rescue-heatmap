// What the OUTSIDE world is allowed to see about a report.
// Single source of truth: the public search page, the shareable card and the
// personal /r/<ref> page all read from here. If a field is not returned by this
// module it must never leave the coordination panel.
import { Report } from "./schema";
import { incident } from "./incident";

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

export function publicUrlFor(reference: string): string {
  const base =
    incident.publicBaseUrl ||
    (typeof window !== "undefined" ? window.location.origin : "https://ejemplo.org");
  return `${base.replace(/\/$/, "")}/r/${reference}`;
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

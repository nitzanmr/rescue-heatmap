// How precise is a free-text place, really?
//
// WHY THIS EXISTS
//   Every imported registry row carries one line of Spanish that a relative
//   typed into somebody else's form. In the same column, side by side, sit:
//
//     "Parque la Libertad - Pereira, Risaralda"   ~100 m. A place to dig.
//     "Barrio San Judas, Quibdó"                  ~1 km. A place to ask around.
//     "Pereira, Risaralda"                        ~30 km. Not a place at all.
//     "salió de la casa hacia el trabajo"         A story. Not a place.
//
//   A geocoder answers all four with a coordinate and equal confidence. That is
//   the failure mode: a municipality centroid becomes a 500 m cell on the heat
//   map, the cell goes red because three hundred people share that municipality,
//   and a rescue team is sent to a plaza where nobody is buried.
//
//   So the geocoder is not the first step. THIS is the first step: decide what
//   resolution the sentence even has, before anyone asks where it is.
//
// WHAT IT RETURNS, AND WHAT IS ALLOWED TO USE IT
//   point         — a landmark, an address with a number, or a street crossing.
//                   The only class a coordinate may ever be sought for.
//   neighbourhood — barrio / comuna / vereda / corregimiento. Useful to a field
//                   team asking questions; never a cell.
//   municipality  — a town, a department. Counts in a list, nothing more.
//   narrative     — a sentence about movement or ignorance. Carries no place.
//   none          — empty.
//
//   `eligible` is deliberately NARROWER than `resolution === "point"`. A line
//   that names a landmark inside a story about walking somewhere ("salió hacia
//   el parque") is a sighting on a route, not a location under rubble, and our
//   cells mean "dig here". Those come back point + movement + eligible:false.
//
// WHAT THIS FILE REFUSES TO DECIDE
//   Nothing here produces a coordinate, and `eligible: true` is a nomination,
//   not a promotion. An imported row reaches the map only after a person
//   approves it — the same rule as the dedup queue: the tool proposes, a human
//   decides.

export type PlaceResolution =
  | "point"
  | "neighbourhood"
  | "municipality"
  | "narrative"
  | "none";

export type PlaceVerdict = {
  resolution: PlaceResolution;
  /** Why it landed there. Order is stable so it can be asserted and displayed. */
  signals: string[];
  /** May a geocoder be asked about this string at all? Still needs human sign-off. */
  eligible: boolean;
  /** Lower-cased, unaccented, whitespace-collapsed text the rules actually saw. */
  normalized: string;
};

/** Spanish, typed on a phone, by someone upset. Accents are optional in practice. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// --------------------------------------------------------------- vocabularies

// Named things small enough to stand in a 500 m cell. "vereda" is absent on
// purpose: a Chocó vereda is a rural district, kilometres across.
const LANDMARK = [
  "parque", "iglesia", "capilla", "colegio", "escuela", "universidad", "sena",
  "hospital", "clinica", "puesto de salud", "centro de salud", "terminal",
  "estadio", "coliseo", "cancha", "polideportivo", "plaza de mercado",
  "plaza", "galeria", "mercado", "puente", "edificio", "conjunto", "torre",
  "bloque", "centro comercial", "supermercado", "estacion", "aeropuerto",
  "muelle", "malecon", "cementerio", "batallon", "carcel", "alcaldia",
  "hotel", "residencia", "internado", "guarderia", "jardin infantil", "finca",
  "hacienda", "bomberos", "cruz roja", "albergue", "refugio",
];

// A locality a field team can walk, but not a cell.
const AREA = [
  "barrio", "bario", "comuna", "sector", "urbanizacion", "urb.", "urb ",
  "vereda", "corregimiento", "invasion", "asentamiento", "ciudadela",
  "conjunto residencial", "zona", "localidad", "resguardo",
];

// Departments and the municipalities this incident actually touches. A bare
// match on these, with nothing narrower alongside, is municipality-level.
const ADMIN = [
  "choco", "valle del cauca", "risaralda", "antioquia", "cauca", "caldas",
  "quindio", "narino", "bogota", "cundinamarca", "colombia",
  "quibdo", "pereira", "cali", "medellin", "istmina", "condoto", "tado",
  "certegui", "atrato", "yuto", "bahia solano", "nuqui", "riosucio",
  "dosquebradas", "santa rosa de cabal", "la virginia", "buenaventura",
  "cartago", "tulua", "palmira", "buga", "popayan", "manizales", "armenia",
];

// Someone in motion, or someone who does not know. Both mean: no location here.
const MOVEMENT = [
  "salio", "salia", "se dirigia", "se dirige", "iba", "iba para", "rumbo a",
  "camino a", "camino al", "de camino", "hacia", "en direccion", "viajaba",
  "viajo", "se fue", "se marcho", "partio", "regresaba", "volvia", "trasladaba",
  "abordo", "tomo un bus", "tomo el bus", "en la via", "en la carretera",
];

const UNKNOWN = [
  "no se sabe", "no sabemos", "no sabe", "no sesabe", "no se sabe nada",
  "no se ni", "se desconoce", "desconocido", "desconocida", "sin informacion",
  "sin datos", "no reporta", "no especifica", "ninguno", "ninguna", "n/a",
  "na", "-", "--", "sin lugar", "no aplica", "pendiente", "por confirmar",
];

// A real place that carries no address: "su casa", "el trabajo". The family
// knows exactly where this is and we do not, which for map purposes is the same
// as not knowing. Treated as narrative so it can never be geocoded, but kept in
// its own signal because it is the field team's easiest follow-up question.
const UNADDRESSED = [
  "su casa", "la casa", "casa", "su residencia", "la residencia", "su vivienda",
  "su apartamento", "su trabajo", "el trabajo", "su lugar de trabajo",
  "donde vive", "vive en",
];

// The trailing `s?` matters more than it looks: "Torres del Limonar" is a named
// building and "torre" is in the vocabulary, so without plural tolerance that
// whole family of Colombian apartment blocks scored as a municipality.
const hasAny = (t: string, words: string[]) =>
  words.filter((w) => new RegExp(`(^|[^a-z])${escapeRe(w.trim())}s?([^a-z]|$)`).test(t));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "calle 12 # 34-56", "cra 8 no 12-30", "kr 5 #2 20", "av 6 con calle 4"
const STREET = /(^|[^a-z])(calle|cll|cl|carrera|cra|cr|kra|kr|avenida|av|autopista|diagonal|diag|dg|transversal|transv|tv|circunvalar|manzana|mz|mza)\s*\.?\s*\d+[a-z]?/;
const HOUSE_NUMBER = /(#|n[or]?\.?\s*)\s*\d+\s*[-–]?\s*\d*/;
const CROSSING = /(^|[^a-z])(con|x|esquina(?: con)?|cruce(?: con)?)\s+(calle|cll|cl|carrera|cra|cr|kra|kr|avenida|av|diagonal|transversal|tv|dg)\s*\.?\s*\d+/;
// Colombian shorthand drops the '#': "Cra 17 82 103", "carrera 53 14c-31".
// Street name, then a plate number, is an address whether or not it is punctuated.
const BARE_PLATE = /(calle|cll|cl|carrera|cra|cr|kra|kr|avenida|av|diagonal|dg|transversal|tv)\s*\.?\s*\d+[a-z]?\s*[-–\s]\s*\d+/;
// Two street names in one line is a corner: "Cr 9 cll 13".
const TWO_STREETS =
  /(calle|cll|cl|carrera|cra|cr|kra|kr|avenida|av|diagonal|dg|transversal|tv)\s*\.?\s*\d+[a-z]?\b[\s,y#-]*\b(calle|cll|cl|carrera|cra|cr|kra|kr|avenida|av|diagonal|dg|transversal|tv)\s*\.?\s*\d+/;

/**
 * Classify one free-text place line.
 *
 * The order of the rules is the argument. Ignorance beats everything (a line
 * that says "no se sabe" is not made precise by also naming a town). A street
 * with a house number beats a landmark (it is narrower). A landmark beats an
 * area, an area beats a municipality. Movement never changes the resolution —
 * a parque is still a parque — it removes eligibility, because the sentence is
 * about where someone was going, and our cells claim where someone is buried.
 */
export function classifyPlace(raw: string | null | undefined): PlaceVerdict {
  // The harvested line is "<what a relative typed> - <municipality on the card>".
  // Classifying the whole string lets the appended municipality drown the part
  // that carries the precision: "Pampalinda - Cali, Valle del Cauca" would score
  // as a municipality because "cali" is in it. So judge the head first, and fall
  // back to the whole line only when the head says nothing.
  const whole = classifySegment(raw);
  const text = raw ? normalize(raw) : "";
  const dash = text.indexOf(" - ");
  if (dash <= 0) return whole;

  const head = classifySegment(text.slice(0, dash));
  if (head.resolution === "point" || head.resolution === "neighbourhood" || head.resolution === "narrative") {
    return { ...head, normalized: text, signals: [...head.signals, "from:detail-head"] };
  }
  return whole;
}

function classifySegment(raw: string | null | undefined): PlaceVerdict {
  const normalized = raw ? normalize(raw) : "";
  const signals: string[] = [];

  if (!normalized || normalized.length < 2) {
    return { resolution: "none", signals: ["empty"], eligible: false, normalized };
  }

  // Explicit ignorance. Whole-string check first (a bare "-" or "n/a"), then
  // phrases anywhere in the line.
  if (UNKNOWN.includes(normalized) || hasAny(normalized, UNKNOWN.filter((u) => u.includes(" "))).length) {
    return { resolution: "narrative", signals: ["unknown"], eligible: false, normalized };
  }

  // A place with no address. Only when it is essentially the whole line: "su
  // casa" is unaddressed, "su casa en la calle 12 # 4-30" is an address.
  const unaddressed = hasAny(normalized, UNADDRESSED);
  if (unaddressed.length && wordCount(normalized) <= 5 && !STREET.test(normalized)) {
    return {
      resolution: "narrative",
      signals: [`unaddressed:${unaddressed[0]}`],
      eligible: false,
      normalized,
    };
  }

  const movement = hasAny(normalized, MOVEMENT);
  if (movement.length) signals.push(`movement:${movement[0]}`);

  const street = STREET.test(normalized);
  const number = HOUSE_NUMBER.test(normalized);
  const crossing = CROSSING.test(normalized) || TWO_STREETS.test(normalized);
  const plate = BARE_PLATE.test(normalized);
  const landmarks = hasAny(normalized, LANDMARK);
  const areas = hasAny(normalized, AREA);
  const admins = hasAny(normalized, ADMIN);

  let resolution: PlaceResolution;

  if (street && (number || crossing || plate)) {
    signals.push(crossing ? "street:crossing" : number ? "street:number" : "street:plate");
    resolution = "point";
  } else if (landmarks.length && (namedAfter(normalized, landmarks[0]) || brandedBefore(normalized, landmarks[0]))) {
    // "parque" alone is a noun; "parque la libertad" is a place. A landmark word
    // with nothing following it names a category, not an address.
    signals.push(`landmark:${landmarks[0]}`);
    resolution = "point";
  } else if (street) {
    // A street with no number is a line kilometres long, not a point.
    signals.push("street:no-number");
    resolution = "neighbourhood";
  } else if (areas.length) {
    signals.push(`area:${areas[0]}`);
    resolution = "neighbourhood";
  } else if (landmarks.length) {
    signals.push(`landmark-bare:${landmarks[0]}`);
    resolution = "neighbourhood";
  } else if (admins.length) {
    signals.push(`admin:${admins[0]}`);
    resolution = "municipality";
  } else if (movement.length || wordCount(normalized) > 8) {
    // Long prose naming nothing we recognise. Treat as a story, not a place:
    // the alternative is inventing precision from an unfamiliar word.
    signals.push("prose");
    resolution = "narrative";
  } else {
    // Short, unrecognised — almost always a place name we do not carry in the
    // ADMIN list. Coarse by default. Being too coarse costs a list row; being
    // too precise costs a rescue team's hour.
    signals.push("unrecognised");
    resolution = "municipality";
  }

  const eligible = resolution === "point" && !movement.length;
  if (resolution === "point" && movement.length) signals.push("demoted:movement");

  return { resolution, signals, eligible, normalized };
}

/**
 * Is this a building whose name was written BEFORE its type? "Dibeni Hotel",
 * "Limonar Torres".
 *
 * Spanish normally puts the type first, so this is deliberately narrow: only
 * building words, only a real word immediately in front of them, never a
 * preposition. It exists because the same hotel arrives written both ways in
 * the same registry, and a classifier that calls one of them a point and the
 * other a neighbourhood splits one collapsed building into two half-sized
 * facts.
 */
function brandedBefore(text: string, word: string): boolean {
  const BUILDING = new Set([
    "hotel", "edificio", "torre", "conjunto", "residencia", "residencias",
    "bloque", "centro comercial", "hospital", "clinica", "colegio",
    "universidad",
  ]);
  const w = word.trim();
  if (!BUILDING.has(w)) return false;
  const i = text.indexOf(w);
  if (i <= 0) return false;
  const before = text
    .slice(0, i)
    .split(/[\s,]+/)
    .filter(Boolean);
  const prev = before[before.length - 1];
  if (!prev || prev.length < 3) return false;
  const notNames = new Set([
    ...["de", "del", "la", "el", "los", "las", "en", "y", "al", "a", "un", "una",
       "hacia", "cerca", "frente", "junto", "detras", "dentro", "por", "para",
       "desde", "sobre", "con", "su", "mi", "este", "ese"],
    ...[...AREA, ...LANDMARK].map((x) => x.trim()),
  ]);
  return !notNames.has(prev);
}

function wordCount(s: string): number {
  return s.split(/[\s,]+/).filter(Boolean).length;
}

/**
 * Is there a proper name after the landmark word? "parque la libertad" -> yes.
 *
 * "la iglesia del barrio" -> no: what follows is another common noun, so the
 * line still names a category of place rather than one place.
 */
function namedAfter(text: string, word: string): boolean {
  const i = text.indexOf(word.trim());
  if (i < 0) return false;
  // The vocabulary is singular but people write "Torres del Limonar", so drop a
  // trailing plural before looking for the name.
  const rest = text.slice(i + word.trim().length).replace(/^s\b/, "").replace(/^[\s.,:-]+/, "");
  if (!rest) return false;
  const stop = new Set(["de", "del", "la", "el", "los", "las", "en", "y", "al", "a"]);
  const words = rest.split(/[\s,]+/).filter(Boolean);
  const common = new Set(
    [...AREA, ...LANDMARK].map((w) => w.trim()).filter((w) => !w.includes(" "))
  );
  for (const w of words) {
    if (stop.has(w)) continue;         // articles carry no name
    if (common.has(w)) return false;   // "...del barrio" is still a category
    return w.length > 1;               // first real word is the name
  }
  return false;
}

/** Histogram helper shared by the importer's dry run and the classify CLI. */
export function summariseResolutions(
  places: Array<string | null | undefined>
): { counts: Record<PlaceResolution, number>; eligible: number; total: number } {
  const counts: Record<PlaceResolution, number> = {
    point: 0, neighbourhood: 0, municipality: 0, narrative: 0, none: 0,
  };
  let eligible = 0;
  for (const p of places) {
    const v = classifyPlace(p);
    counts[v.resolution]++;
    if (v.eligible) eligible++;
  }
  return { counts, eligible, total: places.length };
}

// Which structures do many people name at once?
//
// WHY THIS EXISTS
//   place-resolution.ts answers "how precise is this line?" one row at a time.
//   That is the safety question. This file asks the operational one: after you
//   throw away everything too coarse to dig at, WHICH NAMED STRUCTURE has the
//   most people attached to it?
//
//   On the colombiatebusca import the answer was one hotel in Pereira with ~86
//   people named against it — and it was invisible, because the name arrived
//   spelled three different ways ("Hotel Dibeni", "hotel debani", "Dibeni") and
//   nothing counted them together. A collapsed building with 86 names on it is
//   the single most actionable fact in a 5,000-row registry, and no amount of
//   per-row geocoding surfaces it.
//
// WHY FOLDING SPELLINGS IS THE SAME PROBLEM AS DEDUP, AND TREATED THE SAME WAY
//   Merging "debani" into "dibeni" is a guess. So the fold is:
//     - conservative: only inside the same municipality, only for names long
//       enough that one or two letters cannot be the whole word, and never
//       across two names that differ by a digit (torre 1 / torre 2 are two
//       buildings, and putting a team in the wrong one is the failure we care
//       about);
//     - visible: every folded spelling is carried in `variants`, so the person
//       reviewing sees exactly what was joined and can reject the join;
//     - inert: a cluster is a nomination, not a coordinate. Nothing here can
//       put anything on a map. Only a signed human approval does that (see
//       migration 0015).
//
// WHAT A CLUSTER IS NOT
//   It is not "86 people are buried there". The source field means "last seen
//   at", and last-seen is not under-the-rubble. What it honestly supports is:
//   "this address is worth a human minute", which at 86 names is obvious and at
//   2 names is not.

import { classifyPlace, normalize } from "./place-resolution.js";

export type PlaceRow = {
  /** Whatever identifies the case to the caller: a case id, a source id, a ref. */
  id: string;
  /** The free-text line as harvested. */
  place: string | null | undefined;
  /** Coarse municipality from the listing card, if the source had one. */
  municipality?: string | null;
};

export type PlaceCluster = {
  /** Stable across re-imports: the same structure yields the same key. */
  key: string;
  /** The spelling the most people used. What a reviewer reads. */
  label: string;
  municipality: string | null;
  /** Every distinct raw spelling folded in, most common first. */
  variants: string[];
  ids: string[];
  count: number;
};

// Words that describe the KIND of structure. Kept in the label (a reviewer
// wants to read "Hotel Dibeni") but dropped from the identity key, because the
// same building is written with and without them.
const TYPE_WORDS = new Set([
  "hotel", "edificio", "edif", "conjunto", "residencial", "residencias",
  "residencia", "torre", "torres", "bloque", "apartamentos", "apto",
  "colegio", "escuela", "universidad", "hospital", "clinica", "iglesia",
  "capilla", "parque", "plaza", "centro", "comercial", "terminal", "estadio",
  "coliseo", "cancha", "mercado", "galeria", "estacion", "aeropuerto",
  "barrio", "sector", "urbanizacion", "ciudadela", "puente", "albergue",
  "refugio", "finca", "hacienda", "cementerio", "alcaldia", "sena",
]);

const STOP_WORDS = new Set([
  "de", "del", "la", "el", "los", "las", "y", "en", "al", "a", "san", "santa",
]);

/** Department/city tails the source appends to nearly every line. */
const PLACE_TAIL =
  /(,|\s-\s)?\s*(choco|valle del cauca|risaralda|antioquia|cauca|caldas|quindio|narino|cundinamarca|colombia)\s*$/;

function head(raw: string): string {
  const t = normalize(raw);
  const dash = t.indexOf(" - ");
  return (dash > 0 ? t.slice(0, dash) : t).replace(PLACE_TAIL, "").trim();
}

/**
 * The identity of a structure, independent of how someone chose to write it.
 *
 * Type words and articles are removed, digits are KEPT (torre 1 is not torre 2),
 * and what remains is sorted so word order stops mattering: "Hotel Dibeni" and
 * "Dibeni Hotel" are one building, and pretending otherwise splits a hotspot in
 * half.
 */
/**
 * Municipality names, which also arrive as free text and in any order:
 * "Pereira, Risaralda" and "Risaralda, Pereira" are one town.
 */
function muniKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const w = normalize(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((x) => !STOP_WORDS.has(x));
  return w.length ? [...new Set(w)].sort().join(" ") : null;
}

/** Town and department names: never an identity of their own. */
const ADMIN_WORDS = new Set([
  "choco", "valle", "cauca", "risaralda", "antioquia", "caldas", "quindio",
  "narino", "cundinamarca", "colombia", "quibdo", "pereira", "cali",
  "medellin", "istmina", "condoto", "tado", "dosquebradas", "cartago",
  "buenaventura", "virginia", "palmira", "tulua", "buga", "popayan",
  "manizales", "armenia",
]);

export function clusterKey(raw: string): string {
  const words = head(raw)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !TYPE_WORDS.has(w));
  // A line that is nothing BUT type words ("el edificio") names a category, not
  // a building. Fall back to the type words so it still groups with itself, but
  // it will never gather a crowd, which is correct.
  let kept = words.length ? words : head(raw).split(/\s+/).filter(Boolean);

  // "Aeropuerto de Pereira" and "Alcaldía de Pereira" both reduce to "pereira"
  // once the type word is dropped — and then fold into one structure, which is
  // an airport and a town hall counted as the same building. When nothing but a
  // town name survives, the type word IS the identity, so put it back.
  if (kept.every((w) => ADMIN_WORDS.has(w))) {
    const types = head(raw)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => TYPE_WORDS.has(w));
    kept = [...types, ...kept];
  }
  return [...new Set(kept)].sort().join(" ");
}

/** Cheap bounded edit distance. Returns >max as soon as it can. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The consonants a Spanish speaker actually hears.
 *
 * Nearly every misspelling in this registry is either a vowel (Dibeni /
 * Debani) or a letter pair Spanish pronounces identically (s/z/c, b/v, y/ll,
 * silent h). Strip those away and what is left is the skeleton of the name. Two
 * lines with the same skeleton are the same word said twice; two lines with
 * different skeletons are different words, however close their letters look.
 */
export function consonantSkeleton(s: string): string {
  return s
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/qu/g, "k")
    .replace(/ll/g, "y")
    .replace(/[cz]/g, "s")
    .replace(/v/g, "b")
    .replace(/h/g, "")
    .replace(/[aeiou\s]/g, "");
}

/**
 * May two keys be the same structure?
 *
 * Deliberately strict. Three conditions, and all of them have to hold: the same
 * municipality (checked by the caller — a "Parque Central" exists in every town
 * in Colombia), no conflicting digit, and either a one-letter difference or the
 * same spoken skeleton.
 *
 * The skeleton rule is what buys the real case: dibeni/debani is two edits, and
 * a blind two-edit rule at that length would also swallow names that merely
 * rhyme. Same consonants, different vowels, is a spelling; different
 * consonants is a different building.
 */
export function mayFold(a: string, b: string): boolean {
  if (a === b) return true;
  const digits = (s: string) => s.match(/\d+/g)?.join(",") ?? "";
  if (digits(a) !== digits(b)) return false;      // torre 1 vs torre 2: never
  if (a.length < 6 || b.length < 6) return false; // short names: one letter is the word
  const d = editDistance(a, b, 2);
  if (d <= 1) return true;
  if (d > 2) return false;
  const ska = consonantSkeleton(a);
  const skb = consonantSkeleton(b);
  // Two edits pass only if the name still sounds the same, or it is long enough
  // that two letters cannot change what it is.
  return (ska.length >= 3 && ska === skb) || Math.min(a.length, b.length) >= 10;
}

/**
 * Group eligible place lines into named structures, biggest first.
 *
 * Rows whose place is not `eligible` are dropped here rather than downgraded:
 * this list exists to be handed to a person for geocoding, and a municipality
 * has no business on it.
 */
export function clusterPlaces(rows: PlaceRow[]): PlaceCluster[] {
  type Bucket = {
    key: string;
    municipality: string | null;
    ids: string[];
    spellings: Map<string, number>;
  };
  const buckets: Bucket[] = [];
  const byExact = new Map<string, Bucket>();

  for (const r of rows) {
    if (!r.place) continue;
    if (!classifyPlace(r.place).eligible) continue;

    const key = clusterKey(r.place);
    if (!key) continue;
    const muni = muniKey(r.municipality);
    const exactId = `${muni ?? ""}|${key}`;

    let bucket = byExact.get(exactId);
    if (!bucket) {
      // Only now look for a near-miss, and only inside the same municipality.
      bucket = buckets.find(
        (b) => b.municipality === muni && mayFold(b.key, key)
      );
      if (bucket) {
        byExact.set(exactId, bucket);
      } else {
        bucket = { key, municipality: muni, ids: [], spellings: new Map() };
        buckets.push(bucket);
        byExact.set(exactId, bucket);
      }
    }
    bucket.ids.push(r.id);
    const spelling = head(r.place);
    bucket.spellings.set(spelling, (bucket.spellings.get(spelling) ?? 0) + 1);
  }

  return buckets
    .map((b) => {
      const variants = [...b.spellings.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([s]) => s);
      return {
        key: b.key,
        // The label is the spelling most people used, not the first one seen:
        // one person's typo must not become the name on an operator's screen.
        label: variants[0],
        municipality: b.municipality,
        variants,
        ids: b.ids,
        count: b.ids.length,
      };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

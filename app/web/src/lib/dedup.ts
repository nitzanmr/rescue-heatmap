// Deduplication AT INTAKE — the single most important lesson from Venezuela
// (~24% duplicate records, unverified figure; see docs/lessons-learned).
import { Report } from "./schema";

// Spanish-aware normalisation: strip accents, collapse common equivalences.
export function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\bde\b|\bdel\b|\bla\b|\blos\b|\bel\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string) {
  return normName(s).split(" ").filter(Boolean);
}

function nameSimilarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((t) => {
    if (B.has(t)) hit++;
  });
  return hit / Math.min(A.size, B.size);
}

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface DedupHit {
  report: Report;
  score: number;
  reasons: string[];
}

export function findDuplicates(candidate: Partial<Report>, existing: Report[]): DedupHit[] {
  const hits: DedupHit[] = [];
  for (const r of existing) {
    let score = 0;
    const reasons: string[] = [];

    const sim = nameSimilarity(candidate.full_name || "", r.full_name);
    if (sim >= 0.5) {
      score += sim * 0.45;
      reasons.push("nombre similar");
    }

    if (
      candidate.last_seen_lat != null &&
      candidate.last_seen_lng != null &&
      r.last_seen_lat != null &&
      r.last_seen_lng != null
    ) {
      const d = haversine(
        [candidate.last_seen_lat, candidate.last_seen_lng],
        [r.last_seen_lat!, r.last_seen_lng!]
      );
      if (d < 100) {
        score += 0.3;
        reasons.push("a menos de 100 m");
      }
    } else if (
      candidate.last_seen_address &&
      r.last_seen_address &&
      normName(candidate.last_seen_address) === normName(r.last_seen_address)
    ) {
      score += 0.3;
      reasons.push("misma dirección");
    }

    if (candidate.reporter_phone && candidate.reporter_phone === r.reporter_phone) {
      score += 0.35;
      reasons.push("mismo teléfono de contacto");
    }
    if (candidate.national_id_last4 && candidate.national_id_last4 === r.national_id_last4) {
      score += 0.35;
      reasons.push("mismos 4 dígitos del documento");
    }
    if (
      candidate.age_approx != null &&
      r.age_approx != null &&
      Math.abs(candidate.age_approx - r.age_approx) <= 3
    ) {
      score += 0.1;
      reasons.push("edad parecida");
    }
    if (candidate.building_name && candidate.building_name === r.building_name && candidate.floor === r.floor) {
      score += 0.2;
      reasons.push("mismo edificio y piso");
    }

    if (score >= 0.55) hits.push({ report: r, score: Math.min(score, 1), reasons });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}

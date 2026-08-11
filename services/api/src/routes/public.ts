import type { FastifyInstance } from "fastify";
import { one, query } from "../db.js";
import { publicSearchQuery, sightingInput } from "../schema.js";
import { config } from "../config.js";
import { toE164 } from "../phone.js";
import { HttpError, noIndex, rateLimit } from "../security.js";
import { audit } from "../audit.js";
import { enqueue } from "../jobs.js";

// Everything in this file is readable by the world. The rule from ADR-001:
// name, approximate age, gender, neighbourhood, status, date — and nothing else.
// The projection is enforced twice: in public_case_view (SQL) and here.
export default async function publicRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /v1/public/search?q=... — the engine of adoption and our biggest
  // exposure at the same time. Hence: name required, no listing endpoint,
  // capped offset, rate limited, noindex.
  // -------------------------------------------------------------------------
  app.get("/v1/public/search", async (req, reply) => {
    noIndex(reply);
    await rateLimit(`search:${req.actor.ipHash}`, config.limits.searchPerMinute, 60);

    const parsed = publicSearchQuery.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, "a name of at least 3 characters is required", "invalid_query");
    const { q, incident, status, limit, offset } = parsed.data;
    if (offset > config.limits.publicMaxOffset) {
      throw new HttpError(400, "offset too large", "offset_capped");
    }

    const rows = await query(
      `SELECT v.reference_number, v.name, v.age_approx, v.gender, v.status,
              v.reporter_count, v.status_updated_at, v.created_at,
              v.lat_coarse, v.lng_coarse,
              similarity(public.name_key(v.name), public.name_key($1)) AS match
         FROM public_case_view v
         JOIN incident i ON i.id = v.incident_id
        WHERE ($2::text IS NULL OR i.slug = $2)
          AND ($3::text IS NULL OR v.status = $3)
          AND (public.name_key(v.name) % public.name_key($1)
               OR public.name_key(v.name) ILIKE '%' || public.name_key($1) || '%')
        ORDER BY match DESC, v.status_updated_at DESC
        LIMIT $4 OFFSET $5`,
      [q, incident ?? null, status ?? null, limit, offset]
    );

    return {
      results: rows.map((r) => ({
        reference_number: r.reference_number,
        name: r.name,
        age_approx: r.age_approx,
        gender: r.gender,
        status: r.status,
        reports: r.reporter_count,
        area: r.lat_coarse != null ? { lat: r.lat_coarse, lng: r.lng_coarse } : null,
        updated_at: r.status_updated_at,
      })),
      // No total count on purpose: a count is a scraping oracle.
      has_more: rows.length === limit,
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/public/cases/:ref — the shareable card page (/r/<ref>).
  // This is the object families actually forward. It must be cheap and safe.
  // -------------------------------------------------------------------------
  app.get<{ Params: { ref: string } }>("/v1/public/cases/:ref", async (req, reply) => {
    noIndex(reply);
    await rateLimit(`card:${req.actor.ipHash}`, 120, 60);

    const row = await one(
      `SELECT v.*, m.id AS media_id, m.blurred_key, m.storage_key, m.consent_public
         FROM public_case_view v
    LEFT JOIN LATERAL (
           SELECT id, blurred_key, storage_key, consent_public FROM media
            WHERE case_id = v.case_id AND deleted_at IS NULL AND kind = 'person_photo'
            ORDER BY uploaded_at LIMIT 1) m ON true
        WHERE v.reference_number = $1`,
      [req.params.ref]
    );
    if (!row) throw new HttpError(404, "not found", "not_found");

    // Photo shows only with its own opt-in; minors are always served the
    // redacted derivative, and if that derivative is not ready yet, nothing.
    let photo: string | null = null;
    if (row.consent_public && row.consent_photo_public) {
      photo = row.is_minor
        ? row.blurred_key ? `/v1/public/media/${row.media_id}?v=blurred` : null
        : `/v1/public/media/${row.media_id}`;
    }

    return {
      reference_number: row.reference_number,
      name: row.name,
      age_approx: row.age_approx,
      gender: row.gender,
      status: row.status,
      reports: row.reporter_count,
      area: row.lat_coarse != null ? { lat: row.lat_coarse, lng: row.lng_coarse } : null,
      updated_at: row.status_updated_at,
      photo_url: photo,
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/public/cases/:ref/sightings — "I saw him" / "he is safe".
  // This is the loop that makes a shared card more than a dead end.
  // It never changes status by itself: an anonymous claim is a claim.
  // -------------------------------------------------------------------------
  app.post<{ Params: { ref: string } }>("/v1/public/cases/:ref/sightings", async (req, reply) => {
    await rateLimit(`sighting:${req.actor.ipHash}`, config.limits.sightingPerHour, 3600);

    const parsed = sightingInput.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid sighting", "invalid_sighting");
    const s = parsed.data;

    const c = await one<{ case_id: string }>(
      `SELECT id AS case_id FROM person_case
        WHERE reference_number = $1 AND merged_into IS NULL AND anonymised_at IS NULL`,
      [req.params.ref]
    );
    if (!c) throw new HttpError(404, "not found", "not_found");

    const row = await one<{ id: string }>(
      `INSERT INTO sighting (case_id, kind, note, geo, reported_at, source,
                             contact_phone_e164, token_hash, trust)
       VALUES ($1,$2,$3,
               CASE WHEN $4::float8 IS NOT NULL AND $5::float8 IS NOT NULL
                    THEN ST_SetSRID(ST_MakePoint($5,$4),4326)::extensions.geography END,
               $6, $7, $8, NULL, 'unverified')
       RETURNING id`,
      [
        c.case_id, s.kind, s.note ?? null, s.lat ?? null, s.lng ?? null,
        s.reported_at ?? null,
        req.actor.kind === "reporter" ? "reporter_token" : req.actor.kind === "operator" ? "operator" : "public",
        toE164(s.contact_phone),
      ]
    );

    await enqueue("correlate", { case_id: c.case_id }, `correlate:${c.case_id}`, 5);
    await audit(req.actor, "sighting.create", c.case_id, { kind: s.kind, sighting_id: row!.id });

    reply.code(201);
    return { ok: true, sighting_id: row!.id, note: "reviewed by an operator before the status changes" };
  });

  // Media bytes proxied through the API so consent and minor-redaction are
  // enforced on every request. A signed CDN URL cannot be revoked.
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>(
    "/v1/public/media/:id",
    async (req, reply) => {
      noIndex(reply);
      await rateLimit(`media:${req.actor.ipHash}`, 240, 60);
      const m = await one(
        `SELECT m.storage_key, m.blurred_key, m.mime, m.consent_public,
                pc.is_minor, pc.consent_photo_public, pc.public_listed, pc.anonymised_at
           FROM media m JOIN person_case pc ON pc.id = m.case_id
          WHERE m.id = $1 AND m.deleted_at IS NULL`,
        [req.params.id]
      );
      if (!m || m.anonymised_at || !m.public_listed || !m.consent_public || !m.consent_photo_public) {
        throw new HttpError(404, "not found", "not_found");
      }
      const wantBlur = m.is_minor || req.query.v === "blurred";
      const key = wantBlur ? m.blurred_key : m.storage_key;
      if (!key) throw new HttpError(404, "not found", "not_found");

      const { storage } = await import("../storage.js");
      const buf = await storage.get(key);
      reply.header("Content-Type", m.mime);
      reply.header("Cache-Control", "private, max-age=300");
      return reply.send(buf);
    }
  );

  // Aggregated heat cells. The public map never receives individual cases.
  app.get<{ Querystring: { incident?: string; cell?: string } }>(
    "/v1/public/heat",
    async (req, reply) => {
      noIndex(reply);
      await rateLimit(`heat:${req.actor.ipHash}`, 60, 60);
      const inc = await one<{ id: string }>(
        req.query.incident
          ? `SELECT id FROM incident WHERE slug = $1`
          : `SELECT id FROM incident WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        req.query.incident ? [req.query.incident] : []
      );
      if (!inc) return { cells: [] };
      // Never finer than 250 m in public: a 50 m cell with one case is an address.
      const cell = Math.max(250, Math.min(2000, Number(req.query.cell ?? 500) || 500));
      const cells = await query(
        `SELECT lat, lng, weight, cases FROM public.heat_cells($1, $2, NULL)
          WHERE cases >= 2`,
        [inc.id, cell]
      );
      return { cell_m: cell, cells };
    }
  );
}

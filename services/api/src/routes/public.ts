import type { FastifyInstance } from "fastify";
import { one, query } from "../db.js";
import { publicSearchQuery, sightingInput } from "../schema.js";
import { config } from "../config.js";
import { toE164 } from "../phone.js";
import { HttpError, noIndex, rateLimit } from "../security.js";
import { audit } from "../audit.js";
import { enqueue } from "../jobs.js";
import { cached } from "../cache.js";

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

  // -------------------------------------------------------------------------
  // GET /v1/public/heat — aggregated cells. The public map never receives
  // individual cases.
  //
  // This is the most expensive query we serve and the one every phone asks for
  // first: heat_cells() reprojects every indexed person of the incident into a
  // metre grid. It is also the same answer for every caller on earth, so it is
  // cached twice, on purpose and at different layers:
  //
  //   - at the edge (30 s, with stale-while-updating) so a thousand phones cost
  //     one query. See ops/edge/nginx.conf.
  //   - in this process (20 s, single-flight, stale-on-failure) so the same is
  //     true when there is no edge of ours in front — and so a cold cache under
  //     load runs ONE query instead of one per connection.
  //
  // The Cache-Control below is the honest version of a comment that used to
  // claim edge caching while noIndex() sent `no-store`. An aggregate with a
  // two-case floor carries no person, so it may be shared by caches.
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { incident?: string; cell?: string } }>(
    "/v1/public/heat",
    async (req, reply) => {
      noIndex(reply);
      await rateLimit(`heat:${req.actor.ipHash}`, 60, 60);
      // Never finer than 250 m in public: a 50 m cell with one case is an address.
      const cell = Math.max(250, Math.min(2000, Number(req.query.cell ?? 500) || 500));
      const slug = req.query.incident ?? "";

      const hit = await cached(`heat|${slug}|${cell}`, 20_000, 120_000, async () => {
        const inc = await one<{ id: string }>(
          slug
            ? `SELECT id FROM incident WHERE slug = $1`
            : `SELECT id FROM incident WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
          slug ? [slug] : []
        );
        if (!inc) return null;
        return await query(
          `SELECT lat, lng, weight, cases FROM public.heat_cells($1, $2, NULL)
            WHERE cases >= 2`,
          [inc.id, cell]
        );
      });

      // A shared aggregate may be cached; a stale one says so, so an operator
      // debugging "the map is behind" reads it off the response instead of
      // guessing which layer is holding it.
      reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
      reply.header("X-Cache-Age", String(Math.max(0, Math.round(hit.age_ms / 1000))));
      if (hit.stale) reply.header("X-Cache-Stale", "1");

      if (hit.value === null) return { cells: [] };
      return { cell_m: cell, cells: hit.value };
    }
  );

  // -------------------------------------------------------------------------
  // GET /v1/public/aid-sites — shelters, hospitals, pharmacies, responders.
  //
  // Unlike every other public endpoint here this one is NOT about people, which
  // is why it may return exact coordinates and a phone number: it describes
  // institutions. It reads public.aid_sites(), a function that touches no case
  // table at all, so no future edit can widen it into a people endpoint by
  // accident.
  //
  // Cached at the edge for 2 minutes AND in this process for 1. Shelter status
  // changes in minutes, not seconds, and on a saturated cellular network during
  // an activation a cached answer beats a fresh timeout. (This comment claimed
  // edge caching for a while before any edge cache existed. It does now:
  // ops/edge/nginx.conf, and services/api/test/public-cache.test.ts fails if
  // either half is removed.)
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { country?: string; kinds?: string; incident?: string } }>(
    "/v1/public/aid-sites",
    async (req, reply) => {
      noIndex(reply);
      await rateLimit(`aid:${req.actor.ipHash}`, 60, 60);

      const country = (req.query.country ?? config.incident.countryCode ?? "CO").slice(0, 2);
      const kinds = req.query.kinds
        ? req.query.kinds.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 12)
        : null;

      const key = `aid|${country}|${(kinds ?? []).join(",")}|${req.query.incident ?? ""}`;
      const hit = await cached(key, 60_000, 300_000, async () => {
        let incidentId: string | null = null;
        if (req.query.incident) {
          const inc = await one<{ id: string }>(`SELECT id FROM incident WHERE slug = $1`, [req.query.incident]);
          incidentId = inc?.id ?? null;
        }
        return await query(
          `SELECT id, kind, name, lat, lng, address, phone, capacity, status, verified, source, updated_at
             FROM public.aid_sites($1, $2, $3)
            ORDER BY verified DESC, kind, name
            LIMIT 5000`,
          [country, kinds, incidentId]
        );
      });

      reply.header("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
      reply.header("X-Cache-Age", String(Math.max(0, Math.round(hit.age_ms / 1000))));
      if (hit.stale) reply.header("X-Cache-Stale", "1");
      return {
        attribution: "© OpenStreetMap contributors (ODbL)",
        sites: hit.value,
      };
    }
  );
}

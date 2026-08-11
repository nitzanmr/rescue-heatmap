import type { FastifyInstance } from "fastify";
import { one, query, tx } from "../db.js";
import { decisionInput, statusUpdate } from "../schema.js";
import { HttpError, requireAdmin, requireOperator } from "../security.js";
import { audit } from "../audit.js";
import { enqueue } from "../jobs.js";

// The command panel. Operators see everything; every write is audited.
export default async function panelRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // The correlation queue — the screen this whole system exists for.
  // Ordered by score, highest first, with the reason for every pairing so the
  // operator can audit the machine instead of trusting it.
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { incident?: string; state?: string; limit?: string } }>(
    "/v1/panel/dedup",
    async (req) => {
      requireOperator(req.actor);
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const rows = await query(
        `SELECT d.id, d.score, d.signals, d.state, d.created_at,
                a.case_id AS a_case, a.name_raw AS a_name, a.age_approx AS a_age,
                a.reporter_count AS a_reports, ca.reference_number AS a_ref, ca.status AS a_status,
                b.case_id AS b_case, b.name_raw AS b_name, b.age_approx AS b_age,
                b.reporter_count AS b_reports, cb.reference_number AS b_ref, cb.status AS b_status
           FROM dedup_candidate d
           JOIN person_index a ON a.case_id = d.a_case
           JOIN person_index b ON b.case_id = d.b_case
           JOIN person_case ca ON ca.id = d.a_case
           JOIN person_case cb ON cb.id = d.b_case
          WHERE d.state = COALESCE($1,'pending')
            AND ($2::text IS NULL OR d.incident_id = (SELECT id FROM incident WHERE slug = $2))
            AND ca.merged_into IS NULL AND cb.merged_into IS NULL
          ORDER BY d.score DESC, d.created_at
          LIMIT $3`,
        [req.query.state ?? null, req.query.incident ?? null, limit]
      );
      return { pending: rows };
    }
  );

  // On-demand correlation for one case: "who else might this be?"
  app.get<{ Params: { id: string } }>("/v1/panel/cases/:id/correlations", async (req) => {
    requireOperator(req.actor);
    const rows = await query(
      `SELECT c.case_id, c.score, c.signals, pi.name_raw, pi.age_approx,
              pc.reference_number, pc.status
         FROM public.correlate_case($1, 25) c
         JOIN person_index pi ON pi.case_id = c.case_id
         JOIN person_case  pc ON pc.id = c.case_id`,
      [req.params.id]
    );
    return { candidates: rows };
  });

  app.get<{ Params: { id: string } }>("/v1/panel/cases/:id", async (req) => {
    requireOperator(req.actor);
    const c = await one(
      `SELECT pc.*, pi.name_raw, pi.age_approx, pi.gender, pi.phone_e164,
              pi.national_id_last4, pi.building_name, pi.floor, pi.apartment,
              pi.location_accuracy, pi.reporter_count, pi.narrative,
              ST_Y(pi.last_seen::geometry) AS lat, ST_X(pi.last_seen::geometry) AS lng
         FROM person_case pc LEFT JOIN person_index pi ON pi.case_id = pc.id
        WHERE pc.id = $1`,
      [req.params.id]
    );
    if (!c) throw new HttpError(404, "not found", "not_found");
    const [reports, revisions, sightings, media, merges] = await Promise.all([
      query(`SELECT id, channel, payload, submitted_at, source_ref FROM report
              WHERE case_id = $1 ORDER BY submitted_at`, [req.params.id]),
      query(`SELECT field, old_value, new_value, actor, at FROM report_revision
              WHERE case_id = $1 ORDER BY at DESC LIMIT 100`, [req.params.id]),
      query(`SELECT id, kind, note, trust, source, created_at,
                    ST_Y(geo::geometry) AS lat, ST_X(geo::geometry) AS lng
               FROM sighting WHERE case_id = $1 ORDER BY created_at DESC`, [req.params.id]),
      query(`SELECT id, mime, bytes, consent_public, uploaded_at FROM media
              WHERE case_id = $1 AND deleted_at IS NULL`, [req.params.id]),
      query(`SELECT survivor_id, merged_id, actor, at, undone_at FROM case_merge
              WHERE survivor_id = $1 OR merged_id = $1 ORDER BY at DESC`, [req.params.id]),
    ]);
    await audit(req.actor, "case.view", req.params.id, {});
    return { case: c, reports, revisions, sightings, media, merges };
  });

  // -------------------------------------------------------------------------
  // The decision. A merge NEVER happens automatically — one wrong merge means a
  // team stops looking for someone who is still under the rubble.
  // A merge only re-points case_id, so it is reversible.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/panel/dedup/:id/decide", async (req) => {
    const op = requireOperator(req.actor);
    const parsed = decisionInput.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid decision", "invalid_decision");
    const { decision, survivor_case_id, note } = parsed.data;

    const cand = await one<{ a_case: string; b_case: string; state: string }>(
      `SELECT a_case, b_case, state FROM dedup_candidate WHERE id = $1`, [req.params.id]
    );
    if (!cand) throw new HttpError(404, "not found", "not_found");
    if (cand.state !== "pending") throw new HttpError(409, "already decided", "already_decided");

    if (decision === "reject") {
      await query(
        `UPDATE dedup_candidate SET state='rejected', decided_by=$2, decided_at=now(),
                signals = signals || jsonb_build_object('note', $3::text)
          WHERE id = $1`,
        [req.params.id, op.userId, note ?? null]
      );
      await audit(req.actor, "dedup.reject", req.params.id, { pair: [cand.a_case, cand.b_case] });
      return { ok: true, state: "rejected" };
    }

    // Survivor defaults to the case with more corroborating reports: the record
    // more people contributed to is the one more information hangs off.
    const survivor = survivor_case_id ?? (await one<{ case_id: string }>(
      `SELECT case_id FROM person_index WHERE case_id IN ($1,$2)
        ORDER BY reporter_count DESC, case_id LIMIT 1`, [cand.a_case, cand.b_case]))!.case_id;
    const merged = survivor === cand.a_case ? cand.b_case : cand.a_case;
    if (![cand.a_case, cand.b_case].includes(survivor)) {
      throw new HttpError(400, "survivor must be one of the pair", "bad_survivor");
    }

    await tx(async (c) => {
      const moved = await c.query(
        `UPDATE report SET case_id = $1 WHERE case_id = $2 RETURNING id`, [survivor, merged]
      );
      await c.query(`UPDATE sighting SET case_id = $1 WHERE case_id = $2`, [survivor, merged]);
      await c.query(`UPDATE media    SET case_id = $1 WHERE case_id = $2`, [survivor, merged]);
      await c.query(`UPDATE reporter_token SET case_id = $1 WHERE case_id = $2`, [survivor, merged]);
      await c.query(
        `UPDATE person_case SET merged_into = $1, public_listed = false, updated_at = now()
          WHERE id = $2`, [survivor, merged]
      );
      await c.query(
        `INSERT INTO case_merge (survivor_id, merged_id, moved_reports, candidate_id, actor)
         VALUES ($1,$2,$3,$4,$5)`,
        [survivor, merged, moved.rows.map((r: any) => r.id), Number(req.params.id), op.userId]
      );
      await c.query(
        `UPDATE dedup_candidate SET state='merged', decided_by=$2, decided_at=now() WHERE id=$1`,
        [req.params.id, op.userId]
      );
      // Any other pending pair touching the merged case is now stale.
      await c.query(
        `UPDATE dedup_candidate SET state='superseded'
          WHERE state='pending' AND (a_case=$1 OR b_case=$1) AND id <> $2`,
        [merged, Number(req.params.id)]
      );
      await c.query(`SELECT public.refresh_person_index($1)`, [survivor]);
    });

    await enqueue("correlate", { case_id: survivor }, `correlate:${survivor}`);
    await audit(req.actor, "dedup.merge", survivor, { merged, candidate: req.params.id, note });
    return { ok: true, state: "merged", survivor_case_id: survivor, merged_case_id: merged };
  });

  // Un-merge. The reason the merge only re-pointed ids instead of deleting rows.
  app.post<{ Params: { id: string } }>("/v1/panel/merges/:id/undo", async (req) => {
    const op = requireOperator(req.actor);
    const m = await one<{ survivor_id: string; merged_id: string; moved_reports: string[] }>(
      `SELECT survivor_id, merged_id, moved_reports FROM case_merge
        WHERE id = $1 AND undone_at IS NULL`, [req.params.id]
    );
    if (!m) throw new HttpError(404, "not found or already undone", "not_found");

    await tx(async (c) => {
      await c.query(`UPDATE report SET case_id = $1 WHERE id = ANY($2::uuid[])`,
        [m.merged_id, m.moved_reports]);
      await c.query(`UPDATE person_case SET merged_into = NULL, updated_at = now() WHERE id = $1`,
        [m.merged_id]);
      await c.query(
        `INSERT INTO case_merge (survivor_id, merged_id, actor, undone_at, undone_by)
         VALUES ($1,$2,$3,now(),$3)`, [m.survivor_id, m.merged_id, op.userId]
      );
      await c.query(`SELECT public.refresh_person_index($1)`, [m.survivor_id]);
      await c.query(`SELECT public.refresh_person_index($1)`, [m.merged_id]);
    });
    await audit(req.actor, "dedup.unmerge", m.survivor_id, { restored: m.merged_id });
    return { ok: true };
  });

  // Verified status change. Only field/official sources may declare injury or death.
  app.post<{ Params: { id: string } }>("/v1/panel/cases/:id/status", async (req) => {
    const op = requireOperator(req.actor);
    const parsed = statusUpdate.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid status", "invalid_status");
    const s = parsed.data;

    const prev = await one<{ status: string }>(`SELECT status FROM person_case WHERE id = $1`,
      [req.params.id]);
    if (!prev) throw new HttpError(404, "not found", "not_found");

    await tx(async (c) => {
      await c.query(
        `UPDATE person_case SET status=$2, status_source=$3, status_updated_at=now(),
                updated_at=now() WHERE id=$1`,
        [req.params.id, s.status, s.status_source]
      );
      await c.query(
        `INSERT INTO report_revision (case_id, field, old_value, new_value, actor, reason)
         VALUES ($1,'status',$2,$3,$4,$5)`,
        [req.params.id, JSON.stringify(prev.status), JSON.stringify(s.status),
         `operator:${op.userId}`, s.note ?? null]
      );
    });
    await audit(req.actor, "case.status", req.params.id, { from: prev.status, to: s.status });
    return { ok: true };
  });

  // Operational heat: finer cells than the public map, and includes single cases.
  app.get<{ Querystring: { incident?: string; cell?: string; status?: string } }>(
    "/v1/panel/heat", async (req) => {
      requireOperator(req.actor);
      const inc = await one<{ id: string }>(
        req.query.incident
          ? `SELECT id FROM incident WHERE slug = $1`
          : `SELECT id FROM incident WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        req.query.incident ? [req.query.incident] : []
      );
      if (!inc) return { cells: [] };
      const cell = Math.max(25, Math.min(1000, Number(req.query.cell ?? 100) || 100));
      const statuses = req.query.status ? req.query.status.split(",") : null;
      const cells = await query(`SELECT lat, lng, weight, cases FROM public.heat_cells($1,$2,$3)`,
        [inc.id, cell, statuses]);
      return { cell_m: cell, cells };
    }
  );

  // Export for SAR. Audited, because "who took a copy of the missing list" is
  // a question we must be able to answer.
  app.get<{ Querystring: { incident?: string; format?: string } }>(
    "/v1/panel/export", async (req, reply) => {
      requireOperator(req.actor);
      const fmt = (req.query.format ?? "csv").toLowerCase();
      const rows = await query(
        `SELECT pc.reference_number, pi.name_raw, pi.age_approx, pi.gender, pc.status,
                pi.building_name, pi.floor, pi.apartment, pi.location_accuracy,
                pi.reporter_count, pi.last_seen_at,
                ST_Y(pi.last_seen::geometry) AS lat, ST_X(pi.last_seen::geometry) AS lng
           FROM person_case pc JOIN person_index pi ON pi.case_id = pc.id
           JOIN incident i ON i.id = pc.incident_id
          WHERE ($1::text IS NULL OR i.slug = $1)
            AND pc.merged_into IS NULL AND pc.anonymised_at IS NULL
          ORDER BY pc.status, pi.name_raw`,
        [req.query.incident ?? null]
      );
      await audit(req.actor, "export", req.query.incident ?? null,
        { format: fmt, rows: rows.length });

      if (fmt === "geojson") {
        reply.header("Content-Type", "application/geo+json");
        return {
          type: "FeatureCollection",
          features: rows.filter((r) => r.lat != null).map((r) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [r.lng, r.lat] },
            properties: r,
          })),
        };
      }
      if (fmt === "kml") {
        reply.header("Content-Type", "application/vnd.google-earth.kml+xml");
        const esc = (s: any) => String(s ?? "").replace(/[<>&]/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
        return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
${rows.filter((r) => r.lat != null).map((r) => `<Placemark><name>${esc(r.reference_number)} ${esc(r.name_raw)}</name><description>${esc(r.status)} | reports: ${esc(r.reporter_count)}</description><Point><coordinates>${r.lng},${r.lat},0</coordinates></Point></Placemark>`).join("\n")}
</Document></kml>`;
      }
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="cases.csv"`);
      const cols = Object.keys(rows[0] ?? { reference_number: null });
      const cell = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
    }
  );

  // Admin: erasure on request, and the audit trail itself.
  app.post<{ Params: { id: string } }>("/v1/panel/cases/:id/anonymise", async (req) => {
    const admin = requireAdmin(req.actor);
    const reason = (req.body as any)?.reason ?? "admin request";
    await query(`SELECT public.anonymise_case($1,$2,$3)`,
      [req.params.id, `operator:${admin.userId}`, reason]);
    return { ok: true };
  });

  app.get<{ Querystring: { subject?: string; limit?: string } }>("/v1/panel/audit", async (req) => {
    requireAdmin(req.actor);
    const rows = await query(
      `SELECT id, actor, role, action, subject, at, detail FROM audit_log
        WHERE ($1::text IS NULL OR subject = $1)
        ORDER BY at DESC LIMIT $2`,
      [req.query.subject ?? null, Math.min(Number(req.query.limit ?? 200) || 200, 1000)]
    );
    return { entries: rows };
  });
}

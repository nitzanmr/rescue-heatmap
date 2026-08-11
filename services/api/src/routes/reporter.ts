import type { FastifyInstance } from "fastify";
import { one, query, tx } from "../db.js";
import { reporterUpdate } from "../schema.js";
import { HttpError, noIndex } from "../security.js";
import { audit } from "../audit.js";
import { enqueue } from "../jobs.js";

// The family's private link. No account, no password — an unguessable token that
// grants access to exactly one case and nothing else.
export default async function reporterRoutes(app: FastifyInstance) {
  app.get("/v1/reporter/case", async (req, reply) => {
    noIndex(reply);
    const a = req.actor;
    if (a.kind !== "reporter") throw new HttpError(401, "reporter token required", "unauthorized");

    const row = await one(
      `SELECT pc.id, pc.reference_number, pc.status, pc.status_updated_at,
              pc.public_listed, pc.consent_photo_public, pc.merged_into,
              pi.name_raw, pi.age_approx, pi.gender, pi.last_seen_at,
              pi.building_name, pi.floor, pi.apartment, pi.reporter_count,
              ST_Y(pi.last_seen::geometry) AS lat, ST_X(pi.last_seen::geometry) AS lng
         FROM person_case pc LEFT JOIN person_index pi ON pi.case_id = pc.id
        WHERE pc.id = $1`,
      [a.caseId]
    );
    if (!row) throw new HttpError(404, "not found", "not_found");

    const sightings = await query(
      `SELECT kind, note, created_at, trust FROM sighting
        WHERE case_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [a.caseId]
    );
    // If the case was merged, the family must land on the surviving case rather
    // than on a page that silently stopped being updated.
    return { case: row, sightings, merged_into: row.merged_into };
  });

  // PATCH — the family remembers something new at 4 a.m. Nothing is overwritten:
  // every field change is a report_revision row (ניצן's versioning requirement).
  app.patch("/v1/reporter/case", async (req) => {
    const a = req.actor;
    if (a.kind !== "reporter") throw new HttpError(401, "reporter token required", "unauthorized");

    const parsed = reporterUpdate.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid update", "invalid_update");
    const u = parsed.data;
    if (Object.keys(u).length === 0) return { ok: true, changed: 0 };

    const changed = await tx(async (c) => {
      const last = await c.query(
        `SELECT id, payload FROM report WHERE case_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
        [a.caseId]
      );
      if (last.rowCount === 0) throw new HttpError(404, "not found", "not_found");
      const prev = last.rows[0].payload as Record<string, unknown>;

      let n = 0;
      for (const [field, value] of Object.entries(u)) {
        if (value === undefined) continue;
        if (JSON.stringify(prev[field] ?? null) === JSON.stringify(value)) continue;
        await c.query(
          `INSERT INTO report_revision (case_id, report_id, field, old_value, new_value, actor)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [a.caseId, last.rows[0].id, field, JSON.stringify(prev[field] ?? null),
           JSON.stringify(value), `reporter:${a.tokenHash.slice(0, 12)}`]
        );
        n++;
      }
      if (n === 0) return 0;

      // A correction from the family is itself a submission: it becomes a new
      // append-only report row, so the evidence chain stays intact.
      await c.query(
        `INSERT INTO report (case_id, incident_id, channel, payload, source_ref)
         SELECT $1, incident_id, 'pwa', payload || $2::jsonb, 'reporter_update'
           FROM report WHERE id = $3`,
        [a.caseId, JSON.stringify(u), last.rows[0].id]
      );

      if (u.consent_public_listing !== undefined || u.consent_photo_public !== undefined) {
        await c.query(
          `UPDATE person_case
              SET public_listed = COALESCE($2, public_listed),
                  consent_photo_public = COALESCE($3, consent_photo_public),
                  updated_at = now()
            WHERE id = $1`,
          [a.caseId, u.consent_public_listing ?? null, u.consent_photo_public ?? null]
        );
        if (u.consent_photo_public !== undefined) {
          await c.query(`UPDATE media SET consent_public = $2 WHERE case_id = $1`,
            [a.caseId, u.consent_photo_public]);
        }
      }

      // The family may say "found safe" or withdraw. They may not declare a
      // death or an injury — that requires field verification.
      if (u.status) {
        await c.query(
          `UPDATE person_case SET status = $2, status_source = 'citizen',
                  status_updated_at = now(), updated_at = now()
            WHERE id = $1`,
          [a.caseId, u.status]
        );
      }

      await c.query(`SELECT public.refresh_person_index($1)`, [a.caseId]);
      return n;
    });

    if (changed) {
      await enqueue("correlate", { case_id: a.caseId }, `correlate:${a.caseId}`, 5);
      await audit(req.actor, "case.reporter_update", a.caseId, { fields: Object.keys(u) });
    }
    return { ok: true, changed };
  });

  // Right to erasure, exercised without an account: anonymise in place. The case
  // skeleton and the audit trail survive; everything identifying does not.
  app.post("/v1/reporter/case/erase", async (req) => {
    const a = req.actor;
    if (a.kind !== "reporter") throw new HttpError(401, "reporter token required", "unauthorized");
    await query(`SELECT public.anonymise_case($1,$2,$3)`,
      [a.caseId, `reporter:${a.tokenHash.slice(0, 12)}`, "reporter request"]);
    await audit(req.actor, "case.erase_request", a.caseId, {});
    return { ok: true };
  });
}

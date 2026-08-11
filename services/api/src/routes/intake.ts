import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { one, query, tx } from "../db.js";
import { reportInput } from "../schema.js";
import { toE164 } from "../phone.js";
import { config } from "../config.js";
import { audit } from "../audit.js";
import { HttpError, newReference, newToken, hashToken, rateLimit } from "../security.js";
import { enqueue } from "../jobs.js";
import { storage, mediaKey } from "../storage.js";

export default async function intakeRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /v1/reports — the only write path into the system, for every channel.
  //
  // Three properties this endpoint must have, in order:
  //   1. It accepts. A report lost during an earthquake is not recoverable.
  //   2. It is idempotent. Offline queues retry; three arrivals = one report.
  //   3. It is fast. Correlation happens in the worker, never inline.
  // -------------------------------------------------------------------------
  app.post("/v1/reports", async (req, reply) => {
    const actor = req.actor;
    await rateLimit(`intake:${actor.ipHash}`, config.limits.intakePerHour, 3600);

    const parsed = reportInput.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid_report");
    }
    const r = parsed.data;

    const incident = await one<{ id: string; ref_prefix: string }>(
      r.incident_slug
        ? `SELECT id, ref_prefix FROM incident WHERE slug = $1`
        : `SELECT id, ref_prefix FROM incident WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      r.incident_slug ? [r.incident_slug] : []
    );
    if (!incident) throw new HttpError(503, "no active incident", "no_incident");

    const idem = r.uuid ? `${incident.id}:${r.uuid}` : null;

    // Replay of an already-accepted submission: return the original answer.
    if (idem) {
      const prior = await one<{ case_id: string; reference_number: string }>(
        `SELECT rp.case_id, pc.reference_number
           FROM report rp JOIN person_case pc ON pc.id = rp.case_id
          WHERE rp.idempotency_key = $1`,
        [idem]
      );
      if (prior) {
        reply.header("Idempotent-Replay", "true");
        return { case_id: prior.case_id, reference_number: prior.reference_number, replay: true };
      }
    }

    const reporterPhone = toE164(r.reporter_phone);
    const isMinor = r.is_minor ?? (r.age_approx != null && r.age_approx < 18);

    const out = await tx(async (c) => {
      // Reference numbers are short and therefore collidable; retry a few times
      // rather than pushing a unique-violation back at a frightened family.
      let ref = "";
      for (let i = 0; i < 8; i++) {
        ref = newReference(incident.ref_prefix);
        const clash = await c.query(
          `SELECT 1 FROM person_case WHERE incident_id = $1 AND reference_number = $2`,
          [incident.id, ref]
        );
        if (clash.rowCount === 0) break;
        ref = "";
      }
      if (!ref) throw new HttpError(500, "could not allocate reference", "ref_exhausted");

      const caseRow = await c.query(
        `INSERT INTO person_case
           (incident_id, status, status_source, reference_number,
            public_listed, consent_photo_public, is_minor)
         VALUES ($1,$2,'citizen',$3,$4,$5,$6)
         RETURNING id`,
        [incident.id, r.status, ref, r.consent_public_listing, r.consent_photo_public, isMinor]
      );
      const caseId: string = caseRow.rows[0].id;

      const reportRow = await c.query(
        `INSERT INTO report
           (case_id, incident_id, channel, payload, source_ref, idempotency_key,
            device_uuid, created_at_device, clock_skew_ms, reporter_phone_e164, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          caseId, incident.id, r.channel, JSON.stringify(r), r.source_ref ?? null, idem,
          r.uuid ?? null, r.created_at_device ?? null,
          // Offline devices have wrong clocks. Record the skew instead of trusting
          // either side, so "last seen at" can be reasoned about later.
          r.created_at_device ? Date.now() - Date.parse(r.created_at_device) : null,
          reporterPhone, actor.ipHash,
        ]
      );

      const token = newToken();
      await c.query(
        `INSERT INTO reporter_token (token_hash, case_id) VALUES ($1,$2)`,
        [hashToken(token), caseId]
      );

      // Index synchronously: the case must be correlatable the moment it exists.
      // Correlation itself is queued — it is allowed to take a second.
      await c.query(`SELECT public.refresh_person_index($1)`, [caseId]);

      return { caseId, reportId: reportRow.rows[0].id as string, ref, token };
    });

    await enqueue("correlate", { case_id: out.caseId }, `correlate:${out.caseId}`);
    await audit(actor, "report.create", out.caseId, { channel: r.channel, reference: out.ref });

    reply.code(201);
    return {
      case_id: out.caseId,
      report_id: out.reportId,
      reference_number: out.ref,
      // Shown once. This is the family's private link; we cannot re-issue it.
      reporter_token: out.token,
      reporter_url: `/r/${out.ref}?t=${out.token}`,
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/reports/:caseId/media — photo upload.
  // Bytes go to StoragePort; Postgres keeps only the reference (ניצן's rule).
  // -------------------------------------------------------------------------
  app.post<{ Params: { caseId: string } }>("/v1/reports/:caseId/media", async (req, reply) => {
    const actor = req.actor;
    if (actor.kind === "anon") throw new HttpError(401, "reporter token required", "unauthorized");
    if (actor.kind === "reporter" && actor.caseId !== req.params.caseId) {
      throw new HttpError(403, "token does not belong to this case", "forbidden");
    }

    const file = await (req as any).file();
    if (!file) throw new HttpError(400, "no file", "no_file");
    const buf: Buffer = await file.toBuffer();
    if (buf.byteLength > config.limits.photoMaxBytes) {
      throw new HttpError(413, "photo too large", "too_large");
    }
    const mime: string = file.mimetype ?? "application/octet-stream";
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
      throw new HttpError(415, "unsupported image type", "bad_mime");
    }

    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    // The same photo shared through five relatives is one photo, and it is also
    // a strong dedup signal in its own right.
    const dup = await one<{ id: string }>(
      `SELECT id FROM media WHERE case_id = $1 AND sha256 = $2 AND deleted_at IS NULL`,
      [req.params.caseId, sha]
    );
    if (dup) return { media_id: dup.id, duplicate: true };

    const id = crypto.randomUUID();
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    const key = mediaKey(req.params.caseId, id, ext);
    await storage.put(key, buf, mime);

    await query(
      `INSERT INTO media (id, case_id, storage_key, bucket, mime, bytes, sha256,
                          consent_public, purge_after)
       SELECT $1,$2,$3,$4,$5,$6,$7, pc.consent_photo_public,
              now() + make_interval(days => $8)
       FROM person_case pc WHERE pc.id = $2`,
      [id, req.params.caseId, key, config.storage.bucket, mime, buf.byteLength, sha,
       config.retention.mediaDays]
    );

    await enqueue("media_derive", { media_id: id }, `media_derive:${id}`);
    await audit(actor, "media.upload", req.params.caseId, { media_id: id, bytes: buf.byteLength });

    reply.code(201);
    return { media_id: id, bytes: buf.byteLength };
  });
}

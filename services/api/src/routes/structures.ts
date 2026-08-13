import type { FastifyInstance } from "fastify";
import { one, query, tx } from "../db.js";
import {
  structureInput, structureLink, structurePoint, structureResolve, structureScan,
} from "../schema.js";
import { HttpError, requireOperator } from "../security.js";
import { audit } from "../audit.js";

// The structure board — the screen a rescue team is actually dispatched from.
//
// The dedup queue answers "are these two records one person". This file answers
// the other operational question, the one the Cali dossier was written by hand
// to answer: "which building, how many people still unaccounted for inside it,
// and has anyone signed it clear".
//
// Three rules run through every route here, and they are the same three rules
// as everywhere else in this system:
//   · nothing invents a coordinate;
//   · nothing is decided anonymously;
//   · nothing that stops a search happens without a person signing it.
export default async function structureRoutes(app: FastifyInstance) {
  const incidentId = async (slug?: string): Promise<string | null> => {
    const inc = await one<{ id: string }>(
      slug
        ? `SELECT id FROM incident WHERE slug = $1`
        : `SELECT id FROM incident WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      slug ? [slug] : []
    );
    return inc?.id ?? null;
  };

  // -------------------------------------------------------------------------
  // The board. Counts only — no names. Ordered the way a dispatcher reads it:
  // the building with the most people still unaccounted for, first.
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { incident?: string } }>("/v1/panel/structures", async (req) => {
    requireOperator(req.actor);
    const inc = await incidentId(req.query.incident);
    if (!inc) return { structures: [] };
    const structures = await query(
      `SELECT * FROM public.structure_board
        WHERE incident_id = $1
        ORDER BY (scan_state = 'clear'), open_people DESC, people DESC, name`,
      [inc]
    );
    return { structures };
  });

  // One structure, with the people named against it. This carries names, so it
  // is operator-only and audited like any other read of the missing list.
  app.get<{ Params: { id: string } }>("/v1/panel/structures/:id", async (req) => {
    requireOperator(req.actor);
    const s = await one(
      `SELECT * FROM public.structure_board WHERE id = $1`, [req.params.id]);
    if (!s) throw new HttpError(404, "not found", "not_found");
    const [people, events] = await Promise.all([
      // structure_person, never structure_case: it follows merges, so a person
      // an operator deduplicated stays on the board instead of quietly
      // dropping out of the building's head-count.
      query(
        `SELECT sp.case_id,
                COALESCE(sp.resolution, 'unresolved') AS resolution,
                sp.resolved_by, sp.resolved_at, sp.link_source, sp.confidence, sp.note,
                pc.reference_number, pc.status, pc.is_minor,
                pi.name_raw, pi.age_approx, pi.gender, pi.reporter_count,
                pi.last_seen IS NOT NULL AS has_point
           FROM structure_person sp
           JOIN person_case pc ON pc.id = sp.case_id
           LEFT JOIN person_index pi ON pi.case_id = sp.case_id
          WHERE sp.structure_id = $1
            AND pc.anonymised_at IS NULL
          ORDER BY sp.is_open DESC, pc.is_minor DESC,
                   pi.age_approx DESC NULLS LAST, pi.name_raw`,
        [req.params.id]
      ),
      query(
        `SELECT id, kind, case_id, from_value, to_value, actor, note, at
           FROM structure_event WHERE structure_id = $1 ORDER BY at DESC LIMIT 100`,
        [req.params.id]
      ),
    ]);
    await audit(req.actor, "structure.view", req.params.id, { people: people.length });
    return { structure: s, people, events };
  });

  // -------------------------------------------------------------------------
  // Create. Deliberately cannot carry a point: a name typed into a form and a
  // pin placed on a map are two different statements, and only the second one
  // sends a team somewhere.
  // -------------------------------------------------------------------------
  app.post<{ Querystring: { incident?: string } }>("/v1/panel/structures", async (req) => {
    const op = requireOperator(req.actor);
    const parsed = structureInput.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid structure", "invalid_structure");
    const s = parsed.data;
    const inc = await incidentId(req.query.incident);
    if (!inc) throw new HttpError(404, "no active incident", "no_incident");

    // Row and log in one transaction: a structure that exists with no record of
    // who created it is the start of an unauditable board.
    const id = await tx(async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO structure (incident_id, key, name, address_text, neighbourhood,
                                municipality, authority_status, authority_source, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (incident_id, key) DO UPDATE
           SET name = EXCLUDED.name,
               address_text = COALESCE(EXCLUDED.address_text, structure.address_text),
               neighbourhood = COALESCE(EXCLUDED.neighbourhood, structure.neighbourhood),
               municipality = COALESCE(EXCLUDED.municipality, structure.municipality)
         RETURNING id`,
        [inc, s.key, s.name, s.address_text ?? null, s.neighbourhood ?? null,
         s.municipality ?? null, s.authority_status, s.authority_source ?? null, s.note ?? null]
      );
      const newId = res.rows[0]!.id;
      await c.query(
        `INSERT INTO structure_event (structure_id, kind, to_value, actor, note)
         VALUES ($1,'created',$2,$3,$4)`,
        [newId, JSON.stringify({ key: s.key, name: s.name }), `operator:${op.userId}`, s.note ?? null]
      );
      return newId;
    });
    await audit(req.actor, "structure.create", id, { key: s.key });
    return { ok: true, id };
  });

  // -------------------------------------------------------------------------
  // The pin. Signed, graded, logged — and the previous point is kept in the
  // event log, so "who moved this building and when" is answerable.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/panel/structures/:id/point", async (req) => {
    const op = requireOperator(req.actor);
    const parsed = structurePoint.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid point", "invalid_point");
    const p = parsed.data;

    const prev = await one<{ lat: number | null; lng: number | null; point_precision: string | null }>(
      `SELECT lat, lng, point_precision FROM structure WHERE id = $1`, [req.params.id]);
    if (!prev) throw new HttpError(404, "not found", "not_found");

    await tx(async (c) => {
      await c.query(
        `UPDATE structure
            SET lat=$2, lng=$3, point_precision=$4, point_source=$5,
                point_set_by=$6, point_set_at=now(), point_note=$7
          WHERE id=$1`,
        [req.params.id, p.lat, p.lng, p.precision, p.source,
         `operator:${op.userId}`, p.note ?? null]
      );
      await c.query(
        `INSERT INTO structure_event (structure_id, kind, from_value, to_value, actor, note)
         VALUES ($1,'point',$2,$3,$4,$5)`,
        [req.params.id, JSON.stringify(prev), JSON.stringify(p),
         `operator:${op.userId}`, p.note ?? null]
      );
    });
    await audit(req.actor, "structure.point", req.params.id, { precision: p.precision });
    return { ok: true };
  });

  // Give the structure's point to the people inside it who have none. The
  // function refuses coarse points and never overwrites an existing location;
  // both refusals come back as an explanation, not a silent no-op.
  app.post<{ Params: { id: string } }>("/v1/panel/structures/:id/project-point", async (req) => {
    const op = requireOperator(req.actor);
    const note = typeof (req.body as any)?.note === "string" ? (req.body as any).note : null;
    try {
      // One refresh_person_index per person, and a big structure has dozens.
      // app_rw's 8 s statement_timeout (0005) is right for intake and wrong
      // here, and a timeout halfway through rolls the whole thing back — which
      // from the panel is indistinguishable from nothing having happened. The
      // timeout is armed when a statement starts, so it has to be raised in a
      // separate statement, before this one, inside the same transaction.
      const n = await tx(async (c) => {
        await c.query(`SET LOCAL statement_timeout = '60s'`);
        const res = await c.query<{ n: number }>(
          `SELECT public.project_structure_point($1,$2,$3) AS n`,
          [req.params.id, `operator:${op.userId}`, note]
        );
        return Number(res.rows[0]?.n ?? 0);
      });
      await audit(req.actor, "structure.project_point", req.params.id, { cases: n });
      return { ok: true, cases_located: n };
    } catch (e) {
      throw explain(e, "project_point_refused");
    }
  });

  // -------------------------------------------------------------------------
  // The scan verdict. 'clear' is guarded in the database; when it is refused,
  // this route answers with the list of people standing in the way rather than
  // a generic error. A blocked action that does not say why reads as broken.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/panel/structures/:id/scan", async (req) => {
    const op = requireOperator(req.actor);
    const parsed = structureScan.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid scan state", "invalid_scan_state");
    const s = parsed.data;

    const prev = await one<{ scan_state: string }>(
      `SELECT scan_state FROM structure WHERE id = $1`, [req.params.id]);
    if (!prev) throw new HttpError(404, "not found", "not_found");

    if (s.scan_state === "clear") {
      const blockers = await query(
        `SELECT * FROM public.structure_blockers($1)`, [req.params.id]);
      if (blockers.length > 0) {
        throw new HttpError(
          409,
          `${blockers.length} person(s) are still unresolved in this structure`,
          "structure_has_open_cases",
          { blockers }
        );
      }
    }

    try {
      await tx(async (c) => {
        await c.query(
          `UPDATE structure
              SET scan_state=$2,
                  scan_signed_by = CASE WHEN $2 = 'not_scanned' THEN NULL ELSE $3 END,
                  scan_signed_at = CASE WHEN $2 = 'not_scanned' THEN NULL ELSE now() END,
                  scan_note=$4
            WHERE id=$1`,
          [req.params.id, s.scan_state, `operator:${op.userId}`, s.note ?? null]
        );
        await c.query(
          `INSERT INTO structure_event (structure_id, kind, from_value, to_value, actor, note)
           VALUES ($1,'scan',$2,$3,$4,$5)`,
          [req.params.id, JSON.stringify(prev.scan_state), JSON.stringify(s.scan_state),
           `operator:${op.userId}`, s.note ?? null]
        );
      });
    } catch (e) {
      throw explain(e, "scan_refused");
    }
    await audit(req.actor, "structure.scan", req.params.id,
      { from: prev.scan_state, to: s.scan_state });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // People in and out of the structure.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/panel/structures/:id/cases", async (req) => {
    const op = requireOperator(req.actor);
    const parsed = structureLink.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid link", "invalid_link");
    const l = parsed.data;
    const exists = await one<{ id: string }>(`SELECT id FROM person_case WHERE id = $1`, [l.case_id]);
    if (!exists) throw new HttpError(404, "case not found", "not_found");

    await tx(async (c) => {
      await c.query(
        `INSERT INTO structure_case (structure_id, case_id, link_source, confidence, note)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (structure_id, case_id) DO UPDATE
           SET confidence = EXCLUDED.confidence,
               note = COALESCE(EXCLUDED.note, structure_case.note)`,
        [req.params.id, l.case_id, l.link_source, l.confidence, l.note ?? null]
      );
      await c.query(
        `INSERT INTO structure_event (structure_id, kind, case_id, to_value, actor, note)
         VALUES ($1,'link',$2,$3,$4,$5)`,
        [req.params.id, l.case_id, JSON.stringify({ confidence: l.confidence }),
         `operator:${op.userId}`, l.note ?? null]
      );
    });
    await audit(req.actor, "structure.link", req.params.id, { case_id: l.case_id });
    return { ok: true };
  });

  // Resolving a person HERE is not a statement about the person: it says they
  // are no longer to be searched for in THIS building. Their case status is a
  // separate, deliberate act (/v1/panel/cases/:id/status) — a body recovered
  // and a person found at their sister's house are not the same fact, and one
  // click must not be able to produce both.
  app.post<{ Params: { id: string; caseId: string } }>(
    "/v1/panel/structures/:id/cases/:caseId/resolve",
    async (req) => {
      const op = requireOperator(req.actor);
      const parsed = structureResolve.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, "invalid resolution", "invalid_resolution");
      const r = parsed.data;

      // Matched through effective_case: the panel lists surviving cases, and a
      // person may reach this structure through a record that was merged away.
      // Every link that resolves to the same human moves together.
      const prev = await one<{ resolution: string }>(
        `SELECT resolution FROM structure_case
          WHERE structure_id = $1
            AND public.effective_case(case_id) = public.effective_case($2)
          ORDER BY (resolution <> 'unresolved') DESC LIMIT 1`,
        [req.params.id, req.params.caseId]
      );
      if (!prev) throw new HttpError(404, "not linked to this structure", "not_found");

      await tx(async (c) => {
        await c.query(
          `UPDATE structure_case
              SET resolution=$3,
                  resolved_by = CASE WHEN $3 = 'unresolved' THEN NULL ELSE $4 END,
                  resolved_at = CASE WHEN $3 = 'unresolved' THEN NULL ELSE now() END,
                  note = COALESCE($5, note)
            WHERE structure_id=$1
              AND public.effective_case(case_id) = public.effective_case($2)`,
          [req.params.id, req.params.caseId, r.resolution, `operator:${op.userId}`, r.note ?? null]
        );
        await c.query(
          `INSERT INTO structure_event (structure_id, kind, case_id, from_value, to_value, actor, note)
           VALUES ($1,'resolution',$2,$3,$4,$5,$6)`,
          [req.params.id, req.params.caseId, JSON.stringify(prev.resolution),
           JSON.stringify(r.resolution), `operator:${op.userId}`, r.note ?? null]
        );
      });
      await audit(req.actor, "structure.resolve", req.params.id,
        { case_id: req.params.caseId, from: prev.resolution, to: r.resolution });
      return { ok: true };
    }
  );
}

// A database refusal is a sentence someone wrote on purpose (the HINT on the
// trigger, on project_structure_point). Passing it through beats replacing it
// with "500 internal error", which tells an operator in the field nothing.
function explain(e: unknown, code: string): HttpError {
  const err = e as { code?: string; message?: string; hint?: string };
  if (err?.code === "23514" || err?.code === "P0002") {
    return new HttpError(409, [err.message, err.hint].filter(Boolean).join(" — "), code);
  }
  return e instanceof HttpError ? e : new HttpError(500, err?.message ?? "failed", code);
}

-- 0018_structure_entity.sql — a collapsed building becomes a thing the system
-- knows about, and "this structure is clear" becomes a signed statement that
-- cannot be made while somebody is still unaccounted for inside it.
--
-- WHY NOW
--   An Israeli SAR team lands in Cali in ~48 hours. What they need is not a
--   heat map: it is a list of STRUCTURES, each with the people named against
--   it, and a way to sign "we searched this one, it is clear". Until this
--   migration the database had no such object. It had:
--     · person_case          — a person, with a status
--     · place_nomination     — a QUESTION about a free-text place (0015/0016)
--     · case_location_override — an operator's point for ONE person
--   A nomination is not a structure. It is a folded spelling of a string, it
--   dies when the source is forgotten (forget_external_places), and it has no
--   operational state. Hanging "cleared / not cleared" off it would put a
--   rescue decision on a row whose whole purpose is data hygiene.
--
--   So the target dossier for Cali lived in a markdown file and a scratch
--   tracker outside the product. That is scaffolding, and scaffolding during an
--   event becomes a second source of truth that contradicts the first. This
--   migration is what lets the scaffolding be thrown away.
--
-- THE ONE INVARIANT THIS FILE EXISTS FOR
--   A structure may not be marked 'clear' while any person linked to it is
--   still unresolved. Enforced by a trigger, not by the API: an operator
--   clicking through a screen, a script, and a psql session must all hit the
--   same wall. "Clear" is the sentence that stops people digging.
--
-- WHAT THIS MIGRATION REFUSES TO DO
--   · It does not geocode, and it invents no coordinate. A structure's point is
--     NULL until a person pins it, and a point without a signature is rejected
--     by a CHECK — same doctrine as 0015/0016.
--   · It does not push a structure's point onto the people inside it silently.
--     project_structure_point() is an explicit, audited call, it refuses to run
--     on a neighbourhood-grade point, and it never overwrites a location a
--     family or an operator already gave.
--   · It does not decide that two people are one. Resolution here answers "is
--     this person still inside this building", never "is this the same person".
--
-- Append-only. Idempotent. Nothing already applied is edited.

SET LOCAL search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1 · The structure.
--
-- `key` is a stable slug per incident so an import can be re-run without
-- creating a second row for the same building — the same reason
-- place_nomination has cluster_key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS structure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id    uuid NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
  key            text NOT NULL,
  name           text NOT NULL,
  address_text   text,
  neighbourhood  text,
  municipality   text,

  -- Where it is. All of this is NULL until a human or a graded lookup fills it.
  lat            double precision,
  lng            double precision,
  -- Same vocabulary as place_nomination.cand_precision (0016), deliberately:
  -- one word must mean one thing across the system.
  point_precision text,
  point_source   text,
  point_set_by   text,
  point_set_at   timestamptz,
  point_note     text,

  -- Operational state. 'not_scanned' is the honest default: absence of a scan
  -- is not evidence of anything.
  scan_state     text NOT NULL DEFAULT 'not_scanned',
  scan_signed_by text,
  scan_signed_at timestamptz,
  scan_note      text,

  -- Has anyone official confirmed this building actually collapsed and is on
  -- their list. Nothing here is verified until someone says who verified it.
  authority_status text NOT NULL DEFAULT 'unverified',
  authority_source text,

  -- Optional provenance back to the free-text question this came from.
  nomination_id  uuid REFERENCES place_nomination(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT structure_scan_state_ck CHECK (scan_state IN
    ('not_scanned','in_progress','partial','clear','unsafe','unreachable')),
  CONSTRAINT structure_authority_ck CHECK (authority_status IN
    ('unverified','reported','confirmed')),
  CONSTRAINT structure_point_precision_ck CHECK (point_precision IS NULL OR
    point_precision IN ('building','street','area','town')),
  -- Latitude without longitude is not half a point, it is a broken one.
  CONSTRAINT structure_point_pair_ck CHECK ((lat IS NULL) = (lng IS NULL)),
  -- A coordinate with no grade is the exact thing 0016 exists to prevent: it
  -- looks authoritative and says nothing about how wrong it may be.
  CONSTRAINT structure_point_graded_ck CHECK (lat IS NULL OR point_precision IS NOT NULL),
  -- And no point is anonymous. Somebody put this pin here; their name rides
  -- with it, because a team drives to it.
  CONSTRAINT structure_point_signed_ck CHECK (lat IS NULL OR
    (point_set_by IS NOT NULL AND point_set_at IS NOT NULL)),
  -- Every scan verdict other than "we have not been there" is signed.
  CONSTRAINT structure_scan_signed_ck CHECK (scan_state = 'not_scanned' OR
    (scan_signed_by IS NOT NULL AND scan_signed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS structure_key_uq
  ON structure (incident_id, key);
CREATE INDEX IF NOT EXISTS structure_scan
  ON structure (incident_id, scan_state);

COMMENT ON TABLE structure IS
  'A building rescue teams are sent to. Point is NULL until a person pins it; scan_state is not_scanned until a person signs otherwise.';
COMMENT ON COLUMN structure.point_precision IS
  'building | street | area | town — same vocabulary as place_nomination.cand_precision. Anything coarser than building is a search area, not an address.';
COMMENT ON COLUMN structure.scan_state IS
  'not_scanned | in_progress | partial | clear | unsafe | unreachable. clear is guarded: see structure_no_silent_clear().';

-- ---------------------------------------------------------------------------
-- 2 · Who is inside it, and whether they are still inside it.
--
-- `resolution` is a fact about the LINK, not about the person: "found alive"
-- belongs on person_case.status and is a statement about a human being;
-- "not at this structure" is a statement about this building only, and the same
-- person may still be open against another one. Conflating them is how a
-- person gets written off because one building turned out to be the wrong
-- building.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS structure_case (
  structure_id uuid NOT NULL REFERENCES structure(id) ON DELETE CASCADE,
  case_id      uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  -- How this person came to be attached here: what a family said, what the
  -- place-nomination fold produced, or an operator's judgement.
  link_source  text NOT NULL DEFAULT 'operator',
  confidence   text NOT NULL DEFAULT 'reported',
  resolution   text NOT NULL DEFAULT 'unresolved',
  resolved_by  text,
  resolved_at  timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (structure_id, case_id),
  CONSTRAINT structure_case_link_source_ck CHECK (link_source IN
    ('reported','nomination','operator','import')),
  CONSTRAINT structure_case_confidence_ck CHECK (confidence IN
    ('reported','inferred','confirmed')),
  CONSTRAINT structure_case_resolution_ck CHECK (resolution IN
    ('unresolved','recovered_alive','recovered_deceased','not_at_structure','withdrawn')),
  -- A resolution nobody signed is a rumour with a timestamp.
  CONSTRAINT structure_case_resolution_signed_ck CHECK (resolution = 'unresolved' OR
    (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS structure_case_by_case ON structure_case (case_id);
CREATE INDEX IF NOT EXISTS structure_case_open
  ON structure_case (structure_id) WHERE resolution = 'unresolved';

COMMENT ON TABLE structure_case IS
  'A person named against a building. resolution answers "still inside THIS structure?" — never "is this the same person as that one".';

-- ---------------------------------------------------------------------------
-- 3 · The log. Append-only, like audit_log and report: who moved the pin, who
--     signed the scan, who resolved a person, and when.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS structure_event (
  id           bigserial PRIMARY KEY,
  structure_id uuid NOT NULL REFERENCES structure(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  case_id      uuid REFERENCES person_case(id) ON DELETE SET NULL,
  from_value   jsonb,
  to_value     jsonb,
  actor        text NOT NULL,
  note         text,
  at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT structure_event_kind_ck CHECK (kind IN
    ('created','point','scan','link','unlink','resolution','authority','project_point'))
);

CREATE INDEX IF NOT EXISTS structure_event_by_structure
  ON structure_event (structure_id, at DESC);

COMMENT ON TABLE structure_event IS
  'Append-only history of every operational statement made about a structure. The application may insert; it may never rewrite.';

-- ---------------------------------------------------------------------------
-- 4 · The invariant, in the database.
--
-- Why a trigger and not a CHECK: the condition spans two tables. Why not only
-- in the API: because the API is not the only thing that will ever write here,
-- and this is the one sentence in the system whose consequence is that people
-- stop digging.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.structure_no_silent_clear()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_open int;
BEGIN
  IF NEW.scan_state = 'clear'
     AND (TG_OP = 'INSERT' OR OLD.scan_state IS DISTINCT FROM 'clear') THEN
    SELECT count(*) INTO n_open
      FROM structure_case sc
      JOIN person_case pc ON pc.id = sc.case_id
     WHERE sc.structure_id = NEW.id
       AND sc.resolution = 'unresolved'
       -- A case merged into another is represented by its survivor, not by
       -- itself: counting it would block a clear forever.
       AND pc.merged_into IS NULL;
    IF n_open > 0 THEN
      RAISE EXCEPTION
        'structure % cannot be marked clear: % person(s) still unresolved here',
        NEW.id, n_open
        USING ERRCODE = 'check_violation',
              HINT = 'Resolve each person (recovered_alive / recovered_deceased / not_at_structure) before signing the structure clear.';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS structure_clear_guard ON structure;
CREATE TRIGGER structure_clear_guard
  BEFORE INSERT OR UPDATE ON structure
  FOR EACH ROW EXECUTE FUNCTION public.structure_no_silent_clear();

COMMENT ON FUNCTION public.structure_no_silent_clear() IS
  'Refuses "clear" while anyone linked to the structure is unresolved. The one rule this migration exists for.';

-- What is standing in the way, so a screen can SAY it instead of greying a
-- button out. A disabled control that does not explain itself reads as broken.
CREATE OR REPLACE FUNCTION public.structure_blockers(p_structure uuid)
RETURNS TABLE (case_id uuid, reference_number text, name_raw text,
               age_approx int, status text, is_minor boolean)
LANGUAGE sql STABLE AS $$
  SELECT pc.id, pc.reference_number, pi.name_raw, pi.age_approx, pc.status, pc.is_minor
    FROM structure_case sc
    JOIN person_case pc ON pc.id = sc.case_id
    LEFT JOIN person_index pi ON pi.case_id = pc.id
   WHERE sc.structure_id = p_structure
     AND sc.resolution = 'unresolved'
     AND pc.merged_into IS NULL
   ORDER BY pc.is_minor DESC, COALESCE(pi.age_approx, 0) DESC, pi.name_raw;
$$;

COMMENT ON FUNCTION public.structure_blockers(uuid) IS
  'The people who must be resolved before this structure can be signed clear. Operator-only: carries names.';

-- ---------------------------------------------------------------------------
-- 5 · The board. One row per structure, ordered the way a team should be sent:
--     most unresolved people first, and the vulnerable counted separately.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.structure_board AS
  SELECT s.id,
         s.incident_id,
         s.key,
         s.name,
         s.address_text,
         s.neighbourhood,
         s.lat,
         s.lng,
         s.point_precision,
         s.point_source,
         s.scan_state,
         s.scan_signed_by,
         s.scan_signed_at,
         s.authority_status,
         count(sc.case_id)                                             AS people,
         count(*) FILTER (WHERE sc.resolution = 'unresolved'
                            AND pc.merged_into IS NULL)                AS open_people,
         count(*) FILTER (WHERE sc.resolution = 'recovered_alive')     AS recovered_alive,
         count(*) FILTER (WHERE sc.resolution = 'recovered_deceased')  AS recovered_deceased,
         count(*) FILTER (WHERE sc.resolution = 'not_at_structure')    AS not_at_structure,
         count(*) FILTER (WHERE sc.resolution = 'unresolved'
                            AND pc.merged_into IS NULL
                            AND pc.is_minor)                           AS open_minors,
         count(*) FILTER (WHERE sc.resolution = 'unresolved'
                            AND pc.merged_into IS NULL
                            AND pi.age_approx >= 65)                   AS open_elderly,
         -- Said in words, because "no point" and "a point 5 km wide" are not
         -- the same problem and must not be one greyed-out row.
         CASE
           WHEN s.lat IS NULL                    THEN 'place it by hand — no point at all'
           WHEN s.point_precision = 'building'   THEN 'ready to dispatch'
           WHEN s.point_precision = 'street'     THEN 'narrow the street to a door'
           ELSE 'search area only — pin the building before dispatch'
         END AS location_action
    FROM structure s
    LEFT JOIN structure_case sc ON sc.structure_id = s.id
    LEFT JOIN person_case   pc  ON pc.id = sc.case_id
    LEFT JOIN person_index  pi  ON pi.case_id = sc.case_id
   GROUP BY s.id;

COMMENT ON VIEW public.structure_board IS
  'One row per structure with its open head-count. Counts only; no names — those need structure_blockers or the detail route.';

-- ---------------------------------------------------------------------------
-- 6 · project_structure_point — the workaround from the field, made a rule.
--
-- During the Pereira load, approving a place did not put anything on the heat
-- map; the points were copied into case_location_override by hand. That work is
-- correct and it belongs in the schema, with three guards the manual copy did
-- not have:
--
--   · it REFUSES on an area/town-grade point. Projecting a municipality
--     centroid onto 48 people manufactures a hotspot on a square where nobody
--     is buried, and it looks exactly like real data afterwards.
--   · it never overwrites a location that already exists. A family's GPS fix
--     beats a building pin, always.
--   · it writes provenance: source 'operator', the structure's name in the
--     note, and one structure_event row.
--
-- Returns the number of cases that gained a point.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.project_structure_point(
  p_structure uuid, p_actor text, p_note text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  s        structure%ROWTYPE;
  v_acc    text;
  v_case   uuid;
  n        int := 0;
BEGIN
  SELECT * INTO s FROM structure WHERE id = p_structure;
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'structure % does not exist', p_structure
      USING ERRCODE = 'no_data_found';
  END IF;
  IF s.lat IS NULL THEN
    RAISE EXCEPTION 'structure % has no point to project', p_structure
      USING ERRCODE = 'check_violation',
            HINT = 'Pin the building first; nothing here invents a coordinate.';
  END IF;
  IF s.point_precision NOT IN ('building','street') THEN
    RAISE EXCEPTION
      'structure % has a %-grade point: too coarse to place people on the map',
      p_structure, s.point_precision
      USING ERRCODE = 'check_violation',
            HINT = 'An area or town centroid becomes a hotspot where nobody is buried. Pin the building.';
  END IF;

  -- NOTE for the caller, not for this function: app_rw runs with
  -- statement_timeout = 8s (0005), and this loop costs one
  -- refresh_person_index per person — ~48 of them for Torres del Limonar.
  -- statement_timeout is armed when a statement STARTS, so raising it from
  -- inside here would be too late; the route opens a transaction and issues
  -- SET LOCAL first. A timeout halfway through rolls everything back and looks,
  -- from the panel, like nothing happened at all.

  -- The grade of the structure's point is the ceiling for every case that
  -- inherits it. A street pin is a block-level claim about a person, never a
  -- building-level one.
  v_acc := CASE s.point_precision WHEN 'building' THEN 'building' ELSE 'block' END;

  FOR v_case IN
    SELECT sc.case_id
      FROM structure_case sc
      JOIN person_case pc ON pc.id = sc.case_id
      LEFT JOIN person_index pi ON pi.case_id = sc.case_id
     WHERE sc.structure_id = p_structure
       AND pc.merged_into IS NULL
       AND pc.anonymised_at IS NULL
       AND pi.last_seen IS NULL                       -- has no point of its own
       AND NOT EXISTS (SELECT 1 FROM case_location_override o
                        WHERE o.case_id = sc.case_id)  -- and nobody placed one
  LOOP
    INSERT INTO case_location_override (case_id, lat, lng, accuracy, note)
    VALUES (v_case, s.lat, s.lng, v_acc,
            'Estructura: ' || s.name || COALESCE(' — ' || p_note, ''))
    ON CONFLICT (case_id) DO NOTHING;
    PERFORM public.refresh_person_index(v_case);
    n := n + 1;
  END LOOP;

  INSERT INTO structure_event (structure_id, kind, to_value, actor, note)
  VALUES (p_structure, 'project_point',
          jsonb_build_object('cases', n, 'accuracy', v_acc,
                             'lat', s.lat, 'lng', s.lng),
          p_actor, p_note);

  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.project_structure_point(uuid, text, text) IS
  'Give the structure''s point to the people inside it who have none. Refuses coarse points, never overwrites an existing location, always leaves provenance.';

-- ---------------------------------------------------------------------------
-- 7 · Grants. The event log is evidence: append only.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON structure, structure_case TO app_rw';
  EXECUTE 'GRANT SELECT, INSERT ON structure_event TO app_rw';
  EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE structure_event_id_seq TO app_rw';
  EXECUTE 'REVOKE UPDATE, DELETE ON structure_event FROM app_rw';
  EXECUTE 'GRANT SELECT ON public.structure_board TO app_rw';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grants for 0018 skipped: %', SQLERRM;
END $$;

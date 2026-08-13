-- 0019_structure_merge_safe.sql — two holes in 0018, found by reviewing it
-- against the one thing it exists to guarantee: that the head-count of a
-- collapsed building is never wrong in the direction of "fewer people inside".
--
-- HOLE 1 — a merge quietly emptied the board.
--   0009 re-points reports, sightings, media and tokens at the surviving case
--   and leaves everything else hanging off the swallowed one. Structure links
--   are "everything else". 0018 then read structure_case directly and filtered
--   `pc.merged_into IS NULL` — so the moment an operator did exactly what we
--   built the queue for (confirm two records are one person), that person
--   dropped out of the building's count with nothing anywhere saying so.
--   Work that disappears is worse than work that fails.
--
--   The fix reads, it does not move: effective_case() follows the merge chain
--   and structure_person collapses the links onto the survivor. Nothing is
--   rewritten at merge time, so the undo ledger (0009) needs no knowledge of
--   structures at all.
--
-- HOLE 2 — "clear" could be true and then silently stop being true.
--   0018 refuses to SIGN a structure clear while someone inside is unresolved,
--   and stops there. Attach a new unresolved person to an already-signed
--   building — a family reporting late, an import arriving after the sweep —
--   and the structure stays 'clear' while a person waits inside it. Same
--   failure, other door.
--
--   The fix does NOT refuse the link; refusing new information about a
--   collapsed building would be absurd. It reopens the structure to 'partial'
--   and writes why into the event log, leaving the original signature intact.
--
-- Also fixed here: project_structure_point() referenced an alias that does not
-- exist in its own query (`o.case_id = sc.case_id`), so the function raised on
-- first call. It has no test that runs SQL, and static checks cannot see it.
--
-- Append-only: 0018 is already pushed and its checksum is recorded on any
-- machine that migrated. Nothing above 0018 is edited — every object here is
-- CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1 · Merges must not empty the board.
--
-- A merge re-points reports, sightings, media and tokens at the survivor
-- (0009) and leaves everything else attached to the merged case. Structure
-- links are "everything else": after an operator merges two records of the same
-- person, the link would still hang off the swallowed case, the board filters
-- merged rows out, and the head-count for the building quietly drops by one.
-- Work that disappears is worse than work that fails.
--
-- Rather than moving rows at merge time — which the undo ledger would then have
-- to reverse — the reading side follows the chain. Undo needs no knowledge of
-- this at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.effective_case(p_case uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  cur uuid := p_case;
  nxt uuid;
  i   int := 0;
BEGIN
  LOOP
    SELECT merged_into INTO nxt FROM person_case WHERE id = cur;
    -- Depth cap: a cycle in merged_into would be a bug elsewhere, and an
    -- unbounded loop here would take the panel down rather than expose it.
    EXIT WHEN nxt IS NULL OR i >= 10;
    cur := nxt;
    i := i + 1;
  END LOOP;
  RETURN cur;
END;
$$;

COMMENT ON FUNCTION public.effective_case(uuid) IS
  'The case that represents this one after any merges. Reading side of a merge: nothing is moved, so an undo needs no knowledge of it.';

-- One row per PERSON per structure, after merges are followed. A person counts
-- as resolved here if ANY of their links to this structure was resolved — an
-- operator who signed "recovered alive" against one of two merged records has
-- said it about the human being, not about a row.
CREATE OR REPLACE VIEW public.structure_person AS
  SELECT sc.structure_id,
         public.effective_case(sc.case_id) AS case_id,
         bool_and(sc.resolution = 'unresolved') AS is_open,
         (array_agg(sc.resolution ORDER BY sc.resolved_at DESC NULLS LAST)
            FILTER (WHERE sc.resolution <> 'unresolved'))[1] AS resolution,
         max(sc.resolved_by)   AS resolved_by,
         max(sc.resolved_at)   AS resolved_at,
         min(sc.link_source)   AS link_source,
         min(sc.confidence)    AS confidence,
         min(sc.note)          AS note
    FROM structure_case sc
   GROUP BY sc.structure_id, public.effective_case(sc.case_id);

COMMENT ON VIEW public.structure_person IS
  'Structure links collapsed onto the surviving case. Use this, never structure_case, to count or list people in a building.';


-- ---------------------------------------------------------------------------
-- 2 · The clear guard, counting people instead of rows
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.structure_no_silent_clear()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_open int;
BEGIN
  IF NEW.scan_state = 'clear'
     AND (TG_OP = 'INSERT' OR OLD.scan_state IS DISTINCT FROM 'clear') THEN
    -- structure_person, not structure_case: merges are followed, so a person
    -- neither blocks twice nor vanishes because their record was swallowed by
    -- a survivor. Erased people cannot block anything either.
    SELECT count(*) INTO n_open
      FROM structure_person sp
      JOIN person_case pc ON pc.id = sp.case_id
     WHERE sp.structure_id = NEW.id
       AND sp.is_open
       AND pc.anonymised_at IS NULL;
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
  'Refuses "clear" while anyone still unresolved is inside, counted per person and not per row.';


-- ---------------------------------------------------------------------------
-- 3 · A clear that stops being true
-- ---------------------------------------------------------------------------
-- A structure that was signed clear and then had a new unresolved person
-- attached to it must not stay clear. This is the same failure as a silent
-- clear, arriving through the other door: new information showing up after the
-- signature. It does NOT refuse the link — refusing new information about a
-- collapsed building would be absurd — it reopens the structure as 'partial'
-- and says so in the log, keeping the original signature intact.
CREATE OR REPLACE FUNCTION public.structure_reopen_on_open_person()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resolution = 'unresolved' THEN
    UPDATE structure SET scan_state = 'partial'
     WHERE id = NEW.structure_id AND scan_state = 'clear';
    IF FOUND THEN
      INSERT INTO structure_event (structure_id, kind, case_id, from_value, to_value, actor, note)
      VALUES (NEW.structure_id, 'scan', NEW.case_id, '"clear"', '"partial"', 'system',
              'Reopened: a person with no resolution was attached after the structure was signed clear.');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS structure_case_reopen ON structure_case;
CREATE TRIGGER structure_case_reopen
  AFTER INSERT OR UPDATE ON structure_case
  FOR EACH ROW EXECUTE FUNCTION public.structure_reopen_on_open_person();


-- ---------------------------------------------------------------------------
-- 4 · Readers: blockers, board, projection — all through structure_person
-- ---------------------------------------------------------------------------
-- What is standing in the way, so a screen can SAY it instead of greying a
-- button out. A disabled control that does not explain itself reads as broken.
CREATE OR REPLACE FUNCTION public.structure_blockers(p_structure uuid)
RETURNS TABLE (case_id uuid, reference_number text, name_raw text,
               age_approx int, status text, is_minor boolean)
LANGUAGE sql STABLE AS $$
  SELECT pc.id, pc.reference_number, pi.name_raw, pi.age_approx, pc.status, pc.is_minor
    FROM structure_person sp
    JOIN person_case pc ON pc.id = sp.case_id
    LEFT JOIN person_index pi ON pi.case_id = pc.id
   WHERE sp.structure_id = p_structure
     AND sp.is_open
     AND pc.anonymised_at IS NULL
   ORDER BY pc.is_minor DESC, COALESCE(pi.age_approx, 0) DESC, pi.name_raw;
$$;

COMMENT ON FUNCTION public.structure_blockers(uuid) IS
  'The people who must be resolved before this structure can be signed clear. Operator-only: carries names.';


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
         count(sp.case_id)                                             AS people,
         count(*) FILTER (WHERE sp.is_open)                            AS open_people,
         count(*) FILTER (WHERE sp.resolution = 'recovered_alive')     AS recovered_alive,
         count(*) FILTER (WHERE sp.resolution = 'recovered_deceased')  AS recovered_deceased,
         count(*) FILTER (WHERE sp.resolution = 'not_at_structure')    AS not_at_structure,
         count(*) FILTER (WHERE sp.is_open AND pc.is_minor)            AS open_minors,
         count(*) FILTER (WHERE sp.is_open AND pi.age_approx >= 65)    AS open_elderly,
         -- Said in words, because "no point" and "a point 5 km wide" are not
         -- the same problem and must not be one greyed-out row.
         CASE
           WHEN s.lat IS NULL                    THEN 'place it by hand — no point at all'
           WHEN s.point_precision = 'building'   THEN 'ready to dispatch'
           WHEN s.point_precision = 'street'     THEN 'narrow the street to a door'
           ELSE 'search area only — pin the building before dispatch'
         END AS location_action
    FROM structure s
    LEFT JOIN structure_person sp ON sp.structure_id = s.id
    LEFT JOIN person_case   pc  ON pc.id = sp.case_id
    LEFT JOIN person_index  pi  ON pi.case_id = sp.case_id
   GROUP BY s.id;

COMMENT ON VIEW public.structure_board IS
  'One row per structure with its open head-count. Counts only; no names — those need structure_blockers or the detail route.';


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
    SELECT sp.case_id
      FROM structure_person sp
      JOIN person_case pc ON pc.id = sp.case_id
      LEFT JOIN person_index pi ON pi.case_id = sp.case_id
     WHERE sp.structure_id = p_structure
       AND pc.merged_into IS NULL
       AND pc.anonymised_at IS NULL
       AND pi.last_seen IS NULL                       -- has no point of its own
       AND NOT EXISTS (SELECT 1 FROM case_location_override o
                        WHERE o.case_id = sp.case_id)  -- and nobody placed one
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
-- Grants. structure_person is the only way the application is allowed to count
-- people in a building, so it has to be readable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'GRANT SELECT ON public.structure_person TO app_rw';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grants for 0019 skipped: %', SQLERRM;
END $$;

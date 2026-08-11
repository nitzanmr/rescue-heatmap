-- 0011_location_provenance.sql — a location is a point, a claim, and a source.
--
-- The incident that produced this migration: the intake form accepted a written
-- address, nothing ever turned it into coordinates, and the form still let the
-- family label that address "punto exacto". The report looked complete, the
-- database correctly stored no geography, and the person never appeared on the
-- heat map. No error was raised anywhere, by anything. A rescue tool that loses
-- a report quietly is worse than one that refuses it loudly.
--
-- Three things are fixed here, in ascending order of importance:
--
--   1. person_index records WHERE the point came from (location_source), so an
--      operator can tell a GPS fix from a street-level guess. Precision without
--      provenance is a number that invites more trust than it earned.
--
--   2. Cases with an address and no point become a visible queue
--      (public.unmapped_case) instead of a silent absence. This is the actual
--      fix: the work does not disappear, it moves to a human.
--
--   3. The point for a case is no longer avg(lat), avg(lng) over its reports.
--      Averaging a GPS fix against a neighbourhood-level guess lands the case
--      between them — in a spot no reporter ever named, and possibly in the
--      river. We take the point from the most precise report instead, latest
--      wins on a tie, and an operator override beats all of them.
--
-- Append-only: nothing already applied is edited. Idempotent.

ALTER TABLE person_index
  ADD COLUMN IF NOT EXISTS location_source text;

COMMENT ON COLUMN person_index.location_source IS
  'device_gps | map_pick | geocoded | landmark | operator | none — none means the case has address text only and is not on the map.';

-- ---------------------------------------------------------------------------
-- Operator-supplied location. Kept in its own table rather than written back
-- into a report payload: a report is what a citizen said, and rewriting it to
-- record what an operator later worked out destroys the only account we have of
-- what was originally reported.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_location_override (
  case_id    uuid PRIMARY KEY REFERENCES person_case(id) ON DELETE CASCADE,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  accuracy   text NOT NULL DEFAULT 'building'
             CHECK (accuracy IN ('exact','building','block','neighbourhood','unknown')),
  note       text,
  set_by     uuid,
  set_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- refresh_person_index — same contract, honest location.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_person_index(p_case uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  agg record;
  loc record;
BEGIN
  SELECT
    (SELECT incident_id FROM person_case WHERE id = p_case)                   AS incident_id,
    (array_agg(r.payload->>'full_name' ORDER BY r.submitted_at))[1]           AS name_raw,
    max((r.payload->>'age_approx')::int)                                      AS age_approx,
    (array_agg(NULLIF(r.payload->>'gender','') ORDER BY r.submitted_at))[1]   AS gender,
    (array_agg(NULLIF(r.payload->>'national_id_last4','')
        ORDER BY r.submitted_at) FILTER (WHERE r.payload->>'national_id_last4' <> ''))[1] AS id4,
    (array_agg(NULLIF(r.payload->>'reporter_phone','') ORDER BY r.submitted_at))[1] AS phone,
    array_remove(array_agg(DISTINCT r.reporter_phone_e164), NULL)             AS rphones,
    count(*)::int                                                            AS reporter_count,
    (array_agg(NULLIF(r.payload->>'building_name','') ORDER BY r.submitted_at DESC))[1] AS building_name,
    (array_agg(NULLIF(r.payload->>'floor','')     ORDER BY r.submitted_at DESC))[1] AS floor,
    (array_agg(NULLIF(r.payload->>'apartment','') ORDER BY r.submitted_at DESC))[1] AS apartment,
    max((r.payload->>'last_contact_at')::timestamptz)                         AS last_seen_at,
    string_agg(concat_ws(' ',
        r.payload->>'distinguishing_info',
        r.payload->>'last_seen_address',
        r.payload->>'building_name'), ' ')                                    AS narrative
  INTO agg
  FROM report r WHERE r.case_id = p_case;

  -- The point: best available, never a blend. Operator override first, then the
  -- most precise reported point, most recent breaking ties.
  SELECT * INTO loc FROM (
    SELECT o.lat, o.lng, o.accuracy, 'operator'::text AS source, 4 AS pri, o.set_at AS at
      FROM case_location_override o WHERE o.case_id = p_case
    UNION ALL
    SELECT (r.payload->>'last_seen_lat')::double precision,
           (r.payload->>'last_seen_lng')::double precision,
           COALESCE(NULLIF(r.payload->>'location_accuracy',''),'unknown'),
           COALESCE(NULLIF(r.payload->>'location_source',''),'none'),
           CASE COALESCE(NULLIF(r.payload->>'location_accuracy',''),'unknown')
             WHEN 'exact' THEN 3 WHEN 'building' THEN 2 WHEN 'block' THEN 1 ELSE 0 END,
           r.submitted_at
      FROM report r
     WHERE r.case_id = p_case
       AND r.payload->>'last_seen_lat' IS NOT NULL
       AND r.payload->>'last_seen_lng' IS NOT NULL
  ) pts
  ORDER BY pri DESC, at DESC
  LIMIT 1;

  INSERT INTO person_index AS pi (
    case_id, incident_id, name_raw, name_norm, name_tokens, age_approx, gender,
    national_id_last4, phone_e164, reporter_phones, reporter_count,
    building_name, floor, apartment, location_accuracy, location_source,
    last_seen, last_seen_at, narrative, fts, vec_state, refreshed_at)
  VALUES (
    p_case, agg.incident_id, agg.name_raw,
    public.name_key(COALESCE(agg.name_raw,'')),
    public.name_tokens(COALESCE(agg.name_raw,'')),
    agg.age_approx, agg.gender, agg.id4, agg.phone,
    COALESCE(agg.rphones,'{}'), COALESCE(agg.reporter_count,1),
    agg.building_name, agg.floor, agg.apartment,
    -- No point, no precision claim. This is the invariant the API enforces on
    -- intake, restated here because the database is the last line that holds.
    CASE WHEN loc.lat IS NULL THEN 'unknown' ELSE COALESCE(loc.accuracy,'unknown') END,
    CASE WHEN loc.lat IS NULL THEN 'none'    ELSE COALESCE(loc.source,'map_pick') END,
    CASE WHEN loc.lat IS NOT NULL AND loc.lng IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(loc.lng, loc.lat),4326)::geography END,
    agg.last_seen_at, agg.narrative,
    to_tsvector('spanish', concat_ws(' ', agg.name_raw, agg.narrative)),
    'pending', now())
  ON CONFLICT (case_id) DO UPDATE SET
    incident_id       = EXCLUDED.incident_id,
    name_raw          = EXCLUDED.name_raw,
    name_norm         = EXCLUDED.name_norm,
    name_tokens       = EXCLUDED.name_tokens,
    age_approx        = EXCLUDED.age_approx,
    gender            = EXCLUDED.gender,
    national_id_last4 = EXCLUDED.national_id_last4,
    phone_e164        = EXCLUDED.phone_e164,
    reporter_phones   = EXCLUDED.reporter_phones,
    reporter_count    = EXCLUDED.reporter_count,
    building_name     = EXCLUDED.building_name,
    floor             = EXCLUDED.floor,
    apartment         = EXCLUDED.apartment,
    location_accuracy = EXCLUDED.location_accuracy,
    location_source   = EXCLUDED.location_source,
    last_seen         = EXCLUDED.last_seen,
    last_seen_at      = EXCLUDED.last_seen_at,
    narrative         = EXCLUDED.narrative,
    fts               = EXCLUDED.fts,
    vec_state         = CASE WHEN pi.narrative IS DISTINCT FROM EXCLUDED.narrative
                             THEN 'pending' ELSE pi.vec_state END,
    refreshed_at      = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- The queue. Every case that told us a place in words and has no point.
-- Operator-only; it carries the free-text address, which is personal data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.unmapped_case AS
SELECT pc.id                AS case_id,
       pc.incident_id,
       pc.reference_number,
       pc.status,
       pi.name_raw,
       pi.building_name,
       pi.reporter_count,
       (array_agg(NULLIF(r.payload->>'last_seen_address','')
          ORDER BY r.submitted_at DESC))[1] AS address_text,
       min(r.submitted_at)   AS first_reported_at
  FROM person_case pc
  JOIN person_index pi ON pi.case_id = pc.id
  JOIN report r        ON r.case_id  = pc.id
 WHERE pi.last_seen IS NULL
   AND pc.merged_into IS NULL
   AND pc.anonymised_at IS NULL
 GROUP BY pc.id, pc.incident_id, pc.reference_number, pc.status,
          pi.name_raw, pi.building_name, pi.reporter_count
HAVING (array_agg(NULLIF(r.payload->>'last_seen_address','')))[1] IS NOT NULL;

DO $$
BEGIN
  EXECUTE 'GRANT SELECT ON public.unmapped_case TO app_rw';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_location_override TO app_rw';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grants for 0011 skipped: %', SQLERRM;
END $$;

-- Rebuild every existing case once so location_source and the improved point
-- selection apply to data captured before this migration.
DO $$
DECLARE c uuid;
BEGIN
  FOR c IN SELECT id FROM person_case WHERE anonymised_at IS NULL LOOP
    PERFORM public.refresh_person_index(c);
  END LOOP;
END $$;

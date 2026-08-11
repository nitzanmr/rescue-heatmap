-- 0007_correlation_types.sql
-- ---------------------------------------------------------------------------
-- Fix: correlate_case() failed at runtime with
--   "structure of query does not match function result type"
-- because extract(epoch FROM interval) returns numeric (PG 14+), while the
-- function declares hours_apart as double precision. Dividing by the numeric
-- literal 3600.0 keeps it numeric, so the mismatch survived into the RETURN.
--
-- Why it was invisible: the drill only exercises intake and readiness. The
-- correlate job runs in the worker, so the failure landed in job.last_error
-- and the drill still printed "drill passed". The dedup engine — the one thing
-- this system does that nothing else does — was dead in every environment.
--
-- Migrations are append-only, so 0003 is left untouched and the function is
-- replaced here. The only change from 0003 is the ::double precision cast on
-- hours_apart.
-- ---------------------------------------------------------------------------
SET LOCAL search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.correlate_case(p_case uuid, p_limit int DEFAULT 50)
RETURNS TABLE (
  case_id      uuid,
  score        double precision,
  name_sim     real,
  lex_rank     real,
  metres       double precision,
  sem_sim      real,
  phone_match  boolean,
  id4_match    boolean,
  age_delta    int,
  hours_apart  double precision,
  signals      jsonb
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c correlation_config%ROWTYPE;
  s person_index%ROWTYPE;
BEGIN
  SELECT * INTO c FROM correlation_config WHERE id = 1;
  SELECT * INTO s FROM person_index WHERE person_index.case_id = p_case;
  IF s.case_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT pi.*
    FROM person_index pi
    JOIN person_case pc ON pc.id = pi.case_id
    WHERE pi.case_id <> p_case
      AND pi.incident_id IS NOT DISTINCT FROM s.incident_id
      AND pc.merged_into IS NULL
      AND pc.anonymised_at IS NULL
      AND (
            (s.last_seen IS NOT NULL AND pi.last_seen IS NOT NULL
              AND ST_DWithin(pi.last_seen, s.last_seen, c.radius_m))
         OR (s.name_norm IS NOT NULL AND pi.name_norm % s.name_norm)
         OR (s.phone_e164 IS NOT NULL AND pi.phone_e164 = s.phone_e164)
         OR (s.national_id_last4 IS NOT NULL
              AND pi.national_id_last4 = s.national_id_last4)
         OR (s.reporter_phones <> '{}' AND pi.reporter_phones && s.reporter_phones)
      )
    LIMIT 2000                     -- hard ceiling: a dense block never stalls intake
  ),
  scored AS (
    SELECT
      k.case_id,
      GREATEST(similarity(k.name_norm, s.name_norm),
               public.name_overlap(k.name_tokens, s.name_tokens))::real       AS name_sim,
      COALESCE(ts_rank_cd(k.fts, plainto_tsquery('spanish',
               COALESCE(s.name_raw,'') || ' ' || COALESCE(s.narrative,''))), 0)::real AS lex_rank,
      CASE WHEN k.last_seen IS NOT NULL AND s.last_seen IS NOT NULL
           THEN ST_Distance(k.last_seen, s.last_seen) END                     AS metres,
      CASE WHEN k.narrative_vec IS NOT NULL AND s.narrative_vec IS NOT NULL
           THEN (1 - (k.narrative_vec <=> s.narrative_vec))::real END         AS sem_sim,
      (k.phone_e164 IS NOT NULL AND k.phone_e164 = s.phone_e164)              AS phone_match,
      (k.national_id_last4 IS NOT NULL
        AND k.national_id_last4 = s.national_id_last4)                        AS id4_match,
      CASE WHEN k.age_approx IS NOT NULL AND s.age_approx IS NOT NULL
           THEN abs(k.age_approx - s.age_approx) END                          AS age_delta,
      CASE WHEN k.last_seen_at IS NOT NULL AND s.last_seen_at IS NOT NULL
           THEN (abs(extract(epoch FROM (k.last_seen_at - s.last_seen_at))) / 3600.0)::double precision END AS hours_apart,
      (k.reporter_phones && s.reporter_phones)                                AS reporter_overlap,
      (k.building_name IS NOT NULL
        AND public.name_norm(k.building_name) = public.name_norm(s.building_name)) AS same_building,
      (k.gender IS NOT NULL AND s.gender IS NOT NULL
        AND k.gender <> 'unknown' AND s.gender <> 'unknown'
        AND k.gender <> s.gender)                                             AS gender_conflict
    FROM candidates k
  )
  SELECT
    x.case_id,
    (   c.w_name     * x.name_sim
      + c.w_geo      * CASE WHEN x.metres IS NULL THEN 0
                            ELSE exp(-x.metres / 150.0) END          -- distance decay
      + c.w_phone    * (x.phone_match)::int
      + c.w_id4      * (x.id4_match)::int
      + c.w_age      * CASE WHEN x.age_delta IS NULL THEN 0
                            WHEN x.age_delta <= 3 THEN 1
                            WHEN x.age_delta <= 8 THEN 0.4 ELSE 0 END
      + c.w_time     * CASE WHEN x.hours_apart IS NULL THEN 0
                            WHEN x.hours_apart <= 6 THEN 1
                            WHEN x.hours_apart <= 48 THEN 0.5 ELSE 0 END
      + c.w_semantic * COALESCE(x.sem_sim, 0)
      + 0.05         * (x.same_building)::int
      - 0.25         * (x.gender_conflict)::int      -- contradiction is evidence too
      - 0.10         * (x.reporter_overlap AND NOT x.phone_match)::int
    )::double precision                                              AS score,
    x.name_sim, x.lex_rank, x.metres, x.sem_sim,
    x.phone_match, x.id4_match, x.age_delta, x.hours_apart,
    jsonb_strip_nulls(jsonb_build_object(
      'name_sim',        round(x.name_sim::numeric, 3),
      'lex_rank',        round(x.lex_rank::numeric, 4),
      'metres',          round(x.metres::numeric, 1),
      'sem_sim',         round(x.sem_sim::numeric, 3),
      'phone_match',     x.phone_match,
      'id4_match',       x.id4_match,
      'age_delta',       x.age_delta,
      'hours_apart',     round(x.hours_apart::numeric, 1),
      'same_building',   NULLIF(x.same_building, false),
      'gender_conflict', NULLIF(x.gender_conflict, false),
      'reporter_overlap',NULLIF(x.reporter_overlap, false)
    ))                                                               AS signals
  FROM scored x
  WHERE x.name_sim >= c.name_trgm_floor
     OR x.phone_match OR x.id4_match
     OR COALESCE(x.sem_sim, 0) >= 0.85
  ORDER BY score DESC
  LIMIT p_limit;
END;
$$;

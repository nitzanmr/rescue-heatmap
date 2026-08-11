-- 0003_correlation.sql — the correlation layer.
-- Stages 1-3 of the dedup pipeline as ONE server-side query, plus the scoring
-- weights, the index refresh function and the public projection.
-- See docs/architecture.md §4. Idempotent.

-- ---------------------------------------------------------------------------
-- Tunable weights. In config, not in code — an operator must be able to loosen
-- the radius at 3 a.m. without a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS correlation_config (
  id                 int PRIMARY KEY DEFAULT 1,
  radius_m           int    NOT NULL DEFAULT 500,
  name_trgm_floor    real   NOT NULL DEFAULT 0.30,
  w_name             real   NOT NULL DEFAULT 0.40,
  w_geo              real   NOT NULL DEFAULT 0.20,
  w_phone            real   NOT NULL DEFAULT 0.15,
  w_id4              real   NOT NULL DEFAULT 0.10,
  w_age              real   NOT NULL DEFAULT 0.05,
  w_time             real   NOT NULL DEFAULT 0.05,
  w_semantic         real   NOT NULL DEFAULT 0.05,
  auto_suggest_floor real   NOT NULL DEFAULT 0.55,   -- below this we do not even queue
  review_ceiling     real   NOT NULL DEFAULT 0.92,   -- above this it is top of the queue
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT correlation_config_singleton CHECK (id = 1)
);
INSERT INTO correlation_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Name normalisation for Spanish. Two given names + two surnames, arbitrary
-- order, accents optional. Tokens are sorted so "Maria Jose" = "Jose Maria".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.name_tokens(txt text)
RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ARRAY(
    SELECT t FROM unnest(
      string_to_array(
        regexp_replace(public.name_norm(txt), '[^a-z ]', ' ', 'g'), ' ')) AS t
    WHERE length(t) > 1 AND t NOT IN ('de','del','la','las','los','el','y','da','dos')
    ORDER BY t
  );
$$;

CREATE OR REPLACE FUNCTION public.name_key(txt text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT array_to_string(public.name_tokens(txt), ' ');
$$;

-- Token-set containment: how much of the shorter name is inside the longer one.
-- Handles the very common "she gave one surname, he gave both".
CREATE OR REPLACE FUNCTION public.name_overlap(a text[], b text[])
RETURNS real
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN a IS NULL OR b IS NULL OR array_length(a,1) IS NULL OR array_length(b,1) IS NULL
      THEN 0::real
    ELSE (
      SELECT count(*)::real
      FROM unnest(a) x WHERE x = ANY(b)
    ) / LEAST(array_length(a,1), array_length(b,1))::real
  END;
$$;

-- ---------------------------------------------------------------------------
-- correlate_case(case_id) — THE query. Stage 1 (blocking) + stage 2 (lexical)
-- + stage 3 (semantic) + stage 4 (structured scoring), one round trip.
--
-- Blocking is deliberately OR-ed: a report with no coordinates must still be
-- reachable by name, and a report with a mangled name must still be reachable
-- by phone or by geography. Every branch is index-backed:
--   ST_DWithin  -> GiST      name_key %  -> GIN trgm
--   phone       -> btree     id4         -> btree
-- ---------------------------------------------------------------------------
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
           THEN abs(extract(epoch FROM (k.last_seen_at - s.last_seen_at))) / 3600.0 END AS hours_apart,
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

-- Persist the shortlist into the operator queue. Never merges. Only proposes.
CREATE OR REPLACE FUNCTION public.enqueue_correlations(p_case uuid)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  c correlation_config%ROWTYPE;
  n int := 0;
BEGIN
  SELECT * INTO c FROM correlation_config WHERE id = 1;

  INSERT INTO dedup_candidate (incident_id, a_case, b_case, score, signals, state)
  SELECT (SELECT incident_id FROM person_case WHERE id = p_case),
         LEAST(p_case, r.case_id), GREATEST(p_case, r.case_id),
         r.score, r.signals, 'pending'
  FROM public.correlate_case(p_case, 25) r
  WHERE r.score >= c.auto_suggest_floor
  ON CONFLICT (a_case, b_case) DO UPDATE
    SET score   = EXCLUDED.score,
        signals = EXCLUDED.signals
    WHERE dedup_candidate.state = 'pending';

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Index refresh: rebuild one case's correlation surface from its reports.
-- Called by the worker after every intake and every accepted revision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_person_index(p_case uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  agg record;
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
    (array_agg(NULLIF(r.payload->>'location_accuracy','') ORDER BY r.submitted_at DESC))[1] AS accuracy,
    max((r.payload->>'last_contact_at')::timestamptz)                         AS last_seen_at,
    string_agg(concat_ws(' ',
        r.payload->>'distinguishing_info',
        r.payload->>'last_seen_address',
        r.payload->>'building_name'), ' ')                                    AS narrative,
    avg((r.payload->>'last_seen_lat')::double precision)                      AS lat,
    avg((r.payload->>'last_seen_lng')::double precision)                      AS lng
  INTO agg
  FROM report r WHERE r.case_id = p_case;

  INSERT INTO person_index AS pi (
    case_id, incident_id, name_raw, name_norm, name_tokens, age_approx, gender,
    national_id_last4, phone_e164, reporter_phones, reporter_count,
    building_name, floor, apartment, location_accuracy,
    last_seen, last_seen_at, narrative, fts, vec_state, refreshed_at)
  VALUES (
    p_case, agg.incident_id, agg.name_raw,
    public.name_key(COALESCE(agg.name_raw,'')),
    public.name_tokens(COALESCE(agg.name_raw,'')),
    agg.age_approx, agg.gender, agg.id4, agg.phone,
    COALESCE(agg.rphones,'{}'), COALESCE(agg.reporter_count,1),
    agg.building_name, agg.floor, agg.apartment, agg.accuracy,
    CASE WHEN agg.lat IS NOT NULL AND agg.lng IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(agg.lng, agg.lat),4326)::geography END,
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
-- Public projection. The ONLY thing /buscar is allowed to read.
-- Enforced here as well as in the API — defence in depth. No phone, no id4,
-- no floor/apartment, no exact point, no medical, no narrative.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public_case_view AS
SELECT
  pc.id                       AS case_id,
  pc.reference_number,
  pc.status,
  pc.incident_id,
  pi.name_raw                 AS name,
  pi.age_approx,
  pi.gender,
  -- coarse location only: ~1 km grid, never the reported point
  round(ST_Y(pi.last_seen::geometry)::numeric, 2) AS lat_coarse,
  round(ST_X(pi.last_seen::geometry)::numeric, 2) AS lng_coarse,
  pi.reporter_count,
  pc.status_updated_at,
  pc.created_at,
  pc.is_minor,
  pc.consent_photo_public
FROM person_case pc
JOIN person_index pi ON pi.case_id = pc.id
JOIN incident i      ON i.id = pc.incident_id
WHERE pc.public_listed
  AND pc.merged_into IS NULL
  AND pc.anonymised_at IS NULL
  AND pc.status <> 'withdrawn'
  AND (i.public_expires_at IS NULL OR i.public_expires_at > now());

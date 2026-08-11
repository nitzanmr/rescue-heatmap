-- 0010_operating_point.sql
-- ---------------------------------------------------------------------------
-- Four corrections to the correlation engine, all of them consequences of the
-- first real precision/recall sweep. Append-only: 0003 and 0007 are untouched.
--
-- 1. NON-DETERMINISTIC SHORTLIST.
--    correlate_case() ended in `ORDER BY score DESC LIMIT p_limit` with no tie
--    break. Two candidates with an identical score straddling the limit swap
--    places between calls, so the same case produced a different shortlist on
--    a re-run. That is what made the correlation test flap by exactly one pair
--    with a different uuid each time. A shortlist an operator cannot reproduce
--    is not evidence. Fixed with a secondary key on case_id.
--
-- 2. THE MEASUREMENT USED A WIDER SHORTLIST THAN PRODUCTION.
--    The test called correlate_case(case, 50); the worker's
--    enqueue_correlations() and the panel both called it with 25. We were
--    reporting recall for an engine more generous than the one that would run
--    in the field, and the gap only bites where duplicates actually cluster —
--    a crowded building. The limit is now ONE number, correlation_config
--    .candidate_limit, and p_limit defaults to NULL meaning "ask the config".
--    Callers stop hard-coding it.
--
-- 3. ONE FLOOR WAS FORCING A BAD TRADE.
--    On the swept curve, 0.525 gives precision 0.976 / recall 0.804 while
--    0.500 gives 0.934 / 0.833: four points of precision for three of recall
--    across a 0.025 step. That is a cliff, not a plateau, and an operating
--    point that sits on a cliff moves the day the data changes. So the single
--    floor becomes two bands:
--      score >= auto_suggest_floor (0.525) -> 'pending'  : the operator queue.
--      score >= lead_floor         (0.45)  -> 'lead'     : NOT queued. Shown
--                                                          only when someone
--                                                          opens that case.
--    Effective recall rises without pouring noise into the review queue. The
--    queue floor stays the only hard number, and 'lead' still merges nothing:
--    a lead has to be promoted by a human before it is even a suggestion.
--
-- 4. DUPLICATE-VS-DUPLICATE RECALL IS 0.41 AND NO THRESHOLD FIXES IT.
--    name_sim is max(trigram, token overlap). When BOTH sides are misspelled —
--    the pair a real event produces most of, two strangers each re-telling the
--    same person — both measures collapse together. Spanish transliteration
--    noise (Jhon/John, Gonzales/Gonzalez, Yeison/Jeison) is phonetically
--    invisible, so a double-metaphone comparison is added as a third measure.
--    It is OFF by default (phonetic_enabled = false) and capped below an exact
--    match, so it can never outrank real orthographic agreement. Turn it on,
--    re-run the sweep, and compare — an ablation, not a belief.
-- ---------------------------------------------------------------------------
SET LOCAL search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- fuzzystrmatch is not universally installed and, like every other extension
-- here, we do not get to choose its schema. If it is unavailable the migration
-- must still apply: the feature simply cannot be switched on. Recorded, not
-- guessed at runtime.
-- ---------------------------------------------------------------------------
DO $mig$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'fuzzystrmatch unavailable (%): phonetic name matching stays off', SQLERRM;
  END;
END
$mig$;

ALTER TABLE correlation_config
  ADD COLUMN IF NOT EXISTS candidate_limit  int     NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS lead_floor       real    NOT NULL DEFAULT 0.45,
  ADD COLUMN IF NOT EXISTS phonetic_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS w_phonetic_cap   real    NOT NULL DEFAULT 0.92;

-- A lead must never sit above the queue floor, and the shortlist must be big
-- enough that the limit is not itself the threshold.
ALTER TABLE correlation_config
  DROP CONSTRAINT IF EXISTS correlation_config_bands;
ALTER TABLE correlation_config
  ADD CONSTRAINT correlation_config_bands
  CHECK (lead_floor <= auto_suggest_floor
         AND auto_suggest_floor <= review_ceiling
         AND candidate_limit BETWEEN 5 AND 500);

-- The operating point, chosen by reading the curve rather than by preference.
UPDATE correlation_config
   SET auto_suggest_floor = 0.525,
       lead_floor         = 0.45,
       updated_at         = now()
 WHERE id = 1 AND auto_suggest_floor = 0.55;

-- ---------------------------------------------------------------------------
-- Phonetic keys. dmetaphone is tuned for English but its failure mode on
-- Spanish is the useful one here: it collapses exactly the h/j/y/g/z/s
-- confusions that Latin American transliteration produces. Tokens shorter than
-- three letters are dropped — two-letter codes collide with everything.
-- Returns 0 rather than raising when the extension is absent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phonetic_tokens(toks text[])
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE out text[];
BEGIN
  IF toks IS NULL THEN RETURN NULL; END IF;
  BEGIN
    SELECT array_agg(DISTINCT k ORDER BY k) INTO out
      FROM (SELECT dmetaphone(t) AS k FROM unnest(toks) t WHERE length(t) >= 3) q
     WHERE k IS NOT NULL AND k <> '';
  EXCEPTION WHEN undefined_function THEN
    RETURN NULL;                      -- fuzzystrmatch not installed
  END;
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION public.phonetic_overlap(a text[], b text[])
RETURNS real
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.name_overlap(public.phonetic_tokens(a), public.phonetic_tokens(b));
$$;

-- ---------------------------------------------------------------------------
-- correlate_case — identical scoring to 0007 except:
--   * p_limit defaults to NULL -> correlation_config.candidate_limit
--   * name_sim may include the capped phonetic measure, behind the flag
--   * ORDER BY score DESC, case_id  (deterministic)
--   * signals carry name_phon and the limit actually used, so a shortlist can
--     be explained after the fact
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correlate_case(p_case uuid, p_limit int DEFAULT NULL)
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
  c       correlation_config%ROWTYPE;
  s       person_index%ROWTYPE;
  v_limit int;
BEGIN
  SELECT * INTO c FROM correlation_config WHERE id = 1;
  SELECT * INTO s FROM person_index WHERE person_index.case_id = p_case;
  IF s.case_id IS NULL THEN RETURN; END IF;
  v_limit := GREATEST(COALESCE(p_limit, c.candidate_limit), 1);

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
               public.name_overlap(k.name_tokens, s.name_tokens))::real       AS name_orth,
      CASE WHEN c.phonetic_enabled
           THEN COALESCE(public.phonetic_overlap(k.name_tokens, s.name_tokens), 0)
           END::real                                                          AS name_phon,
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
  ),
  merged AS (
    SELECT x.*,
           -- Phonetic agreement is evidence, never proof: capped strictly below
           -- an exact orthographic match so it can only rescue a pair that
           -- spelling already lost, not overturn one spelling settled.
           GREATEST(x.name_orth,
                    COALESCE(x.name_phon, 0) * c.w_phonetic_cap)::real AS name_sim
    FROM scored x
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
      'name_orth',       round(x.name_orth::numeric, 3),
      'name_phon',       round(x.name_phon::numeric, 3),
      'lex_rank',        round(x.lex_rank::numeric, 4),
      'metres',          round(x.metres::numeric, 1),
      'sem_sim',         round(x.sem_sim::numeric, 3),
      'phone_match',     x.phone_match,
      'id4_match',       x.id4_match,
      'age_delta',       x.age_delta,
      'hours_apart',     round(x.hours_apart::numeric, 1),
      'same_building',   NULLIF(x.same_building, false),
      'gender_conflict', NULLIF(x.gender_conflict, false),
      'reporter_overlap',NULLIF(x.reporter_overlap, false),
      'shortlist_limit', v_limit
    ))                                                               AS signals
  FROM merged x
  WHERE x.name_sim >= c.name_trgm_floor
     OR x.phone_match OR x.id4_match
     OR COALESCE(x.sem_sim, 0) >= 0.85
  ORDER BY score DESC, x.case_id          -- deterministic: a tie must not reshuffle
  LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- enqueue_correlations — two bands. Still proposes, still never merges.
-- A 'lead' is deliberately NOT in the operator queue: /v1/panel/dedup filters
-- on state='pending' by default, so leads surface only on the case screen.
-- ---------------------------------------------------------------------------
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
         r.score, r.signals,
         CASE WHEN r.score >= c.auto_suggest_floor THEN 'pending' ELSE 'lead' END
  FROM public.correlate_case(p_case) r          -- limit comes from config
  WHERE r.score >= c.lead_floor
  ON CONFLICT (a_case, b_case) DO UPDATE
    SET score   = EXCLUDED.score,
        signals = EXCLUDED.signals,
        -- a lead that has since crossed the queue floor is promoted; a pair a
        -- human already decided on is never touched again.
        state   = CASE WHEN dedup_candidate.state IN ('pending','lead')
                       THEN EXCLUDED.state ELSE dedup_candidate.state END
    WHERE dedup_candidate.state IN ('pending','lead');

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Leads are read per case, not scanned as a queue.
CREATE INDEX IF NOT EXISTS dedup_lead_by_case
  ON dedup_candidate (a_case, state) WHERE state = 'lead';
CREATE INDEX IF NOT EXISTS dedup_lead_by_case_b
  ON dedup_candidate (b_case, state) WHERE state = 'lead';

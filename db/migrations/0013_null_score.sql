-- 0013_null_score.sql — a pair that cannot be scored must not be silently dropped.
--
-- WHAT THIS FIXES, AND HOW IT WAS FOUND
-- Found by running the engine against a live PostgreSQL for the first time
-- (0001..0012 + seed 500 + the full suite). Everything before this was read from
-- the source and reasoned about. Reading the source did not find it; running it
-- found it in one pass.
--
-- ---------------------------------------------------------------------------
-- BUG 1 · NULL score. Present since 0003, carried through 0007, 0010 and 0012.
--
-- Three pair predicates were written as "mine is not null AND mine = theirs":
--
--     (k.phone_e164 IS NOT NULL AND k.phone_e164 = s.phone_e164)   AS phone_match
--     (k.national_id_last4 IS NOT NULL
--       AND k.national_id_last4 = s.national_id_last4)             AS id4_match
--     (k.building_name IS NOT NULL
--       AND name_norm(k.building_name) = name_norm(s.building_name)) AS same_building
--
-- If MY value is present and THEIRS is null, the comparison is NULL, and
-- `TRUE AND NULL` is NULL, not false. That NULL then enters the score as
-- `c.w_id4 * (NULL)::int`, and in SQL one NULL term nullifies the whole sum.
-- `reporter_phones && reporter_phones` does the same thing when either array is
-- null; `surname_agree`/`given_conflict` do it when a name is null.
--
-- The consequences are not cosmetic, and they all point the same way — LOST
-- DUPLICATES, which is the failure mode that leaves two teams searching for one
-- person and one person unsearched for:
--
--   1. `enqueue_correlations` filters `WHERE r.score >= c.lead_floor`. NULL is
--      not >= anything, so the pair is NEVER PROPOSED. No operator ever sees it.
--      It does not appear as a rejected pair, or a lead, or a low score. It does
--      not appear.
--   2. `ORDER BY score DESC` in PostgreSQL means NULLS FIRST. The shortlist is
--      `LIMIT candidate_limit` (50), so unscorable rows were sorted to the TOP
--      of every shortlist and evicted real candidates from it. On the 500-case
--      seed: 12,599 distinct pairs came back with a null score, 13,201 of them
--      inside the top 25 of a shortlist, and 2,126 pairs were null in BOTH
--      directions — invisible from either side.
--   3. An operator reading a shortlist saw a blank score with real signals next
--      to it, which reads as "the tool has nothing to say", not as a defect.
--
-- Note what made this survivable for so long: the seed gave most cases both a
-- phone and a building, so the null case was rare in measurement and common in
-- the field, where a stranger reporting a body in the street has neither.
--
-- The fix is one word repeated: every pair predicate requires BOTH sides to be
-- present, and every boolean is coalesced to false. The final score is coalesced
-- as a backstop, and the ORDER BY is made NULLS LAST so that a future null can
-- only ever cost that pair its place at the bottom, never everyone else's place
-- at the top. Weights, floors and every scoring term are UNCHANGED: this
-- migration does not move the operating point, it stops discarding pairs.
--
-- ---------------------------------------------------------------------------
-- BUG 2 · a pending pair demoted to a lead by the other direction.
--
-- The scorer is not symmetric: 2,397 of 3,844 pairs seen from both sides scored
-- differently, and 52 landed in DIFFERENT BANDS depending on which case was
-- scored. `enqueue_correlations` upserted with `state = EXCLUDED.state`, so the
-- band was decided by whichever direction ran LAST. A pair worth 0.63 from one
-- side and 0.47 from the other ended up a `lead` — and `/v1/panel/dedup`
-- filters on `state = 'pending'`, so it left the operator queue entirely.
--
-- A pair is one claim about two people; the evidence for it is the strongest
-- view of it, not the most recent view of it. So the upsert now keeps the
-- GREATEST score, keeps the signals of whichever direction produced it, and
-- derives the band from that score. Promotion lead -> pending stays; demotion
-- pending -> lead by re-scoring is gone. A human decision is still never
-- overwritten.
--
-- The cost of this direction is bounded and known: at most those pairs sit in
-- the queue at their higher score, which an operator dismisses in one click. The
-- cost of the other direction is a child who stops being searched for.
-- ---------------------------------------------------------------------------

SET LOCAL search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1 · correlate_case — 0012, with null-safe pair predicates. Nothing else.
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
         -- Same reporter still WIDENS the candidate set: a parent filing four
         -- children is the cluster an operator most needs to see laid out.
         -- It just no longer adds score.
         OR (s.reporter_phones <> '{}' AND pi.reporter_phones && s.reporter_phones)
      )
    LIMIT 2000
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
      -- BOTH sides present, then compare. "Mine is not null and mine = theirs"
      -- yields NULL when theirs is null, and one NULL term nullifies the score.
      COALESCE(k.phone_e164 IS NOT NULL AND s.phone_e164 IS NOT NULL
               AND k.phone_e164 = s.phone_e164, false)                        AS phone_match,
      COALESCE(k.national_id_last4 IS NOT NULL AND s.national_id_last4 IS NOT NULL
               AND k.national_id_last4 = s.national_id_last4, false)          AS id4_match,
      CASE WHEN k.age_approx IS NOT NULL AND s.age_approx IS NOT NULL
           THEN abs(k.age_approx - s.age_approx) END                          AS age_delta,
      CASE WHEN k.last_seen_at IS NOT NULL AND s.last_seen_at IS NOT NULL
           THEN (abs(extract(epoch FROM (k.last_seen_at - s.last_seen_at))) / 3600.0)::double precision END AS hours_apart,
      COALESCE(k.reporter_phones && s.reporter_phones, false)                 AS reporter_overlap,
      COALESCE(k.building_name IS NOT NULL AND s.building_name IS NOT NULL
               AND public.name_norm(k.building_name) = public.name_norm(s.building_name),
               false)                                                         AS same_building,
      COALESCE(k.gender IS NOT NULL AND s.gender IS NOT NULL
        AND k.gender <> 'unknown' AND s.gender <> 'unknown'
        AND k.gender <> s.gender, false)                                      AS gender_conflict,
      -- The sibling signature. Note what it does NOT depend on: gender. Two
      -- brothers produce no gender conflict, which is why the old scoring left
      -- them in the queue at 0.72.
      --
      -- Coalesced to FALSE, and the direction matters: an unknown is not a
      -- conflict. A missing name must not manufacture a 0.25 penalty against a
      -- pair that might be the same person.
      COALESCE(public.surname_agree(k.name_raw, s.name_raw)
        AND public.given_conflict(k.name_raw, s.name_raw, c.given_conflict_sim)
        -- An agreeing national id beats any name argument: same person, one of
        -- the two names is simply wrong.
        AND NOT COALESCE(k.national_id_last4 IS NOT NULL
                 AND s.national_id_last4 IS NOT NULL
                 AND k.national_id_last4 = s.national_id_last4, false),
        false)                                                                AS sibling_conflict
    FROM candidates k
  ),
  merged AS (
    SELECT x.*,
           GREATEST(COALESCE(x.name_orth, 0),
                    COALESCE(x.name_phon, 0) * c.w_phonetic_cap)::real AS name_sim
    FROM scored x
  )
  SELECT
    x.case_id,
    -- COALESCE on the whole sum is a backstop, not the fix: every term above is
    -- now non-null by construction. It is here so that a term added in a future
    -- migration can only ever score its own pair as zero, instead of deleting
    -- that pair from the operator's queue without a trace.
    COALESCE(
        c.w_name     * x.name_sim
      + c.w_geo      * CASE WHEN x.metres IS NULL THEN 0
                            ELSE exp(-x.metres / 150.0) END
      + c.w_phone    * (x.phone_match)::int
      + c.w_id4      * (x.id4_match)::int
      + c.w_age      * CASE WHEN x.age_delta IS NULL THEN 0
                            WHEN x.age_delta <= 3 THEN 1
                            WHEN x.age_delta <= 8 THEN 0.4 ELSE 0 END
      + c.w_time     * CASE WHEN x.hours_apart IS NULL THEN 0
                            WHEN x.hours_apart <= 6 THEN 1
                            WHEN x.hours_apart <= 48 THEN 0.5 ELSE 0 END
      + c.w_semantic * COALESCE(x.sem_sim, 0)
      + c.w_building         * (x.same_building)::int
      - c.w_gender_conflict  * (x.gender_conflict)::int
      -- Unconditional now. Two reports from the same phone are weak evidence of
      -- DIFFERENT people: someone re-telling their own report uses the `sumar`
      -- path, not a second form.
      - c.w_reporter_overlap * (x.reporter_overlap)::int
      - c.w_sibling_conflict * (x.sibling_conflict)::int
    , 0)::double precision                                             AS score,
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
      'sibling_conflict',NULLIF(x.sibling_conflict, false),
      'shortlist_limit', v_limit
    ))                                                               AS signals
  FROM merged x
  WHERE x.name_sim >= c.name_trgm_floor
     OR x.phone_match OR x.id4_match
     OR COALESCE(x.sem_sim, 0) >= 0.85
  -- NULLS LAST: DESC defaults to NULLS FIRST, which is how unscorable pairs came
  -- to occupy the top of every shortlist ahead of real candidates.
  ORDER BY score DESC NULLS LAST, x.case_id
  LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 · enqueue_correlations — the pair keeps its STRONGEST view, not its last.
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
    SET score   = GREATEST(dedup_candidate.score, EXCLUDED.score),
        -- The signals must explain the score that is stored, so they travel
        -- together: keep the incoming blob only when it is the stronger view.
        signals = CASE WHEN EXCLUDED.score > dedup_candidate.score
                       THEN EXCLUDED.signals ELSE dedup_candidate.signals END,
        -- Band follows the strongest score, so a lead is promoted and a pending
        -- pair is never demoted by the weaker direction of the same pair.
        -- A pair a human already decided on is never touched again.
        state   = CASE
                    WHEN dedup_candidate.state NOT IN ('pending','lead')
                      THEN dedup_candidate.state
                    WHEN GREATEST(dedup_candidate.score, EXCLUDED.score)
                         >= c.auto_suggest_floor THEN 'pending'
                    ELSE 'lead'
                  END
    WHERE dedup_candidate.state IN ('pending','lead');

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

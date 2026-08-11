-- 0012_dedup_semantics.sql — the two defects that bias the map where it hurts,
-- plus the one guard that does not depend on dedup working at all.
--
-- Why these three and not the other nine in docs/dedup-review.md: a heat map is
-- a RANKING. A uniform multiplicative error in cell weight changes no rescue
-- decision, so most scoring imperfections are affordable. What is not
-- affordable is an error CORRELATED WITH SEVERITY, and both defects fixed here
-- are exactly that:
--
--   F1 · The engine scored the REPORTER's phone as if it were the subject's.
--        person_index.phone_e164 was filled from report.payload->>'reporter_phone'
--        (0003 line 229, carried into 0011). Consequences, all in the same
--        direction:
--          * phone_match (w_phone = 0.15, third-heaviest signal) fired for ANY
--            two cases filed by the same person;
--          * the same-reporter correction, written as
--            -0.10 * (reporter_overlap AND NOT phone_match), was therefore
--            disabled precisely when it was needed — the intended penalty
--            became a +0.15 bonus;
--          * blocking widened on the same mistake.
--        A mother reporting three children is the common case, and it is the
--        case this inflated most.
--
--   F2 (the sibling half) · The name comparison could not tell a sibling from a
--        duplicate. name_tokens() sorts alphabetically, destroying Spanish
--        structure (given + given + apellido paterno + apellido materno), and
--        name_overlap() divides by the SHORTER array, so a given-name
--        disagreement is invisible while the shared surnames carry the overlap.
--        `Juan Perez Gomez` vs `Ana Perez Gomez`, same building, same reporter,
--        2 h apart scored 0.72 — only the gender penalty pulled it down, so two
--        BROTHERS stayed queued as one person.
--        Merging siblings is a negative bias that grows with how many people
--        from one household are missing: the cell that should weigh 3.0 weighs
--        1.73 and reports cases=1. That flattens exactly the peaks the map
--        exists to find. And on /buscar a false merge removes a child from the
--        search list entirely (both projections filter merged_into IS NULL) —
--        no statistical argument reaches that child.
--
--   Per-reporter cell cap · The largest source of NON-uniform inflation is one
--        family filing several reports on one address, and it does not need the
--        dedup engine to be fixed. Capping what a single reporter can contribute
--        to a single cell neutralises it whether or not the duplicates were ever
--        detected. Cheapest fix here, and the only one that holds when dedup
--        fails.
--
-- Not touched here, deliberately: weight redistribution for missing fields (F3),
-- cluster ids (F5), Spanish phonetic fold (F6), rarity weighting (F7). They
-- improve pairwise quality without moving the ranking, and they come after the
-- adversarial fixture (F4) so the next number means something.
--
-- Append-only. Idempotent. Nothing already applied is edited.

-- pg_trgm's similarity() is used inside a function body below, and like every
-- extension here we do not get to choose its schema. Same rule as 0001/0007/0010:
-- put the schema on the path, never qualify the object.
SET LOCAL search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1 · Config. Every number an operator might have to change at 3 a.m. lives in
--     a table, including the two magic literals that escaped into the function
--     body in 0003 (the building bonus and the gender penalty).
-- ---------------------------------------------------------------------------
ALTER TABLE correlation_config
  ADD COLUMN IF NOT EXISTS w_building          real NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS w_gender_conflict   real NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS w_reporter_overlap  real NOT NULL DEFAULT 0.10,
  -- Surnames agree, given names do not: the sibling signature.
  --
  -- Sized against the two shapes the worked example takes. Two brothers at one
  -- address, 2 h apart, scored 0.72 before any of this:
  --   * reported by the SAME person: -0.15 (the phone bonus that should never
  --     have existed) -0.10 (the same-reporter penalty, now unconditional)
  --     -0.25 = 0.22.
  --   * reported by TWO DIFFERENT neighbours — the case F1 alone does NOT fix,
  --     because there is no reporter overlap to penalise: 0.72 -0.15 -0.25
  --     = 0.32.
  -- Both land below lead_floor (0.45), so neither reaches the operator queue.
  --
  -- The known cost, stated rather than hidden: hypocorisms. "Pepe Gomez Rojas"
  -- and "Jose Gomez Rojas" are one man, and this rule reads them as two. That
  -- is a recall loss on a real pattern, accepted here because the opposite
  -- error removes a living child from the search list. It is why the penalty is
  -- a config value and not a literal, and why 'sibling_conflict' is published
  -- in the signals blob: an operator who opens the case sees the reason.
  ADD COLUMN IF NOT EXISTS w_sibling_conflict  real NOT NULL DEFAULT 0.25,
  -- Below this trigram similarity two given names are treated as DIFFERENT
  -- names rather than as one misspelt name. 0.34 keeps `mria`~`maria` (0.375,
  -- the one-character-typo variant the seed produces) out of the conflict rule
  -- while `juan`/`ana` (0.0) falls squarely inside it. Raising this makes the
  -- sibling guard more aggressive and starts costing real duplicates.
  ADD COLUMN IF NOT EXISTS given_conflict_sim  real NOT NULL DEFAULT 0.34;

-- The heat map has its own knob, in its own table: it is a different question
-- from "are these two reports the same person", and mixing the two invites a
-- change to one to be read as a change to the other.
CREATE TABLE IF NOT EXISTS heatmap_config (
  id                int PRIMARY KEY DEFAULT 1,
  -- Maximum corroboration multiplier ONE reporter may apply to ONE cell.
  -- 3.0 == sqrt(9): a single family stops adding after about nine reports on
  -- one address, and cannot manufacture a hotspot no matter how many they file.
  reporter_cell_cap real NOT NULL DEFAULT 3.0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT heatmap_config_singleton CHECK (id = 1),
  CONSTRAINT heatmap_config_cap_sane  CHECK (reporter_cell_cap BETWEEN 1.0 AND 10.0)
);
INSERT INTO heatmap_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  EXECUTE 'GRANT SELECT ON public.heatmap_config TO app_rw';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grant for heatmap_config skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 2 · Spanish name structure. name_tokens() sorts, on purpose, because token
--     ORDER is unreliable in the field ("Gomez Maria" happens). But POSITION is
--     the only thing that separates a given name from a surname, so the split
--     has to happen before the sort — hence a second family of functions rather
--     than a change to the first.
--
--     Convention (Naming customs of Hispanic America): the last two tokens are
--     the paternal and maternal surnames; everything before them is given. A
--     three-token name is read as one given + two surnames, which is the more
--     common shape; the ambiguity with two given + one surname is handled by
--     the conflict rule below being conservative, not by guessing here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.name_seq(txt text)
RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ARRAY(
    SELECT t FROM unnest(
      string_to_array(
        regexp_replace(public.name_norm(txt), '[^a-z ]', ' ', 'g'), ' ')) AS t
    WHERE length(t) > 1 AND t NOT IN ('de','del','la','las','los','el','y','da','dos')
  );
$$;

CREATE OR REPLACE FUNCTION public.surname_tokens(txt text)
RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH s AS (SELECT public.name_seq(txt) AS t)
  SELECT CASE
           WHEN COALESCE(array_length(t,1),0) >= 3 THEN t[array_length(t,1)-1:array_length(t,1)]
           WHEN COALESCE(array_length(t,1),0) = 2 THEN t[2:2]
           ELSE '{}'::text[]
         END
  FROM s;
$$;

CREATE OR REPLACE FUNCTION public.given_tokens(txt text)
RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH s AS (SELECT public.name_seq(txt) AS t)
  SELECT CASE
           WHEN COALESCE(array_length(t,1),0) >= 3 THEN t[1:array_length(t,1)-2]
           WHEN COALESCE(array_length(t,1),0) = 2 THEN t[1:1]
           WHEN COALESCE(array_length(t,1),0) = 1 THEN t[1:1]
           ELSE '{}'::text[]
         END
  FROM s;
$$;

-- Do these two names disagree on the GIVEN name? True only when both sides
-- carry a given name and NO pair of them is even fuzzily similar. A missing
-- given name is not a disagreement (F3's principle: absence is not evidence),
-- and a misspelling is not a disagreement either — that is what the similarity
-- floor is for.
CREATE OR REPLACE FUNCTION public.given_conflict(a text, b text, p_sim real)
RETURNS boolean
-- plpgsql with locals rather than one clever SQL expression: `unnest(variable)`
-- is unambiguous everywhere, and this function decides whether two children are
-- one child. It should be readable at 3 a.m. by whoever is on call.
-- STABLE, not IMMUTABLE: similarity() comes from an extension whose volatility
-- we do not control across versions, and nothing indexes this.
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  ga  text[];
  gb  text[];
  hit boolean;
BEGIN
  ga := public.given_tokens(COALESCE(a, ''));
  gb := public.given_tokens(COALESCE(b, ''));
  -- Absence is not disagreement (the same principle as F3): a name given
  -- without a given name tells us nothing about which child it is.
  IF COALESCE(array_length(ga, 1), 0) = 0 OR COALESCE(array_length(gb, 1), 0) = 0 THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM unnest(ga) x, unnest(gb) y
     WHERE x = y OR similarity(x, y) >= p_sim
  ) INTO hit;
  RETURN NOT hit;
END;
$$;

-- Do the surnames agree? At least one surname in common, both sides present.
-- One shared surname is enough: plenty of reports give a single apellido, and
-- "Perez" against "Perez Gomez" is agreement, not a partial match.
CREATE OR REPLACE FUNCTION public.surname_agree(a text, b text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  sa text[];
  sb text[];
BEGIN
  sa := public.surname_tokens(COALESCE(a, ''));
  sb := public.surname_tokens(COALESCE(b, ''));
  IF COALESCE(array_length(sa, 1), 0) = 0 OR COALESCE(array_length(sb, 1), 0) = 0 THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM unnest(sa) x WHERE x = ANY(sb));
END;
$$;

-- ---------------------------------------------------------------------------
-- 3 · The index. phone_e164 now holds a SUBJECT phone or nothing.
--
--     There is no subject phone field on the intake form today, so after this
--     migration the column is empty for every existing case and w_phone stops
--     contributing until such a field carries data. That is the correct state:
--     a signal with no source is worth less than nothing, because it fires on
--     something else. services/api/src/schema.ts adds the optional field
--     (`subject_phone`) in the same commit; a phone the family knows for the
--     missing person is highly discriminative in Colombia and worth asking for.
--
--     Everything else in this function is 0011 unchanged.
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
    -- THE FIX. Was payload->>'reporter_phone'. The reporter's number identifies
    -- the person who filled the form, never the person under the rubble.
    (array_agg(NULLIF(r.payload->>'subject_phone','')
        ORDER BY r.submitted_at) FILTER (WHERE NULLIF(r.payload->>'subject_phone','') IS NOT NULL))[1] AS phone,
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
-- 4 · correlate_case — 0010 with three changes and nothing else:
--       * the same-reporter penalty is UNCONDITIONAL (it was gated on
--         NOT phone_match, which F1 made always false for the same reporter);
--       * a sibling term: surnames agree AND given names disagree -> penalty;
--       * the building bonus and gender penalty read from config.
--     The signals blob carries the new terms so a shortlist stays explainable
--     after the fact — an operator must be able to see WHY a pair was demoted.
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
        AND k.gender <> s.gender)                                             AS gender_conflict,
      -- The sibling signature. Note what it does NOT depend on: gender. Two
      -- brothers produce no gender conflict, which is why the old scoring left
      -- them in the queue at 0.72.
      (public.surname_agree(k.name_raw, s.name_raw)
        AND public.given_conflict(k.name_raw, s.name_raw, c.given_conflict_sim)
        -- An agreeing national id beats any name argument: same person, one of
        -- the two names is simply wrong.
        AND NOT (k.national_id_last4 IS NOT NULL
                 AND k.national_id_last4 = s.national_id_last4))              AS sibling_conflict
    FROM candidates k
  ),
  merged AS (
    SELECT x.*,
           GREATEST(x.name_orth,
                    COALESCE(x.name_phon, 0) * c.w_phonetic_cap)::real AS name_sim
    FROM scored x
  )
  SELECT
    x.case_id,
    (   c.w_name     * x.name_sim
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
      'sibling_conflict',NULLIF(x.sibling_conflict, false),
      'shortlist_limit', v_limit
    ))                                                               AS signals
  FROM merged x
  WHERE x.name_sim >= c.name_trgm_floor
     OR x.phone_match OR x.id4_match
     OR COALESCE(x.sem_sim, 0) >= 0.85
  ORDER BY score DESC, x.case_id
  LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5 · heat_cells — one reporter, one cell, a bounded contribution.
--
-- The failure this closes needs no bug at all: a family that files six reports
-- on one address inflates that cell sixfold, and the inflation is concentrated
-- exactly where a household is connected and articulate rather than where it is
-- buried. 0008 compressed corroboration WITHIN a case (reporter_count); this
-- compresses it ACROSS cases from the same reporter, which is where the
-- undetected duplicates and the whole-family filings actually live.
--
-- Per reporter per cell: mean case weight x LEAST(sqrt(n), cap). Same idiom as
-- case_weight() for the same reason — the 2nd report is worth a lot, the 6th
-- almost nothing — and urgency stays linear, so a single trapped_alive report
-- from one caller still outweighs three "missing" from another.
--
-- `cases` is NOT capped: it is a count of distinct cases in the cell and an
-- operator reads it as one. Capping a displayed count would be lying about the
-- data to make the weight look consistent.
--
-- A report with no reporter phone forms its own group (keyed by case id) rather
-- than being lumped with every other anonymous report — the alternative would
-- cap unrelated strangers against each other, which is a far worse error.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.heat_cells(
  p_incident uuid, p_cell_m int DEFAULT 100, p_status text[] DEFAULT NULL)
RETURNS TABLE (lat double precision, lng double precision,
               weight double precision, cases int)
LANGUAGE sql STABLE AS $$
  WITH cfg AS (
    SELECT COALESCE((SELECT reporter_cell_cap FROM heatmap_config WHERE id = 1), 3.0) AS cap
  ), src AS (
    SELECT ST_SnapToGrid(ST_Transform(pi.last_seen::geometry, 3857), p_cell_m, p_cell_m) AS cell,
           COALESCE((SELECT min(x) FROM unnest(pi.reporter_phones) x), pi.case_id::text) AS reporter_key,
           public.case_weight(pi.location_accuracy, pc.status, pi.reporter_count) AS w
    FROM person_index pi
    JOIN person_case pc ON pc.id = pi.case_id
    WHERE pi.incident_id = p_incident
      AND pi.last_seen IS NOT NULL
      AND pc.merged_into IS NULL
      AND pc.anonymised_at IS NULL
      AND (p_status IS NULL OR pc.status = ANY(p_status))
  ), per_reporter AS (
    SELECT cell, reporter_key, sum(w) AS w_sum, count(*)::int AS n
    FROM src GROUP BY 1, 2
  ), capped AS (
    SELECT pr.cell,
           (pr.w_sum / pr.n) * LEAST(sqrt(pr.n), cfg.cap) AS w,
           pr.n
    FROM per_reporter pr CROSS JOIN cfg
  ), cells AS (
    SELECT cell, sum(w) AS w, sum(n)::int AS n FROM capped GROUP BY 1
  )
  SELECT ST_Y(ST_Transform(cell, 4326)), ST_X(ST_Transform(cell, 4326)), w, n
  FROM cells;
$$;

-- ---------------------------------------------------------------------------
-- 6 · Rebuild every index row so phone_e164 stops holding reporter numbers on
--     data captured before this migration, and re-score nothing: scores are
--     recomputed by the worker on the next refresh, and silently rewriting
--     operator-visible suggestions inside a migration is not something a
--     migration should do. Pairs already decided by a human are never touched.
--     Undecided pairs are re-queued for scoring so the new penalties apply.
-- ---------------------------------------------------------------------------
DO $$
DECLARE c uuid;
BEGIN
  FOR c IN SELECT id FROM person_case WHERE anonymised_at IS NULL LOOP
    PERFORM public.refresh_person_index(c);
  END LOOP;
END $$;

DO $$
BEGIN
  INSERT INTO job (kind, payload, dedupe_key)
  SELECT 'correlate', jsonb_build_object('case_id', pc.id), 'correlate:0012:' || pc.id::text
    FROM person_case pc
   WHERE pc.merged_into IS NULL AND pc.anonymised_at IS NULL
     AND EXISTS (SELECT 1 FROM dedup_candidate d
                  WHERE (d.a_case = pc.id OR d.b_case = pc.id)
                    AND d.state IN ('pending','lead'))
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 're-scoring enqueue skipped: %', SQLERRM;
END $$;

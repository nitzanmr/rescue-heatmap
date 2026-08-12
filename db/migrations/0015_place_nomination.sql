-- 0015_place_nomination.sql — a free-text place becomes a coordinate only when
-- a person says so, and only once per structure.
--
-- WHY
--   0014 brought in ~5,000 registry rows. Every one carries a line of Spanish a
--   relative typed. The classifier (place-resolution.ts) already decides how
--   precise that line is, but it decided it in memory: the verdict lived inside
--   report.payload JSON, where nobody can group by it, count it, or audit it.
--   So the two questions that matter could not be asked in SQL:
--
--     "how many imported rows could ever be a cell?"
--     "which single structure has the most people named against it?"
--
--   The second question is the whole point. In this data, 86 people sit on one
--   hotel in Pereira (spelled three ways). That is not a heat cell, it is a
--   collapsed building — and it was invisible because nobody counted it.
--
-- WHAT THIS MIGRATION REFUSES TO DO
--   It does not geocode, and it gives no imported row a coordinate. A
--   nomination is a QUESTION addressed to a person: "is 'Hotel Dibeni,
--   Pereira' a real structure, and if so, where exactly?" Until someone
--   answers with their name attached, `status` stays 'pending' and
--   `approved_place` shows nothing. Same rule as the dedup queue: the tool
--   proposes, a human decides, and the decision is signed.
--
--   It also nominates a PLACE, never a person. One decision covers every case
--   that named that structure, so a human hour buys 86 rows instead of one, and
--   a bad decision is revoked in one statement instead of 86.
--
-- Append-only, idempotent, nothing already applied is edited.

-- ---------------------------------------------------------------- the verdict

-- The classifier's answer, stored where it can be grouped and counted. Written
-- by the importer on load and by `place-clusters --backfill` for rows that
-- predate this migration. NULL means "not classified yet", which is different
-- from "no place" ('none') and must not be silently read as either.
ALTER TABLE external_case
  ADD COLUMN IF NOT EXISTS place_text        text,
  ADD COLUMN IF NOT EXISTS place_resolution  text,
  ADD COLUMN IF NOT EXISTS place_eligible    boolean;

ALTER TABLE external_case
  DROP CONSTRAINT IF EXISTS external_case_place_resolution_ck;
ALTER TABLE external_case
  ADD CONSTRAINT external_case_place_resolution_ck
  CHECK (place_resolution IS NULL OR place_resolution IN
         ('point', 'neighbourhood', 'municipality', 'narrative', 'none'));

COMMENT ON COLUMN external_case.place_resolution IS
  'How precise the free-text place is: point | neighbourhood | municipality | narrative | none. NULL = not yet classified.';
COMMENT ON COLUMN external_case.place_eligible IS
  'May a geocoder be asked about this line at all. Narrower than resolution=point: a landmark inside a sentence about travelling is a sighting on a route, not a place under rubble.';

-- Only eligible rows are ever scanned for nominations, so the index carries
-- only them.
CREATE INDEX IF NOT EXISTS external_case_place_eligible
  ON external_case (source, place_resolution)
  WHERE place_eligible;

-- ------------------------------------------------------------- the nomination

-- One row per structure a human is being asked about. `variants` holds the
-- spellings that were folded into it ("Hotel Dibeni", "Dibeni Hotel",
-- "hotel debani") so the reviewer can see exactly what they are approving and
-- reject the fold if it is wrong.
CREATE TABLE IF NOT EXISTS place_nomination (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   uuid NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
  source        text NOT NULL,
  -- Stable identity of the fold. Same key => same nomination across re-imports,
  -- so a decision already made is never asked again.
  cluster_key   text NOT NULL,
  label         text NOT NULL,
  municipality  text,
  variants      text[] NOT NULL DEFAULT '{}',
  case_count    integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'pending',
  -- Filled in only by the person who approves. No geocoder writes here: a
  -- machine's guess would be indistinguishable from a human's knowledge.
  lat           double precision,
  lng           double precision,
  radius_m      integer,
  decided_by    text,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_nomination_status_ck
    CHECK (status IN ('pending', 'approved', 'rejected')),
  -- An approval without a point is not an approval. This is the guard that
  -- makes "approved" mean something a team can drive to.
  CONSTRAINT place_nomination_approved_has_point_ck
    CHECK (status <> 'approved' OR (lat IS NOT NULL AND lng IS NOT NULL)),
  -- And no decision is anonymous.
  CONSTRAINT place_nomination_decided_signed_ck
    CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS place_nomination_key_uq
  ON place_nomination (incident_id, source, cluster_key);

CREATE INDEX IF NOT EXISTS place_nomination_pending
  ON place_nomination (incident_id, status, case_count DESC);

COMMENT ON TABLE place_nomination IS
  'A question for a person: is this named structure real, and where is it? Nothing here places anything on the map until status = approved, signed and dated.';

-- Which cases named the structure. Kept explicit rather than re-derived from
-- text at read time: the text may be re-harvested and change under us, and an
-- approval must stay attached to the rows it was granted for.
CREATE TABLE IF NOT EXISTS place_nomination_case (
  nomination_id uuid NOT NULL REFERENCES place_nomination(id) ON DELETE CASCADE,
  case_id       uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  place_text    text NOT NULL,
  PRIMARY KEY (nomination_id, case_id)
);

CREATE INDEX IF NOT EXISTS place_nomination_case_by_case
  ON place_nomination_case (case_id);

-- The only sanctioned way to read a coordinate for an imported case. Anything
-- that joins external_case straight to a geocoder output is a bug.
CREATE OR REPLACE VIEW approved_place AS
  SELECT pnc.case_id,
         pn.id            AS nomination_id,
         pn.label,
         pn.municipality,
         pn.lat,
         pn.lng,
         COALESCE(pn.radius_m, 150) AS radius_m,
         pn.decided_by,
         pn.decided_at
    FROM place_nomination pn
    JOIN place_nomination_case pnc ON pnc.nomination_id = pn.id
   WHERE pn.status = 'approved';

COMMENT ON VIEW approved_place IS
  'Imported cases that a named person granted a coordinate to. Empty is the correct state until someone reviews the queue.';

-- Erasure has to keep working. 0014 promised that forgetting a source is one
-- statement; nominations are derived from that source and must go with it.
CREATE OR REPLACE FUNCTION public.forget_external_places(p_source text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM place_nomination WHERE source = p_source;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.forget_external_places(text) IS
  'Drop every place nomination derived from a source. Called by forget_external_source; safe to call alone.';

-- Re-declared (not edited) so the one-statement promise from 0014 stays true
-- now that a second table holds data derived from the source. Body is 0014's,
-- with the nomination sweep in front of it: place_nomination_case cascades from
-- person_case, but a nomination with every case gone would otherwise survive as
-- a labelled address with a count of zero -- which is still their data.
CREATE OR REPLACE FUNCTION public.forget_external_source(p_source text)
RETURNS TABLE (deleted_cases int, kept_merged int)
LANGUAGE plpgsql AS $$
DECLARE
  v_del int := 0;
  v_kept int := 0;
BEGIN
  PERFORM public.forget_external_places(p_source);

  SELECT count(*) INTO v_kept
    FROM external_case ec
    JOIN person_case pc ON pc.id = ec.case_id
   WHERE ec.source = p_source
     AND EXISTS (SELECT 1 FROM person_case o WHERE o.merged_into = pc.id);

  WITH doomed AS (
    SELECT ec.case_id
      FROM external_case ec
      JOIN person_case pc ON pc.id = ec.case_id
     WHERE ec.source = p_source
       AND NOT EXISTS (SELECT 1 FROM person_case o WHERE o.merged_into = pc.id)
  ), r AS (
    DELETE FROM report WHERE case_id IN (SELECT case_id FROM doomed)
  ), i AS (
    DELETE FROM person_index WHERE case_id IN (SELECT case_id FROM doomed)
  )
  DELETE FROM person_case WHERE id IN (SELECT case_id FROM doomed);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  RETURN QUERY SELECT v_del, v_kept;
END $$;

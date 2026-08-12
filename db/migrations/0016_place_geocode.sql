-- 0016_place_geocode.sql — a machine may SUGGEST a coordinate. It may not sign one.
--
-- WHY THIS IS NOT JUST "ADD lat/lng"
--   0015 gave place_nomination lat/lng, and guarded them: 'approved' requires a
--   point, and every decision carries a name and a date. Those columns are a
--   HUMAN's answer. A geocoder's answer looks identical in the type system and
--   is a completely different kind of fact: it is a lookup in a gazetteer that
--   has never seen this earthquake, cannot know which building fell, and always
--   returns something.
--
--   If both went in the same column, then one careless UPDATE — or one reviewer
--   clicking through a pre-filled form — turns a guess into a signed decision,
--   and nothing downstream can tell them apart afterwards. So the suggestion
--   gets its own columns. `approved_place` is untouched and still reads only
--   the human ones.
--
-- THE GRADE IS THE POINT
--   Live check on this data: "Universidad Tecnológica de Pereira" resolves to a
--   university (rank 30, a real campus), while "Parque la Libertad, Pereira"
--   resolves to the administrative boundary of the SECTOR named after the park
--   — 900 m wide, centred on nothing. Same API, same confident shape. Storing
--   the grade next to the coordinate is what stops the second one from becoming
--   a dig site.
--
-- Append-only. Nothing already applied is edited.

ALTER TABLE place_nomination
  ADD COLUMN IF NOT EXISTS cand_lat        double precision,
  ADD COLUMN IF NOT EXISTS cand_lng        double precision,
  ADD COLUMN IF NOT EXISTS cand_precision  text,
  ADD COLUMN IF NOT EXISTS cand_label      text,
  ADD COLUMN IF NOT EXISTS cand_category   text,
  ADD COLUMN IF NOT EXISTS cand_rank       integer,
  ADD COLUMN IF NOT EXISTS cand_reason     text,
  ADD COLUMN IF NOT EXISTS cand_query      text,
  ADD COLUMN IF NOT EXISTS cand_provider   text,
  ADD COLUMN IF NOT EXISTS cand_at         timestamptz;

ALTER TABLE place_nomination
  DROP CONSTRAINT IF EXISTS place_nomination_cand_precision_ck;
ALTER TABLE place_nomination
  ADD CONSTRAINT place_nomination_cand_precision_ck
  CHECK (cand_precision IS NULL OR cand_precision IN
         ('exact', 'street', 'area', 'town', 'none'));

-- A candidate without a grade is exactly the thing this migration exists to
-- prevent: a bare coordinate that looks authoritative.
ALTER TABLE place_nomination
  DROP CONSTRAINT IF EXISTS place_nomination_cand_graded_ck;
ALTER TABLE place_nomination
  ADD CONSTRAINT place_nomination_cand_graded_ck
  CHECK (cand_lat IS NULL OR cand_precision IS NOT NULL);

COMMENT ON COLUMN place_nomination.cand_lat IS
  'A geocoder''s suggestion. NOT a decision: nothing on the map reads this column. Copied into lat/lng only by a person, who then signs.';
COMMENT ON COLUMN place_nomination.cand_precision IS
  'exact = a building/amenity feature | street = a road | area = a boundary named after the place | town = the municipality centroid | none = not found or wrong municipality. Only ''exact'' is worth a reviewer''s time first.';

-- The review queue, ordered the way a human hour should be spent: the structure
-- the most people named, with a usable suggestion, at the top.
CREATE OR REPLACE VIEW place_review_queue AS
  SELECT pn.id,
         pn.incident_id,
         pn.source,
         pn.label,
         pn.municipality,
         pn.variants,
         pn.case_count,
         pn.status,
         pn.cand_lat,
         pn.cand_lng,
         pn.cand_precision,
         pn.cand_label,
         pn.cand_reason,
         -- What the reviewer is actually being asked to do next.
         CASE
           WHEN pn.status <> 'pending'          THEN 'decided'
           WHEN pn.cand_precision = 'exact'     THEN 'confirm the suggested point'
           WHEN pn.cand_precision IN ('street') THEN 'narrow the street to a structure'
           WHEN pn.cand_precision IN ('area','town') THEN 'place it by hand — the lookup only matched the name'
           WHEN pn.cand_precision = 'none'      THEN 'place it by hand — nothing was found'
           ELSE 'not looked up yet'
         END AS next_action
    FROM place_nomination pn
   ORDER BY (pn.status = 'pending') DESC,
            (pn.cand_precision = 'exact') DESC,
            pn.case_count DESC;

COMMENT ON VIEW place_review_queue IS
  'Pending place questions, most-named first, with the geocoder''s graded suggestion alongside. Reading this view never puts anything on a map.';

-- Erasure keeps working unchanged: candidates live on place_nomination rows,
-- which forget_external_places already deletes.

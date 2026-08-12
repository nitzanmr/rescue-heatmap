-- 0014_external_registry.sql — a case can come from somewhere that is not us.
--
-- WHY
--   colombiatebusca.com is a citizen registry holding thousands of "por
--   localizar" entries for this earthquake. Those people are real and our map
--   cannot see them. Importing them is the difference between a demo and a tool.
--
-- WHAT THIS MIGRATION REFUSES TO DO
--   It does not let imported rows be indistinguishable from a report a family
--   made to us. Three separate reasons:
--
--     1. Consent. A family typed their information into somebody else's form,
--        under somebody else's privacy notice. Under Ley 1581/2012 we are a new
--        controller the moment we store it. The provenance columns below are
--        what makes an erasure request answerable: "delete everything sourced
--        from X" has to be one statement, not an archaeology project.
--
--     2. Truth. Their record is a copy that ages. When their site marks a person
--        located and we do not re-import, our map keeps a rescue team looking
--        for someone who is home. `source_synced_at` is how we know how stale
--        the copy is; `external_case` keeps their status alongside ours instead
--        of overwriting it.
--
--     3. Measurement. A duplicate rate computed over a mixture of our intake and
--        a scrape is not the number we tuned the engine on. `person_case.source`
--        makes every metric sliceable by origin.
--
-- Append-only, idempotent, and nothing already applied is edited.

-- Where a case came from. 'citizen' = someone used our form. Existing rows are
-- ours by definition, so the default backfills correctly.
ALTER TABLE person_case
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'citizen';

COMMENT ON COLUMN person_case.source IS
  'citizen = reported through our intake. Anything else is an import; see external_case.';

-- One row per imported case. Separate table on purpose: the foreign registry's
-- fields are theirs, they change shape without warning, and they must never be
-- mistaken for something a reporter told us.
CREATE TABLE IF NOT EXISTS external_case (
  case_id         uuid PRIMARY KEY REFERENCES person_case(id) ON DELETE CASCADE,
  source          text NOT NULL,
  source_ref      text NOT NULL,        -- their stable id
  source_code     text,                 -- their human-facing code (e.g. CTB-1A2B3C4D)
  source_url      text,
  source_status   text,                 -- their status, verbatim, never merged into ours
  source_payload  jsonb NOT NULL,       -- exactly what we harvested, for audit
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  source_synced_at timestamptz NOT NULL DEFAULT now()
);

-- Re-running the importer must update, not duplicate. This is the whole
-- idempotency contract.
CREATE UNIQUE INDEX IF NOT EXISTS external_case_source_uq
  ON external_case (source, source_ref);

CREATE INDEX IF NOT EXISTS external_case_stale
  ON external_case (source, source_synced_at);

-- ---------------------------------------------------------------------------
-- Erasure, as one statement.
--
-- A data subject (or the source site, or a regulator) asks us to stop holding
-- what we copied. This must be trivially executable and it must be honest about
-- what it removes: the case, its reports, its index row, its merge decisions.
-- Cases that a human has since merged INTO are left alone and reported back,
-- because deleting them would silently drop the human's decision as well.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.forget_external_source(p_source text)
RETURNS TABLE (deleted_cases int, kept_merged int)
LANGUAGE plpgsql AS $$
DECLARE
  v_del int := 0;
  v_kept int := 0;
BEGIN
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

COMMENT ON FUNCTION public.forget_external_source(text) IS
  'Ley 1581/2012 erasure for one imported source. Cases another case was merged into are kept and counted, not silently dropped.';

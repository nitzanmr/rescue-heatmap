-- 0009_merge_ledger.sql — make "un merge is reversible" true.
--
-- The panel tells the operator, in Spanish, on the card, that joining two cases
-- can be undone. Three things made that a claim rather than a fact:
--
-- 1. THE UNDO WAS ONLY PARTIAL. The merge moved reports, sightings, media AND
--    reporter tokens onto the survivor, but the ledger recorded only the report
--    ids. Undo therefore returned the reports and left everything else behind —
--    including the family's private token, which means the link on their phone
--    kept opening a case that was no longer theirs. A partial undo is worse than
--    no undo: it looks reversed.
--
-- 2. THE MERGE HID THE CASE AND THE UNDO DID NOT UNHIDE IT. Merging sets
--    public_listed = false on the absorbed case. Nothing recorded what it was
--    before, so after an undo the person was restored but invisible to public
--    search. Silent invisibility is the worst failure mode this system has.
--
-- 3. AN UNDO COULD BE APPLIED TWICE. case_merge is append-only for the app role
--    (0005), so undo inserts a row instead of stamping the original. But nothing
--    linked the two rows, so the "already undone" guard on the original never
--    fired, and the ledger could not answer "is this merge currently undone?" —
--    which is why the panel had no button to offer.
--
-- All three are recording problems, so the fix is columns, not behaviour. Old
-- rows keep NULL/empty arrays: a merge performed before this migration can
-- still be undone as far as its record allows (reports), and no more. We do not
-- pretend otherwise, and the ledger view says so.

ALTER TABLE case_merge
  -- The undo row points at the merge it reverses. This is what makes "undone"
  -- answerable without ever updating an append-only row.
  ADD COLUMN IF NOT EXISTS undoes_merge_id      bigint REFERENCES case_merge(id),
  ADD COLUMN IF NOT EXISTS moved_sightings      uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS moved_media          uuid[] NOT NULL DEFAULT '{}',
  -- reporter_token is keyed by sha256(pepper || token); we store the hash, so
  -- the ledger holds no token even in the row that has to move one back.
  ADD COLUMN IF NOT EXISTS moved_tokens         text[] NOT NULL DEFAULT '{}',
  -- What public_listed was on the absorbed case before the merge hid it.
  ADD COLUMN IF NOT EXISTS merged_public_listed boolean;

-- One undo per merge. The guard belongs in the schema: two concurrent operators
-- pressing "deshacer" on the same row would otherwise both pass an application
-- level check and move the reports back twice.
CREATE UNIQUE INDEX IF NOT EXISTS case_merge_undo_uq
  ON case_merge (undoes_merge_id) WHERE undoes_merge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS case_merge_at_idx ON case_merge (at DESC);

-- The panel's ledger. Merges only (undo rows are folded in as a flag), newest
-- first, with enough of both cases to recognise a mistake without opening them.
CREATE OR REPLACE VIEW public.case_merge_ledger AS
SELECT m.id,
       m.survivor_id,
       m.merged_id,
       m.candidate_id,
       m.actor,
       m.at,
       (u.id IS NOT NULL)                    AS undone,
       u.at                                  AS undone_at,
       u.actor                               AS undone_by,
       cardinality(m.moved_reports)          AS moved_reports,
       -- A merge recorded before 0009 can only be partially reversed. The panel
       -- must be able to say that out loud rather than promise a clean undo.
       (m.merged_public_listed IS NOT NULL)  AS fully_recorded,
       sc.reference_number AS survivor_ref, si.name_raw AS survivor_name,
       mc.reference_number AS merged_ref,   mi.name_raw AS merged_name
  FROM case_merge m
  LEFT JOIN case_merge u   ON u.undoes_merge_id = m.id
  JOIN person_case  sc     ON sc.id = m.survivor_id
  JOIN person_case  mc     ON mc.id = m.merged_id
  LEFT JOIN person_index si ON si.case_id = m.survivor_id
  LEFT JOIN person_index mi ON mi.case_id = m.merged_id
 WHERE m.undoes_merge_id IS NULL;

DO $$
BEGIN
  EXECUTE 'GRANT SELECT ON public.case_merge_ledger TO app_rw';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grant on case_merge_ledger skipped: %', SQLERRM;
END $$;

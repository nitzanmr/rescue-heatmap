-- purge-incident.sql — remove one incident and everything hanging off it.
--
-- WHY THIS EXISTS
--   `make seed` writes 500 synthetic people into `drill-quibdo`. They look
--   exactly like real cases: same tables, same columns, same heat cells. Once a
--   real incident is imported next to them, every number the tool prints —
--   "93 people at this structure", "this cell has 12 cases" — is a mix of a
--   collapsed building and a rehearsal. That is not a cosmetic problem, it is
--   the failure mode that sends a team to a building nobody was ever in.
--
--   `make drill` already wipes the whole database (down -v) and reseeds. That
--   is the wrong tool once a live instance holds real reports. This script
--   deletes ONE incident and leaves everything else alone.
--
-- ORDER MATTERS
--   person_case.incident_id is ON DELETE RESTRICT on purpose: the database
--   refuses to lose people by accident. So children go first, in dependency
--   order, and the incident row last. If any statement fails the whole thing
--   rolls back — a half-purged incident is worse than an untouched one.
--
-- USAGE
--   make purge SLUG=drill-quibdo CONFIRM=yes
--
-- This is destructive and irreversible. Run `make census` before and after.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _inc ON COMMIT DROP AS
  SELECT id FROM incident WHERE slug = :'slug';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _inc) THEN
    RAISE EXCEPTION 'no incident with that slug — nothing purged';
  END IF;
END $$;

CREATE TEMP TABLE _case ON COMMIT DROP AS
  SELECT id FROM person_case WHERE incident_id IN (SELECT id FROM _inc);

CREATE TEMP TABLE _report ON COMMIT DROP AS
  SELECT id FROM report
   WHERE incident_id IN (SELECT id FROM _inc)
      OR case_id IN (SELECT id FROM _case);

\echo '--- purging ---'
SELECT (SELECT count(*) FROM _case) AS cases, (SELECT count(*) FROM _report) AS reports;

-- Place review queue (0015/0016). Nominations are incident-scoped.
DELETE FROM place_nomination_case
 WHERE case_id IN (SELECT id FROM _case)
    OR nomination_id IN (SELECT id FROM place_nomination WHERE incident_id IN (SELECT id FROM _inc));
DELETE FROM place_nomination WHERE incident_id IN (SELECT id FROM _inc);

-- Registry provenance (0014) and location decisions (0011).
DELETE FROM external_case            WHERE case_id IN (SELECT id FROM _case);
DELETE FROM case_location_override   WHERE case_id IN (SELECT id FROM _case);

-- Dedup queue and merge ledger. case_merge has no cascade: an un-merge must
-- stay possible for cases that survive, so it is deleted explicitly here.
DELETE FROM case_merge
 WHERE survivor_id IN (SELECT id FROM _case) OR merged_id IN (SELECT id FROM _case);
DELETE FROM dedup_candidate
 WHERE incident_id IN (SELECT id FROM _inc)
    OR a_case IN (SELECT id FROM _case) OR b_case IN (SELECT id FROM _case);

DELETE FROM sighting     WHERE case_id IN (SELECT id FROM _case);
DELETE FROM person_index WHERE case_id IN (SELECT id FROM _case)
                            OR incident_id IN (SELECT id FROM _inc);

-- Intake. media and report_revision point at report without cascade.
DELETE FROM media
 WHERE report_id IN (SELECT id FROM _report) OR case_id IN (SELECT id FROM _case);
DELETE FROM report_revision
 WHERE report_id IN (SELECT id FROM _report) OR case_id IN (SELECT id FROM _case);
DELETE FROM report WHERE id IN (SELECT id FROM _report);

-- Self-reference first: a merged case points at its survivor.
UPDATE person_case SET merged_into = NULL WHERE incident_id IN (SELECT id FROM _inc);
DELETE FROM person_case WHERE id IN (SELECT id FROM _case);

-- Aid sites are NOT incident data: a hospital exists before the earthquake.
-- Detach, never delete.
UPDATE aid_site SET incident_id = NULL WHERE incident_id IN (SELECT id FROM _inc);

DELETE FROM incident WHERE id IN (SELECT id FROM _inc);

-- Synthetic ground truth only ever describes seeded cases. Once the seeded
-- incident is gone it is a table of dangling uuids that a future test could
-- score itself against and pass.
DROP TABLE IF EXISTS seed_truth;

COMMIT;
\echo 'purged.'

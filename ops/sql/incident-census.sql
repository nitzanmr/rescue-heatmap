-- incident-census.sql — what is actually in this database, per incident.
--
-- Run this BEFORE and AFTER any purge. The question "is there still mock data
-- in there?" must be answered by a count, not by memory: a drill incident that
-- is 90% deleted is worse than one that was never touched, because the
-- remainder looks like real data.
--
--   make census
\pset border 2
\echo '--- incidents ---'
SELECT i.slug,
       i.name,
       i.ended_at IS NULL                         AS active,
       (SELECT count(*) FROM person_case  c WHERE c.incident_id = i.id) AS cases,
       (SELECT count(*) FROM person_case  c WHERE c.incident_id = i.id
          AND EXISTS (SELECT 1 FROM external_case e WHERE e.case_id = c.id)) AS imported,
       (SELECT count(*) FROM report       r WHERE r.incident_id = i.id) AS reports,
       (SELECT count(*) FROM place_nomination n WHERE n.incident_id = i.id) AS nominations
  FROM incident i
 ORDER BY i.started_at;

\echo '--- cases with no incident at all (orphans) ---'
SELECT count(*) AS orphan_cases FROM person_case WHERE incident_id IS NULL;

\echo '--- leftover synthetic ground truth (seed only) ---'
SELECT to_regclass('public.seed_truth') IS NOT NULL AS seed_truth_present;

\echo '--- aid sites (not incident data; loaded from OSM in peacetime) ---'
SELECT source, count(*) FROM aid_site GROUP BY source ORDER BY 2 DESC;

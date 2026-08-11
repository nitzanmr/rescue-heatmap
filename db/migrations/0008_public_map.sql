-- 0008_public_map.sql — the public map: aid sites, and a heat weight that
-- compresses corroboration instead of compressing everything.
--
-- Two changes, both decided in the group on 11 Aug 2026:
--
-- 1. AID SITES. The public map's job is not "find my missing relative" (that is
--    /buscar); it is "where do I go". Shelters, hospitals and collection points
--    are the layer that actually earns the traffic — and unlike damaged
--    buildings they can be assembled BEFORE an event, which is the whole point
--    of being ready for the next one.
--
--    Deliberately NOT joined to person data. An aid site is public reference
--    information about an institution, not a report about a person; keeping the
--    two tables apart means the public map layer can never leak a case by an
--    accidental join.
--
-- 2. WEIGHTING. 0004 applied sqrt() to the SUM of a cell, i.e. it compressed
--    accuracy and urgency too. That is wrong in the one direction we cannot
--    afford: a cell holding a single "trapped_alive" report was being pulled
--    towards the middle of the gradient by the same function that was supposed
--    to stop a busy building from swallowing the map. Corroboration is the term
--    with the runaway tail (one family can file six reports); accuracy and
--    urgency are bounded and meaningful. So: sqrt on corroboration only, linear
--    everywhere else, no outer sqrt.

-- ---------------------------------------------------------------------------
-- 1 · Weighting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.case_weight(
  accuracy text, status text, reporter_count int)
RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (CASE accuracy
            WHEN 'exact' THEN 1.0 WHEN 'building' THEN 0.9 WHEN 'block' THEN 0.6
            WHEN 'neighbourhood' THEN 0.35 ELSE 0.15 END)
       * (CASE status
            WHEN 'trapped_alive' THEN 2.5 WHEN 'missing' THEN 1.0 ELSE 0.2 END)
       -- Corroboration, compressed: the 2nd independent report is worth a lot,
       -- the 6th is worth very little, and no number of reports may outrank
       -- "someone is alive under this slab". Capped so a coordinated campaign
       -- (or a bot) cannot manufacture a hotspot.
       * LEAST(sqrt(GREATEST(COALESCE(reporter_count, 1), 1)), 3.0);
$$;

CREATE OR REPLACE FUNCTION public.heat_cells(
  p_incident uuid, p_cell_m int DEFAULT 100, p_status text[] DEFAULT NULL)
RETURNS TABLE (lat double precision, lng double precision,
               weight double precision, cases int)
LANGUAGE sql STABLE AS $$
  WITH src AS (
    SELECT ST_Transform(pi.last_seen::geometry, 3857) AS g,
           public.case_weight(pi.location_accuracy, pc.status, pi.reporter_count) AS w
    FROM person_index pi
    JOIN person_case pc ON pc.id = pi.case_id
    WHERE pi.incident_id = p_incident
      AND pi.last_seen IS NOT NULL
      AND pc.merged_into IS NULL
      AND pc.anonymised_at IS NULL
      AND (p_status IS NULL OR pc.status = ANY(p_status))
  ), cells AS (
    SELECT ST_SnapToGrid(g, p_cell_m, p_cell_m) AS cell, sum(w) AS w, count(*)::int AS n
    FROM src GROUP BY 1
  )
  -- No outer sqrt: the compression now sits on the corroboration term, where the
  -- runaway is. Distinct people in one cell SHOULD add up linearly — that is the
  -- signal a rescue team is being ranked by.
  SELECT ST_Y(ST_Transform(cell, 4326)), ST_X(ST_Transform(cell, 4326)), w, n
  FROM cells;
$$;

-- ---------------------------------------------------------------------------
-- 2 · Aid sites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aid_site (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable on purpose: a hospital exists before the earthquake does. Sites
  -- are loaded per country/bbox in peacetime and attached to an incident (or
  -- not) at activation.
  incident_id   uuid REFERENCES incident(id) ON DELETE SET NULL,
  country_code  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN (
                  'shelter', 'shelter_candidate', 'medical', 'pharmacy',
                  'responder', 'supply', 'water', 'morgue', 'info_point', 'other')),
  name          text NOT NULL,
  geom          geography(Point, 4326) NOT NULL,
  address       text,
  phone         text,
  capacity      int,
  -- open / full / closed / unknown. Not a CHECK: during an event a coordinator
  -- must be able to write a state we did not think of at 3am, and a failed
  -- INSERT is worse than an unexpected string on a map legend.
  status        text NOT NULL DEFAULT 'unknown',
  notes         text,
  -- Provenance is not decoration: "OSM says there is a hospital here" and "our
  -- liaison stood in it this morning" must be distinguishable on the map.
  source        text NOT NULL DEFAULT 'manual',
  source_ref    text,
  source_url    text,
  verified_at   timestamptz,
  verified_by   text,
  published     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS aid_site_source_key
  ON aid_site (source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS aid_site_geom_gix ON aid_site USING gist (geom);
CREATE INDEX IF NOT EXISTS aid_site_kind_idx ON aid_site (country_code, kind) WHERE published;

-- Public projection. Exact coordinates here are correct and intended: this is a
-- hospital, not a person. No rounding, and no join to any case table.
CREATE OR REPLACE FUNCTION public.aid_sites(
  p_country text, p_kinds text[] DEFAULT NULL, p_incident uuid DEFAULT NULL)
RETURNS TABLE (id uuid, kind text, name text, lat double precision,
               lng double precision, address text, phone text, capacity int,
               status text, verified boolean, source text, updated_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.kind, s.name,
         ST_Y(s.geom::geometry), ST_X(s.geom::geometry),
         s.address, s.phone, s.capacity, s.status,
         s.verified_at IS NOT NULL, s.source, s.updated_at
  FROM aid_site s
  WHERE s.published
    AND s.country_code = upper(p_country)
    AND (p_kinds IS NULL OR s.kind = ANY(p_kinds))
    AND (p_incident IS NULL OR s.incident_id IS NULL OR s.incident_id = p_incident);
$$;

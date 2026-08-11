-- 0004_heatmap_embeddings.sql — heat aggregation for the map, retention helpers,
-- and the pgvector index (created up front so enabling embeddings is an UPDATE,
-- not a migration). Idempotent.

-- ---------------------------------------------------------------------------
-- Heat cells. The command map reads THIS, never the raw cases: it is 1000x
-- smaller over the wire and it is already privacy-safe.
-- Weight mirrors app/web/src/lib/schema.ts::reportWeight — accuracy x urgency
-- x corroboration. Keep the two in sync; the SQL is the source of truth.
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
       * LEAST(1 + (GREATEST(COALESCE(reporter_count,1),1) - 1) * 0.25, 2.0);
$$;

-- Aggregate on a metric grid (EPSG:3857) so cell size is in metres, not degrees.
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
  SELECT ST_Y(ST_Transform(cell, 4326)), ST_X(ST_Transform(cell, 4326)),
         -- sqrt compression: one huge focus must not swallow the map
         sqrt(w), n
  FROM cells;
$$;

-- ---------------------------------------------------------------------------
-- Embeddings. Provisioned now, switched on later (architecture §4).
-- HNSW build is cheap while the table is small — do it before an event, not during.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'person_index_vec_hnsw') THEN
    EXECUTE 'CREATE INDEX person_index_vec_hnsw ON person_index
             USING hnsw (narrative_vec vector_cosine_ops)
             WITH (m = 16, ef_construction = 64)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'hnsw index skipped: %', SQLERRM;   -- older pgvector: ivfflat fallback
END $$;

-- ---------------------------------------------------------------------------
-- Retention. ADR-001: the PUBLIC listing expires; the OPERATIONAL record stays.
-- Erasure on request = anonymise in place, audit trail preserved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_public_listings()
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE person_case pc SET public_listed = false, updated_at = now()
  FROM incident i
  WHERE pc.incident_id = i.id
    AND pc.public_listed
    AND i.public_expires_at IS NOT NULL
    AND i.public_expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO audit_log (actor, role, action, subject, detail)
  VALUES ('system','system','public_listing.expire', NULL, jsonb_build_object('cases', n));
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.anonymise_case(p_case uuid, p_actor text, p_reason text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE report SET payload = payload
      - 'full_name' - 'reporter_name' - 'reporter_phone' - 'national_id_last4'
      - 'distinguishing_info' - 'medical_info' - 'photo_data_url'
      - 'last_seen_lat' - 'last_seen_lng' - 'last_seen_address'
      - 'apartment' - 'floor',
      reporter_phone_e164 = NULL
  WHERE case_id = p_case;

  UPDATE person_index SET
    name_raw = NULL, name_norm = NULL, name_tokens = NULL, phone_e164 = NULL,
    national_id_last4 = NULL, narrative = NULL, fts = NULL, narrative_vec = NULL,
    reporter_phones = '{}', last_seen = NULL, building_name = NULL,
    floor = NULL, apartment = NULL
  WHERE case_id = p_case;

  UPDATE media SET deleted_at = now() WHERE case_id = p_case AND deleted_at IS NULL;
  UPDATE person_case SET anonymised_at = now(), public_listed = false, updated_at = now()
  WHERE id = p_case;
  DELETE FROM reporter_token WHERE case_id = p_case;

  INSERT INTO audit_log (actor, action, subject, detail)
  VALUES (p_actor, 'case.anonymise', p_case::text, jsonb_build_object('reason', p_reason));
END;
$$;

-- Media whose operational retention window has passed: the worker deletes the
-- bytes via StoragePort, this only marks intent and keeps the metadata.
CREATE OR REPLACE VIEW media_due_for_purge AS
SELECT id, case_id, bucket, storage_key, blurred_key
FROM media
WHERE deleted_at IS NULL AND purge_after IS NOT NULL AND purge_after <= now();

-- 0001_init.sql — extensions and core schema.
-- Applied by the migration runner, NOT by Terraform. See ops/infra/README.md.
-- Must be idempotent and safe to re-run against a fresh project.

-- WHERE EXTENSIONS LIVE IS THE PROVIDER'S DECISION, NOT OURS.
--   Supabase          -> schema `extensions`, pre-created.
--   postgis/postgis   -> schema `public`, created by the image's initdb hook.
--   Cloud SQL / Neon  -> wherever the operator ran CREATE EXTENSION.
-- postgis is relocatable = false, so we cannot move it, and hard-coding one
-- schema means the migration only applies on the provider we happened to test.
-- Instead: guarantee the schema exists, put it on the search_path, and never
-- qualify an extension object by hand.
CREATE SCHEMA IF NOT EXISTS extensions;
SET LOCAL search_path = public, extensions;

-- IF NOT EXISTS + WITH SCHEMA is a no-op when the provider already created the
-- extension elsewhere; the search_path above is what makes both cases work.
CREATE EXTENSION IF NOT EXISTS postgis   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto  WITH SCHEMA extensions;

-- Spanish name normalisation: unaccent must be IMMUTABLE to be indexable.
-- An indexed function must not depend on the caller's search_path, so this one
-- is generated with the dictionary's real schema baked in, whatever it turned
-- out to be, plus a pinned search_path of its own.
DO $mig$
DECLARE ext_ns text;
BEGIN
  SELECT n.nspname INTO ext_ns
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'unaccent';
  IF ext_ns IS NULL THEN
    RAISE EXCEPTION 'unaccent extension is not installed';
  END IF;

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION public.name_norm(txt text)
    RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path = public, %I, pg_catalog
    AS $body$ SELECT lower(%I.unaccent(%L::regdictionary, txt)) $body$;
  $f$, ext_ns, ext_ns, ext_ns || '.unaccent');
END
$mig$;

-- Core tables (see docs/architecture.md §3 for rationale).
CREATE TABLE IF NOT EXISTS person_case (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'missing',
  incident_id  uuid,
  public_listed boolean NOT NULL DEFAULT true,
  merged_into  uuid REFERENCES person_case(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES person_case(id),
  channel      text NOT NULL,
  payload      jsonb NOT NULL,
  source_ref   text,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person_index (
  case_id      uuid PRIMARY KEY REFERENCES person_case(id) ON DELETE CASCADE,
  name_norm    text,
  age_approx   int,
  phone_e164   text,
  last_seen    geography(Point, 4326),
  last_seen_at timestamptz,
  fts          tsvector,
  narrative_vec vector(768)
);

CREATE INDEX IF NOT EXISTS person_index_name_trgm
  ON person_index USING gin (name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS person_index_geo
  ON person_index USING gist (last_seen);
CREATE INDEX IF NOT EXISTS person_index_fts
  ON person_index USING gin (fts);
-- HNSW is created only when embeddings are switched on (0004).

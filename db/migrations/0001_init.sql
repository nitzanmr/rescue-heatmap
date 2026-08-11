-- 0001_init.sql — extensions and core schema.
-- Applied by the migration runner, NOT by Terraform. See ops/infra/README.md.
-- Must be idempotent and safe to re-run against a fresh project.

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS postgis   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto  WITH SCHEMA extensions;

-- Spanish name normalisation: unaccent must be IMMUTABLE to be indexable.
CREATE OR REPLACE FUNCTION public.name_norm(txt text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT lower(extensions.unaccent('extensions.unaccent', txt));
$$;

-- Core tables (see docs/architecture.md §3 for rationale).
CREATE TABLE IF NOT EXISTS person_case (
  id           uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  status       text NOT NULL DEFAULT 'missing',
  incident_id  uuid,
  public_listed boolean NOT NULL DEFAULT true,
  merged_into  uuid REFERENCES person_case(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report (
  id           uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
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
  last_seen    extensions.geography(Point, 4326),
  last_seen_at timestamptz,
  fts          tsvector,
  narrative_vec extensions.vector(768)
);

CREATE INDEX IF NOT EXISTS person_index_name_trgm
  ON person_index USING gin (name_norm extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS person_index_geo
  ON person_index USING gist (last_seen);
CREATE INDEX IF NOT EXISTS person_index_fts
  ON person_index USING gin (fts);
-- HNSW is created only when embeddings are switched on (0004).

-- 0002_operational.sql — operational tables: intake, versioning, media, sightings,
-- dedup queue, audit, auth and the job queue.
-- Idempotent. Safe to re-run. Applied by the migration runner, never by Terraform.

-- ---------------------------------------------------------------------------
-- Incidents. Every case belongs to exactly one event. Retention, exports and
-- the "delete everything when the event ends" promise (ADR-001) hang off this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE NOT NULL,
  name           text NOT NULL,
  country        text,
  ref_prefix     text NOT NULL DEFAULT 'CO',
  centre         geography(Point, 4326),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  public_expires_at timestamptz,          -- when the public listing goes dark
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE person_case
  ADD COLUMN IF NOT EXISTS reference_number text,
  ADD COLUMN IF NOT EXISTS status_source    text NOT NULL DEFAULT 'citizen',
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS consent_photo_public boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_minor         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anonymised_at    timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

ALTER TABLE person_case
  DROP CONSTRAINT IF EXISTS person_case_incident_fk;
ALTER TABLE person_case
  ADD CONSTRAINT person_case_incident_fk
  FOREIGN KEY (incident_id) REFERENCES incident(id) ON DELETE RESTRICT;

-- Reference number is what a family reads out on the phone. Unique per incident.
CREATE UNIQUE INDEX IF NOT EXISTS person_case_ref_uq
  ON person_case (incident_id, reference_number)
  WHERE reference_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS person_case_status   ON person_case (incident_id, status);
CREATE INDEX IF NOT EXISTS person_case_merged   ON person_case (merged_into)
  WHERE merged_into IS NOT NULL;

ALTER TABLE person_case
  DROP CONSTRAINT IF EXISTS person_case_status_chk;
ALTER TABLE person_case
  ADD CONSTRAINT person_case_status_chk CHECK (status IN
    ('missing','trapped_alive','found_safe','found_injured','deceased','withdrawn'));

-- ---------------------------------------------------------------------------
-- Intake. `report` rows are append-only: a submission is evidence, and evidence
-- is never rewritten. Correction goes into report_revision.
-- ---------------------------------------------------------------------------
ALTER TABLE report
  ADD COLUMN IF NOT EXISTS incident_id       uuid REFERENCES incident(id),
  ADD COLUMN IF NOT EXISTS idempotency_key   text,
  ADD COLUMN IF NOT EXISTS device_uuid       text,
  ADD COLUMN IF NOT EXISTS created_at_device timestamptz,
  ADD COLUMN IF NOT EXISTS clock_skew_ms     bigint,
  ADD COLUMN IF NOT EXISTS reporter_phone_e164 text,
  ADD COLUMN IF NOT EXISTS ip_hash           text;

-- Offline queues retry. The device UUID is the natural idempotency key: the same
-- submission arriving three times over a flaky link must create one report.
CREATE UNIQUE INDEX IF NOT EXISTS report_idem_uq
  ON report (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_case      ON report (case_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS report_incident  ON report (incident_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS report_reporter_phone ON report (reporter_phone_e164)
  WHERE reporter_phone_e164 IS NOT NULL;

-- Versioned field state — "don't overwrite history".
CREATE TABLE IF NOT EXISTS report_revision (
  id         bigserial PRIMARY KEY,
  case_id    uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  report_id  uuid REFERENCES report(id),
  field      text NOT NULL,
  old_value  jsonb,
  new_value  jsonb,
  actor      text NOT NULL,               -- 'reporter:<token_hash>' | 'operator:<id>' | 'system'
  reason     text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_revision_case ON report_revision (case_id, at DESC);

-- ---------------------------------------------------------------------------
-- person_index — the denormalised correlation surface. One row per case,
-- rebuilt from the reports. Everything the dedup query touches lives here so
-- stages 1-3 stay a single round trip.
-- ---------------------------------------------------------------------------
ALTER TABLE person_index
  ADD COLUMN IF NOT EXISTS incident_id       uuid REFERENCES incident(id),
  ADD COLUMN IF NOT EXISTS name_raw          text,
  ADD COLUMN IF NOT EXISTS name_tokens       text[],
  ADD COLUMN IF NOT EXISTS gender            text,
  ADD COLUMN IF NOT EXISTS national_id_last4 text,
  ADD COLUMN IF NOT EXISTS location_accuracy text,
  ADD COLUMN IF NOT EXISTS building_name     text,
  ADD COLUMN IF NOT EXISTS floor             text,
  ADD COLUMN IF NOT EXISTS apartment         text,
  ADD COLUMN IF NOT EXISTS reporter_phones   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reporter_count    int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS narrative         text,
  ADD COLUMN IF NOT EXISTS vec_state         text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS refreshed_at      timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS person_index_incident ON person_index (incident_id);
CREATE INDEX IF NOT EXISTS person_index_phone    ON person_index (phone_e164)
  WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_index_id4      ON person_index (national_id_last4)
  WHERE national_id_last4 IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_index_vec_state ON person_index (vec_state)
  WHERE vec_state <> 'ready';

-- ---------------------------------------------------------------------------
-- Media. Postgres holds the reference; bytes live behind StoragePort (R2/S3/Blob).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  report_id      uuid REFERENCES report(id),
  storage_key    text NOT NULL,
  bucket         text NOT NULL DEFAULT 'primary',
  mime           text NOT NULL,
  bytes          bigint NOT NULL,
  sha256         text,
  width          int,
  height         int,
  kind           text NOT NULL DEFAULT 'person_photo',   -- person_photo | site | document
  consent_public boolean NOT NULL DEFAULT false,
  blurred_key    text,                                   -- redacted derivative for minors
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  purge_after    timestamptz,
  deleted_at     timestamptz
);
CREATE INDEX IF NOT EXISTS media_case  ON media (case_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS media_sha   ON media (sha256)  WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_purge ON media (purge_after) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Sightings — "I saw him", "he is safe", field confirmations. These are the
-- loop that makes a shared card worth sharing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sighting (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  kind         text NOT NULL,             -- seen | safe | hospital | shelter | deceased | correction
  note         text,
  geo          geography(Point, 4326),
  reported_at  timestamptz,
  source       text NOT NULL DEFAULT 'public',   -- public | reporter_token | operator | official
  contact_phone_e164 text,
  token_hash   text,
  trust        text NOT NULL DEFAULT 'unverified', -- unverified | corroborated | verified
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sighting_case ON sighting (case_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Dedup / correlation queue. Nothing merges without a human (architecture §4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dedup_candidate (
  id          bigserial PRIMARY KEY,
  incident_id uuid REFERENCES incident(id),
  a_case      uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  b_case      uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  score       double precision NOT NULL,
  signals     jsonb NOT NULL DEFAULT '{}'::jsonb,
  state       text NOT NULL DEFAULT 'pending',   -- pending | merged | rejected | superseded
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dedup_pair_order CHECK (a_case < b_case)
);
CREATE UNIQUE INDEX IF NOT EXISTS dedup_pair_uq ON dedup_candidate (a_case, b_case);
CREATE INDEX IF NOT EXISTS dedup_queue ON dedup_candidate (incident_id, state, score DESC);

-- Merge ledger — an un-merge must be possible. A merge only re-points case ids.
CREATE TABLE IF NOT EXISTS case_merge (
  id           bigserial PRIMARY KEY,
  survivor_id  uuid NOT NULL REFERENCES person_case(id),
  merged_id    uuid NOT NULL REFERENCES person_case(id),
  moved_reports uuid[] NOT NULL DEFAULT '{}',
  candidate_id bigint REFERENCES dedup_candidate(id),
  actor        text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz,
  undone_by    text
);
CREATE INDEX IF NOT EXISTS case_merge_survivor ON case_merge (survivor_id);

-- ---------------------------------------------------------------------------
-- Identity. Reporters have no account, only an unguessable token.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reporter_token (
  token_hash  text PRIMARY KEY,           -- sha256 of the 128-bit token, never the token
  case_id     uuid NOT NULL REFERENCES person_case(id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count   int NOT NULL DEFAULT 0,
  revoked_at  timestamptz,
  expires_at  timestamptz
);
CREATE INDEX IF NOT EXISTS reporter_token_case ON reporter_token (case_id);

CREATE TABLE IF NOT EXISTS app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  display_name  text,
  role          text NOT NULL DEFAULT 'operator',   -- operator | admin
  password_hash text,
  org           text,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_role_chk CHECK (role IN ('operator','admin'))
);

CREATE TABLE IF NOT EXISTS user_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash  text UNIQUE NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip_hash     text
);

-- ---------------------------------------------------------------------------
-- Audit. Every operator/admin write, export, merge and erasure.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  actor    text NOT NULL,
  role     text,
  action   text NOT NULL,
  subject  text,
  at       timestamptz NOT NULL DEFAULT now(),
  ip_hash  text,
  detail   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_at      ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_subject ON audit_log (subject, at DESC);

-- Append-only in practice: revoke UPDATE/DELETE from the application role.
-- (Executed by 0005_roles.sql once the runtime role exists.)

-- ---------------------------------------------------------------------------
-- Job queue — Postgres + SKIP LOCKED. One less system to run at 3 a.m.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,      -- index_refresh | correlate | embed | export | retention | media_derive
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text,
  run_after    timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe_uq ON job (dedupe_key)
  WHERE done_at IS NULL AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_ready ON job (kind, run_after)
  WHERE done_at IS NULL AND locked_at IS NULL;

-- Rate limiting for the public endpoints, keyed by hashed IP. Kept in the DB so
-- it survives container restarts and works across instances without Redis.
CREATE TABLE IF NOT EXISTS rate_bucket (
  key        text PRIMARY KEY,
  window_at  timestamptz NOT NULL,
  count      int NOT NULL DEFAULT 0
);

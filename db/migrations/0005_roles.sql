-- 0005_roles.sql — least privilege for the runtime role, and an append-only
-- audit log. The API connects as `app_rw`, never as the owner/superuser.
-- Idempotent; safe on providers where role creation is restricted (it warns).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    EXECUTE 'CREATE ROLE app_rw NOLOGIN';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'cannot create role app_rw here; grant manually';
END $$;

DO $$
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA public, extensions TO app_rw';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw';
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_rw';

  -- The audit log is evidence. The application may append; it may never rewrite.
  EXECUTE 'REVOKE UPDATE, DELETE ON audit_log FROM app_rw';
  -- Reports are evidence too: corrections go to report_revision.
  EXECUTE 'REVOKE DELETE ON report FROM app_rw';
  -- Merges are reversible only if the ledger is intact.
  EXECUTE 'REVOKE UPDATE, DELETE ON case_merge FROM app_rw';

  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE ON TABLES TO app_rw';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'grants skipped: %', SQLERRM;
END $$;

-- Statement timeouts: one pathological query must not take the intake path down
-- during an event. Applied per-role so the worker can be given a longer leash.
DO $$
BEGIN
  EXECUTE 'ALTER ROLE app_rw SET statement_timeout = ''8s''';
  EXECUTE 'ALTER ROLE app_rw SET idle_in_transaction_session_timeout = ''15s''';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'role settings skipped: %', SQLERRM;
END $$;

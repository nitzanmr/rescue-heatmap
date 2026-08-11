#!/bin/bash
# Runs once, on first initialisation of the local Postgres volume.
# Its only job is to make the local database look like a managed one: extensions
# living in a dedicated `extensions` schema, exactly as Supabase and Neon do.
# The migrations create the extensions themselves — this only prepares the
# ground so 0001_init.sql applies unchanged everywhere.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
  CREATE SCHEMA IF NOT EXISTS extensions;
  ALTER DATABASE "$POSTGRES_DB" SET search_path = public, extensions;
EOSQL

# Fail loudly here rather than three steps later inside a migration.
for ext in postgis pg_trgm unaccent vector pgcrypto; do
  if ! psql -tAc "SELECT 1 FROM pg_available_extensions WHERE name='$ext'" \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" | grep -q 1; then
    echo "[init-db] FATAL: extension '$ext' is not available in this image." >&2
    echo "[init-db] The dev database image must carry PostGIS *and* pgvector." >&2
    echo "[init-db] See ops/dev/Dockerfile.db." >&2
    exit 1
  fi
done

echo "[init-db] postgis, pg_trgm, unaccent, vector, pgcrypto all available."

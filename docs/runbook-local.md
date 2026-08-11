# Runbook — bringing the backend up

Everything below runs with no cloud account, no credit card and no network
beyond the image pull. That is deliberate: if the system cannot be stood up on a
laptop, our recovery story during an event is fiction.

## The one command

```
make drill
```

Fresh database → migrations → 500 synthetic reports with known duplicates → API
and worker up → readiness check → a real `POST /v1/reports`. It prints
`drill passed.` or it fails loudly. Takes ~1 minute on a first run (it installs
the pgvector package into the PostGIS image once — a PGDG binary, not a build).

## Step by step

```
make build      # build the API image
make up         # db + migrations + api + worker
make seed       # synthetic incident 'drill-bogota' with ground truth
make test       # correlation precision / recall
make psql       # interactive database
make logs       # tail api + worker
make reset      # drop the local volume
```

API on `http://localhost:8080`. Useful endpoints without auth:
`/healthz` (liveness), `/readyz` (touches the database), `/v1/meta`.

## What was added, and why

| File | Why it exists |
|---|---|
| `services/api/src/index.ts` | Server bootstrap. Registers all four route groups, resolves the actor once per request, shapes errors, exposes health. Also the entrypoint for all three roles. |
| `services/api/src/migrate.ts` | Numbered SQL files, applied in order, checksum-recorded, one advisory lock so two instances cannot both migrate. Deliberately **not** the provider's CLI — ADR-003 requires the schema to be portable. |
| `services/api/src/worker.ts` | The consumer for the `enqueue()` that already existed. `SKIP LOCKED`, exponential backoff, stale-lock reaping, a retention sweep on a timer. |
| `services/api/Dockerfile` | Multi-stage, non-root, `tini` as PID 1, migrations baked into the image. One artefact for API, worker and migrations. |
| `docker-compose.yml` + `ops/dev/Dockerfile.db` | Local Postgres 17 + PostGIS 3.5 + pgvector 0.8.6, with **both** extensions in one image. 17 rather than 18 deliberately: 18 is Preview on Cloud SQL and unavailable on Supabase, and this image exists to mirror the managed target. No official image has both, and our correlation query needs both in one statement. |
| `services/api/src/seed.ts` | Synthetic population with deliberate near-duplicates and a `seed_truth` table. |
| `services/api/test/correlation.test.ts` | Measures precision/recall against that ground truth. |
| `db/migrations/0006_worker.sql` | `media.derive_state`, a job housekeeping index, and the `job_health` view. |

## Roles

The same image, selected by `ROLE`:

```
ROLE=migrate   run migrations, exit
ROLE=api       HTTP server (default)
ROLE=worker    job loop, no port, no public surface
```

This is the whole of ADR-003 made concrete: the identical artefact runs on Cloud
Run, on a Cloudflare container, on a UNGRD VPS and on a laptop.

## Against a managed database instead of compose

```
export DATABASE_URL='postgres://…-pooler…/db?sslmode=require'   # app: pooled
export DATABASE_DIRECT_URL='postgres://…:5432/db?sslmode=require' # migrations: direct
docker run --rm -e ROLE=migrate -e DATABASE_DIRECT_URL rescue-api:dev
docker run -p 8080:8080 -e ROLE=api -e DATABASE_URL -e TOKEN_PEPPER -e IP_PEPPER rescue-api:dev
```

DDL through a transaction pooler fails in ways that waste an afternoon, which is
why the two URLs are separate.

## What is honestly not verified yet

* **No migration has been executed against a live Postgres from this
  environment** — there is no Docker daemon and no local Postgres here. The
  runner logic, the API bootstrap, the route registration, the error handler and
  the graceful shutdown were all exercised; the SQL was not. **This is precisely
  what the sanity check on your server is for.** Expect the first `make drill` to
  surface something in `0001`–`0005`.
* **The correlation numbers do not exist yet.** The test computes them; nobody
  has run it. Until then the weights in `correlation_config` and the `0.55`
  suggestion floor are my guess, and the thresholds in the test (recall ≥ 0.6,
  precision ≥ 0.5) are a regression guard, not a quality claim.
* **`media_derive` is a no-op.** No image library is on board, so blurring for
  minors and thumbnails are marked `skipped` rather than faked.
* **`export` in the worker only logs.** The synchronous export endpoint in the
  panel works; the async path is a stub.
* **The web app still reads its mock store.** Wiring it to this API is step 4.

## First thing to check on the server

```
make drill && make test
```

If `make test` prints a recall below 0.6, that is not a bug in the harness — it
means the weights need calibrating, and now we have a number to calibrate
against instead of an argument.

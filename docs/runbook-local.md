# Runbook — bringing the backend up

Everything below runs with no cloud account, no credit card and no network
beyond the image pull. That is deliberate: if the system cannot be stood up on a
laptop, our recovery story during an event is fiction.

## Prerequisites

- Docker Engine with **BuildKit** available. The API `Dockerfile` uses
  `RUN --mount=type=cache`, which requires BuildKit. On Debian/Ubuntu that means
  the `docker-buildx-plugin` (or `docker-buildx`) package must be installed —
  a plain `docker.io` install does not ship it and the build fails on the first
  `RUN --mount` line.
- Working DNS inside the Docker daemon (the build pulls from the PGDG apt repo
  and the npm registry). If image builds fail to resolve hostnames, fix the
  daemon's DNS before blaming the Dockerfile.
- Host ports 5432 and 8080 free, **or** override them. If another Postgres
  already owns 5432:

  ```
  DB_PORT=55432 make drill      # `make test` follows the same variable
  API_PORT=8081 make drill
  ```

## Database TLS

TLS is configuration, never inference. `DB_SSL` decides, `sslmode=` in the URL
is the fallback, and the default is `require`:

| Setting | Result |
|---|---|
| `DB_SSL=disable` | plaintext — what compose sets, because the dev database has no certificate |
| `DB_SSL=require` / `sslmode=require` | encrypted, chain not verified (Supabase, Neon, Cloud SQL) |
| `DB_SSL=verify-full` | encrypted, certificate chain verified |
| unset, no `sslmode` | `require` |

An unrecognised value throws at startup rather than quietly picking a mode.

## Where the extensions live

Nowhere in particular, on purpose. The `postgis/postgis` image creates PostGIS
in `public` during initdb; Supabase pre-creates it in `extensions`; on Cloud SQL
and Neon it lands wherever the operator put it. PostGIS is `relocatable = false`,
so it cannot be moved to make the environments agree.

The migrations therefore never name the schema. `0001` creates the `extensions`
schema, sets `search_path = public, extensions`, and every later file relies on
that. The same path is applied in three more places so that runtime matches
migration time:

| Where | How |
|---|---|
| migration session | `SET search_path` in the runner, before file `0001` |
| database default | `ALTER DATABASE ... SET search_path` (best effort — a managed role may not own the database) |
| API / worker pool | `options=-c search_path=...`, a startup parameter so it survives a transaction-mode pooler |

Override with `DB_SEARCH_PATH` if a provider ever puts extensions somewhere
else. `name_norm` is generated with the dictionary's real schema baked in,
because a function behind an index must not depend on the caller's path.

## The one command

```
make drill
```

Rebuild of the API image → fresh database → migrations → 500 synthetic reports
with known duplicates → API and worker up → readiness check → a real
`POST /v1/reports` → the worker queue must drain with zero failed jobs and at
least one dedup candidate. It prints `drill passed.` or it fails loudly. Takes
~1 minute on a first run (it installs the pgvector package into the PostGIS
image once — a PGDG binary, not a build).

**Why the drill rebuilds the API image first, and only that one.** `migrate`,
`seed`, `api` and `worker` all run the same `rescue-api:dev` image, and the
migrations are baked into it. A stale image therefore makes the drill test an
old checkout: one run applied migrations 0001–0006 and never saw 0007, then
failed on a queue that could not drain. The drill builds `api` explicitly.

It deliberately does **not** run a full `compose build`. The database image
installs PostGIS and pgvector from apt, so on a host whose docker build network
cannot resolve `deb.debian.org` / `apt.postgresql.org` a full build fails before
the drill even starts — for a rebuild nothing asked for. `compose up -d db`
still builds that image on demand the first time. If you do need to rebuild it
(after editing `ops/dev/Dockerfile.db`), run `make build` on a host with working
build-network DNS, or pass `--network=host` to the daemon's build.

**If `docker build` on your host cannot resolve DNS at all** (we hit this on a
systemd-resolved server), run everything with `BUILD_NETWORK=host`:

```
BUILD_NETWORK=host DB_PORT=55432 make drill
```

The default is `default`, on purpose: `network: host` is rejected by some
builders (Docker Desktop, rootless Docker), so one machine's escape hatch must
not be everyone's default. Runtime containers always use the private compose
network regardless.

## Reading `make test`

The correlation test does **not** report a single accuracy number. It scores
every pair once and then sweeps the suggestion floor from 0.35 to 0.75 over
those scores, printing:

| Field | What it means |
|---|---|
| `curve` | precision / recall / F1 at each floor. The trade-off, explicit. |
| `live` | the point the system is actually running at (`correlation_config.auto_suggest_floor`). |
| `recall_ceiling` | the share of true duplicates that reached the scorer **at all**. Anything below this is lost in *blocking* (radius, trigram floor, no phone/id overlap) and **no threshold can recover it**. |
| `blocked_truth_pairs` | how many duplicates were never scored. A blocking bug, not a tuning problem. |
| `threshold_losses` | duplicates that *were* scored and lost to the floor alone. These are free to recover — the curve says what they cost in precision. |
| `live_by_pair_type` | recall for `base-variant` (original vs re-telling) and `variant-variant` (two re-tellings, neither original). The second is harder and is what a real event produces most of; an averaged number hides it. |
| `recommended` | the highest-recall floor that still holds precision ≥ `TARGET_PRECISION` (default 0.90). |

Changing the floor is a migration against `correlation_config`, made **after**
reading a curve — never a guess. The assertions in the test are regression
guards with deliberately loose bounds; they are not a claim that the engine is
good enough to ship.

All of it is measured against **synthetic data we generated**. It measures the
engine against our own assumptions about how duplicates look. Real calibration
only starts with real reports.

## Step by step

```
make build-api  # build the shared API image (api, worker, migrate, seed)
make build      # build everything, including the dev database image
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

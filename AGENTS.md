# Working agreements for agents on this repo

Read this before changing anything. These are decisions, not preferences —
each one was made for a reason that is written down. If you think one is wrong,
open the discussion; do not silently "upgrade" it.

## Getting it running

```
git clone <repo> && cd rescue-heatmap
make drill
```

`make drill` is the whole thing from zero: clean database → migrations → 500
seeded reports with known duplicates → API + worker → readiness check → a real
`POST /v1/reports`. It must print `drill passed`. Details in
`docs/runbook-local.md`, including what is still a stub.

## Pinned versions — do not bump without checking the provider matrix

| Thing | Pinned | Why not the newest |
|---|---|---|
| PostgreSQL | **17** | 18 is GA, but Supabase does not offer it at all and Cloud SQL has it in Preview. The local image exists so the laptop behaves like the cloud; developing on a major we cannot deploy defeats it. |
| PostGIS | **3.5** | 3.6 is published for Alpine only on `postgis/postgis`; we want Debian. |
| pgvector | **0.8.6, binary package from PGDG apt** | Not compiled from source. Compiling against PG headers was the single most fragile step in the image. `test -f vector.control` fails the build if the package did not land. |
| Node | **24 (Active LTS)** | 26 is Current and only becomes LTS in Oct 2026. This tool has to run unattended for years. |

When Supabase ships 18 GA, the bump is a one-line change plus a `make drill`.

## Architecture invariants

- **One image, three roles.** `services/api/Dockerfile` builds a single image;
  `ROLE=api|worker|migrate` selects behaviour. Do not add a second image.
- **Managed Postgres is used as Postgres.** No provider SDK, no Edge Functions,
  no provider-specific auth in application code. The exit test is: `pg_dump`
  from the cloud, restore locally, tests still pass.
- **The queue is Postgres with `SKIP LOCKED`.** Not Kafka, not Redis, not a
  hosted queue.
- **Storage goes through the abstraction in `src/storage.ts`.** Nothing else in
  the codebase names a storage provider.
- **Migrations are neutral SQL, numbered, append-only.** Never edit an applied
  migration — the runner checksums them and will refuse. Never hide an ordering
  bug with `IF EXISTS`. Never patch the database by hand; fix the migration and
  reset.
- **Never schema-qualify an extension object.** Write `geography`, `vector`,
  `gin_trgm_ops` — never `extensions.geography`. Where an extension lives is the
  provider's decision: Supabase uses `extensions`, the `postgis/postgis` image
  creates PostGIS in `public` at initdb, Cloud SQL uses wherever the operator
  ran `CREATE EXTENSION`, and `postgis` is `relocatable = false` so it cannot be
  moved afterwards. The schema is put on the `search_path` instead — by `0001`,
  by the migration runner, by `ALTER DATABASE`, and by the pool's startup
  options. A function that backs an index must not depend on the caller's
  `search_path`: bake the resolved schema into it (see `name_norm` in `0001`).

- **Environment decides, code does not guess.** No behaviour is inferred from a
  hostname, a URL substring or `NODE_ENV`. TLS to the database comes from
  `DB_SSL` (or `sslmode=` in the URL) and nothing else — an earlier version
  inferred it from `localhost`, and the drill broke the moment the database was
  reached as `db` inside compose.

## Safety invariants — these are not negotiable

- **Duplicate cases are never merged automatically.** The engine proposes; a
  human approves; the decision is audited. One wrong merge means a team stops
  looking for someone who is still under the rubble.
- **Public output is location-rounded.** The public API and the public map never
  emit a precise coordinate. Listing in public search is opt-out; publishing a
  photo is opt-in. The single filter is the `public_case_view` view in `0003`
  (coarse lat/lng, no phone, no id4, no narrative) and `src/routes/public.ts`
  only ever selects from it — do not bypass it with a direct table query.
- **Sensitive actions are audited.** Deletion and anonymisation included.
- **Do not fake a stub.** `media_derive` is empty on purpose. An honest gap beats
  a pipeline that pretends to work.
- **A green drill must mean the engine ran.** `make drill` asserts that the job
  queue drained, that no job carries a `last_error`, and that the correlation
  engine produced candidates. This exists because a runtime type error in
  `correlate_case()` once left dedup completely dead while the drill printed
  `drill passed` — the HTTP path was fine and the failure lived in the worker.
- **A measurement must be reproducible, and a single number is not one.**
  `make test` sweeps the suggestion floor over one scoring pass and prints the
  precision/recall curve, the recall *ceiling* imposed by candidate generation,
  and recall split by pair type. Two rules follow: never quote one operating
  point as "the accuracy", and never tune weights against recall that blocking
  made unreachable. Nothing may run concurrently with the measured pass —
  `seed()` therefore only queues worker jobs when `SEED_ENQUEUE=1`.
- **A workaround for one machine never becomes the default for every machine.**
  Host-specific escapes go behind a variable with a neutral default
  (`BUILD_NETWORK`, `DB_PORT`) and get documented in the runbook. `network: host`
  was committed as the default for a single host's broken DNS; it is unsupported
  on other builders.
- **The drill must test the current checkout.** Migrations are baked into
  `rescue-api:dev`, which `migrate`, `seed`, `api` and `worker` all share, so
  the drill rebuilds that image first. It builds **only** `api`: rebuilding the
  database image pulls PostGIS/pgvector over apt and fails on hosts whose build
  network has no DNS — a failure that has nothing to do with the drill.

- **The browser never holds a private copy of other people's reports.** The web
  app reads the API and nothing else. No mock store, no client-side dedup, no
  reference numbers minted in the browser. A second correlation implementation
  in the client drifts from `correlate_case()`, and a client-minted reference
  prints a different number on every retry of the same report — the family
  writes down the one that does not exist. Locked by
  `test/frontend-wiring.test.ts`.
- **Write to the device before the network, and separate "no signal" from "no".**
  A submitted report is persisted in the outbox before any request. A transport
  failure retries forever; a 4xx does not, because it would resend the same
  rejected bytes. `ApiError.isOffline` / `isPermanent` exist for this and must
  not be collapsed into "the request failed".
- **The map receives aggregates, not people.** `heat_cells()` groups in SQL and
  the API never returns an individual location to a browser. Coarsening in the
  client is not coarsening: the exact coordinates would be in the network tab.
- **The public map and the command map are two components, not one with a
  prop.** `PublicMap.tsx` reads `/v1/public/*` and holds no token; `HeatMap.tsx`
  serves the panel. A single component for both audiences means one boolean
  stands between an exact case location and the open internet, and a boolean is
  one careless refactor away from being wrong. Locked by `public-map.test.ts`.
- **Aid sites are institutions, not people.** `aid_site` joins no case table and
  `public.aid_sites()` may return exact coordinates and a phone — that is the
  one place in the public API where that is allowed, and it stays that way
  because the table has no path to person data.
- **Imported data is unverified until a human stood in it.** OSM rows carry
  `source`/`source_url` and no `verified_at`, the map draws them dashed, and the
  importer never overwrites a verified row's name, address or phone.
- **One basemap provider at a time, with an ordered fallback.** Spreading tile
  requests across providers does not make you compliant with three policies, it
  makes you non-compliant with three; it also looks broken and defeats caching.
  `tile.openstreetmap.org` is last in the chain, never a default.

## Reporting

When you finish a task, report **what actually ran** and **what you assumed**
as two separate lists. If something is unverified, say so in those words.

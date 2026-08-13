# Working agreements for agents on this repo

Read this before changing anything. These are decisions, not preferences —
each one was made for a reason that is written down. If you think one is wrong,
open the discussion; do not silently "upgrade" it.

**Before you write code, read `docs/bug-ledger.md`.** It is every defect this project
has shipped or nearly shipped, grouped into seven recurring classes, with a checklist
of recurrence checks at the bottom. The rules in this file are the *conclusions*; the
ledger is the evidence, and it is the faster way to find out whether the mistake you are
about to make has already been made here. When you fix a defect, append a row to it in
the same commit.

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
- **One origin, one published http port.** `ops/edge/nginx.conf` is the only
  door: `/api/` goes to the API with the prefix stripped, everything else to the
  PWA. Neither `api` nor `web` publishes a host port, and re-publishing one is a
  regression, not a debugging convenience — the edge is where the body limit,
  the timeouts and the client-IP header are decided, and the API runs with
  `trustProxy` on, so a second way in is a client-IP spoofing hole. nginx
  **overwrites** `X-Forwarded-For` with `$remote_addr`; never append to what the
  client sent. `test/edge.test.ts` fails if any of this drifts.
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

- **The measurement runs the same engine as the field.** The shortlist size is
  `correlation_config.candidate_limit` and no caller passes a literal. The test
  once scored 50 candidates while the worker and the panel scored 25, so every
  recall number we quoted came from an engine nobody would ever run — and the
  gap opens exactly where duplicates cluster, in a crowded building. Any tuning
  knob that exists in two places will eventually hold two values. Locked by
  `test/operating-point.test.ts`.
- **A shortlist an operator cannot reproduce is not evidence.** Every ranking
  ends with a tie break (`ORDER BY score DESC, case_id`). Without one, two equal
  scores straddling the LIMIT swap between calls: the suite flaps by one pair
  with a different uuid each run, and the same case shows a different screen
  when nothing changed.
- **An operating point must sit on a plateau, not on a cliff.** "Maximise recall
  under a precision floor" on its own always picks the last point before the
  floor breaks — by construction the most fragile value on the curve. A
  threshold is only eligible if the next step down still holds its precision.
  0.525 was chosen over 0.50 for that reason, not for the three recall points.
- **When one threshold forces a bad trade, add a band — do not move the
  threshold.** Pairs above `auto_suggest_floor` enter the operator queue; pairs
  above `lead_floor` are recorded as `lead` and surface only when someone opens
  that case. Effective recall rises without the review queue absorbing the
  noise. `lead` is still undecided: nothing merges without a human, ever.
- **A weight standing on an empty column is a false claim, not a small number.**
  `w_semantic` multiplies a `sem_sim` that is always NULL while embeddings are a
  stub, which caps the achievable score at 0.95 against thresholds calibrated as
  if it were 1.0. Turn the feature on or remove the weight.
- **A new signal ships off, behind a flag, with an ablation.** Phonetic name
  matching is measured with `make ablation` — same seed, flag off and on, delta
  in both precision and recall — before anyone argues about whether it helps.
  Restore the flag afterwards: an ablation is not a deploy.
- **Do not call it BM25.** `ts_rank_cd` is not BM25, and it is a claim someone
  will check.
- **A dynamic import is only as good as the imports around it.** A page may load
  a browser-only component with `next/dynamic({ ssr: false })` and still drag it
  into the server bundle by statically importing one constant from the same
  file. `/mapa` did exactly that with `KIND_STYLE`, and prerender died on
  `window is not defined`. Shared data lives in `src/lib/`; the component file
  exports the component. `test/ssr-safety.test.ts` walks every page's static
  import graph and fails on any path to Leaflet.
- **A measurement must first prove it is measuring the right database.** When a
  drill dies before migrating, the suite that follows reports "column does not
  exist" — which reads as a broken query and is really a stale schema. Every
  DB-backed test calls `requireFreshSchema()` first: it compares
  `db/migrations` to `schema_migration` and refuses to print any number if the
  database is behind.
- **The front end fails the drill before the database is touched.** `build` runs
  ahead of `down -v` on purpose: a broken build costs a rebuild, a half-reset
  volume costs the run. Fail fast, destroy nothing.

- **A precision claim without a coordinate is a false statement, not a rounding
  error.** The intake form accepted a written address, never geocoded it, and
  still offered "punto exacto" as a precision. The payload therefore described
  a point that did not exist, the database correctly stored no geography, and
  the case dropped out of the heat map with no error raised anywhere. Rules
  that follow from it: accuracy describes a coordinate, so no coordinate means
  `unknown`; a claim may never exceed what its source supports (a geocoded
  street is a building at best, a landmark is a block); and `normaliseLocation()`
  downgrades rather than rejects, because refusing a report during an earthquake
  is the worst failure mode there is.
- **A geocoder suggests, it never assigns**, and every result is bounded to the
  incident box twice — once in the query, once locally. A point 500 km away does
  not read as an error on a map, it reads as a second collapse site.
- **Work that disappears is worse than work that fails.** A case with an address
  and no point is now a queue (`public.unmapped_case`, `/v1/panel/unmapped`),
  not an absence. The drill submits an address-only report and fails if it does
  not arrive there.
- **A case's location is chosen, never averaged.** `avg(lat), avg(lng)` across a
  case's reports puts it between a GPS fix and a neighbourhood guess — a spot no
  reporter named. Take the most precise point, latest wins ties, and an operator
  override beats all of them.
- **An operator's correction does not overwrite what a citizen said.** Staff
  points go to `case_location_override`; the report stays the account of what was
  actually reported.
- **An empty map is a failure, and nothing in a green build says so.** The seed
  sat 400 km from the viewport in `incident.ts`, and the reviewed aid-site file
  in the repo was never loaded anywhere; both layers answered 200 with an empty
  array, which is what an unaffected city looks like. Rules that follow: the
  synthetic incident is pinned to the front end's bbox by a test; a data file
  committed to the repo is not data until something loads it, so `seed` loads it
  and the image ships it; and the drill fails when either public layer is empty
  or when heat lands outside the incident box.
- **A threshold that hides data must say so on screen.** Public heat needs two
  or more cases per cell — correct, and indistinguishable from "the site is
  broken" unless the empty state explains it and confirms the report was
  received.
- **Basemaps: free tiers only.** A provider that needs a card on file needs a
  legal entity, which we do not have. Enforced in a test, not in a comment.

## Reporting

When you finish a task, report **what actually ran** and **what you assumed**
as two separate lists. If something is unverified, say so in those words.

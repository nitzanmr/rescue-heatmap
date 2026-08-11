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
  photo is opt-in. `publicView.ts` is the single filter — do not bypass it.
- **Sensitive actions are audited.** Deletion and anonymisation included.
- **Do not fake a stub.** `media_derive` is empty on purpose. An honest gap beats
  a pipeline that pretends to work.

## Reporting

When you finish a task, report **what actually ran** and **what you assumed**
as two separate lists. If something is unverified, say so in those words.

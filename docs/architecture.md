# Architecture Proposal — Backend & Infrastructure (v0.1)

**Status:** proposal, pending sign-off (Avishai / ניצן / O)
**Decision anchor:** ADR-003 in `docs/decisions.md`
**Constraint that drives everything below:** PostGIS is not negotiable (Avishai, 11 Aug 2026).

---

## 0. The three constraints, in priority order

1. **Geo-semantic dedup is the product.** Anyone can build a form and a map. The only thing
   we do that nobody else does is: same person, reported five times, from five phones, with
   five spellings, within 150 m — collapsed into one case. That needs `PostGIS` + `pg_trgm` +
   `unaccent` + `pgvector` in **one** database, so a single SQL query can combine them.
   Splitting them across services means shipping candidate sets over the network at 3 a.m.
2. **Sovereign / portable deployment.** UNGRD or the Israeli delegation may require the data
   to run on their infrastructure. Anything that only runs on one vendor's proprietary runtime
   is a dead end. **Everything that touches data runs in a container.**
3. **Zero-to-live in hours, not days.** During an event nobody provisions a VPC.
   The deploy path must be: `git push` → front-end live; `docker push` → API live.

Everything below is the cheapest architecture that satisfies all three.

---

## 1. Target architecture

```
   Browser (PWA, offline-first, IndexedDB queue)
        │
        │  static assets, SSR shell, OG card images
        ▼
   ┌──────────────────────────┐
   │  Vercel — front-end only │   Next.js. No DB client. No secrets except API base URL.
   │  + Vercel Blob (images)  │   OG/preview tags for WhatsApp cards.
   └──────────┬───────────────┘
              │  HTTPS, JSON, same-origin via rewrite  →  api.<domain>
              ▼
   ┌──────────────────────────────────────────────┐
   │  api  (container)      │  worker (container) │   SAME IMAGE, different entrypoint
   │  - intake              │  - dedup pipeline   │
   │  - public search       │  - embeddings       │
   │  - command panel API   │  - exports          │
   │  - auth / audit        │  - retention jobs   │
   └──────────┬─────────────────────┬─────────────┘
              │                     │
              ▼                     ▼
   ┌───────────────────────┐   ┌──────────────────┐
   │ PostgreSQL 16         │   │ Object storage   │
   │ + PostGIS             │   │ (Blob → S3/R2/   │
   │ + pg_trgm + unaccent  │   │  MinIO behind    │
   │ + pgvector            │   │  one interface)  │
   │ + pgbouncer / pooler  │   └──────────────────┘
   └───────────────────────┘
              │
              ▼  base backup + continuous WAL → separate bucket, separate account
```

### Why the API is not on Vercel

Not a purity argument — three concrete reasons:

- **The worker has no home there.** Embedding generation, dedup passes over the whole corpus,
  KML/GeoJSON exports and retention sweeps are minutes-long jobs. Serverless functions are the
  wrong shape for that; we would end up running a second runtime anyway.
- **Connection storms.** Every function instance opens its own DB connection. Postgres dies on
  `max_connections` long before it dies on load — precisely at the moment the form goes viral.
  A long-lived container holds a bounded pool. (A pooler is still mandatory — see §4.)
- **Portability.** The same image runs on Cloud Run, Fly, a UNGRD VPS, or Avishai's laptop.
  That is the exit path, and it costs us nothing to keep.

**Front-end stays on Vercel** — CDN, preview deploys, and painless OG tags for WhatsApp cards.
That part of Avishai's reflex is right and we keep it. The rule is one line: **Vercel renders,
containers touch data.**

---

## 2. Where each piece runs — recommendation with alternatives

| Layer | Recommended | Why | Alternative if rejected |
|---|---|---|---|
| Front-end | **Vercel** | fastest path, OG tags, free tier | Cloudflare Pages |
| API + worker | **Cloud Run** (dedicated GCP project) | container-native, scale-to-zero, ~$0 idle, deletable in one gesture | Fly.io, or a single 2 vCPU VPS with docker-compose |
| Postgres | **Neon or Supabase** to launch | PostGIS + pgvector + pg_trgm available, built-in pooler, free tier, minutes to provision | **Cloud SQL** once traffic is real or a region is mandated |
| Images | **Vercel Blob** now | ניצן's proposal, zero friction | S3 / R2 / MinIO — behind `StoragePort`, swap is one file |
| Queue | **Postgres table + `SKIP LOCKED`** | one less system; our volumes never justify Kafka | Cloud Tasks / Pub-Sub if it ever hurts |
| Backups | base backup + WAL → **separate account** | PITR; the point of a backup is surviving the blast radius | provider snapshots only (weaker) |

### On Supabase vs Cloud SQL vs Neon

ניצן proposed Cloud SQL with pgvector + PostGIS. It is the right *destination*, and I'd
disagree only about *timing*: a Cloud SQL instance burns roughly $50+/month running idle
before a single report exists, needs an Auth Proxy plus a pooler, and gives us nothing today
that Neon/Supabase doesn't. **Managed-Postgres-now, Cloud SQL-when-there-is-traffic-or-a-
region-requirement** — and the migration is `pg_dump` + a connection string, *provided* we
respect the rule below.

> **Hard rule (this is the whole point):** we use the provider as **plain managed Postgres
> only**. No Edge Functions, no `supabase-js` in the browser, no Realtime, no provider auth.
> All data access goes through our API. Lock-in then exists only in Storage, which is wrapped.

---

## 3. Data model — the parts that carry weight

```sql
CREATE EXTENSION postgis;      -- geography, KNN, radius
CREATE EXTENSION pg_trgm;      -- fuzzy Spanish names
CREATE EXTENSION unaccent;     -- José = Jose
CREATE EXTENSION vector;       -- narrative embeddings

-- one row per real human being (survives merges)
person_case      (id, status, incident_id, created_at, merged_into, public_listed)

-- one row per submission from any channel. NEVER updated in place.
report           (id, case_id, channel, payload jsonb, submitted_at, source_ref)

-- versioned field state — ניצן's "don't overwrite history" requirement
report_revision  (id, report_id, field, old_value, new_value, actor, at)

person_index     (case_id,
                  name_norm      text,          -- unaccented, sorted tokens
                  name_trgm      -- GIN trgm index
                  age_approx     int,
                  phone_e164     text,
                  last_seen      geography(Point,4326),   -- GiST
                  last_seen_at   timestamptz,
                  narrative_vec  vector(768))             -- HNSW

dedup_candidate  (a_case, b_case, score, signals jsonb, state, decided_by, decided_at)
audit_log        (id, actor, action, subject, at, ip_hash, detail jsonb)
media            (id, case_id, storage_key, mime, bytes, sha256, uploaded_at, consent_public)
sighting         (id, case_id, kind, note, geo, at, reporter_token_hash)
```

**Why the split between `report` and `person_case`:** merging duplicates must never destroy a
submission. A merge re-points `case_id`; the original rows stay, and an un-merge is possible.
This is what makes ניצן's "operator approves, decision is auditable" actually true.

---

## 4. Dedup pipeline — one query, then a model, then a human

Adopting ניצן's ordering (normalize → lexical rank → embeddings → structured signals → human),
implemented so that stages 1–3 are a **single SQL round-trip**:

> **Naming, precisely:** what runs is Postgres `ts_rank_cd`, which is **not BM25**. It has no
> document-length normalisation and no IDF saturation. Calling it BM25 is a claim someone will
> check us on, and it is not one we need — the shortlist is carried by trigram similarity and
> geography, not by the lexical rank.

```sql
-- stage 1+2: candidate shortlist, all inside Postgres
SELECT case_id,
       similarity(name_norm, $1)                                  AS name_sim,
       ts_rank_cd(fts, plainto_tsquery('spanish', $2))            AS bm25ish,
       ST_Distance(last_seen, $3::geography)                      AS metres,
       1 - (narrative_vec <=> $4)                                 AS sem_sim
FROM person_index
WHERE ST_DWithin(last_seen, $3::geography, 500)   -- GiST index does the work
   OR name_norm % $1                              -- trgm index does the work
ORDER BY name_sim DESC
LIMIT 50;
```

That query is the reason we said no to Turso. On SQLite it is a full scan plus haversine in
application code — fine at 500 rows, fatal at 50 000.

**Stage 4 — structured scoring** (weights live in config, not code):
phone exact match · `national_id_last4` · age within ±3 · distance decay · time overlap ·
reporter phone reuse. Score ≥ hard threshold → auto-link suggestion; middle band → operator
queue; below → ignore.

**Stage 5 — human.** Nothing merges automatically. Ever. Two cases and one wrong merge means
a rescue team stops looking for a person who is still under the rubble.

**Embeddings, honestly:** they are stage-2 sugar, not the core. Ship stages 1, 2 (trgm+FTS),
4 and 5 first — lexical matching alone is often enough. `pgvector` is provisioned from day one
so adding it later is an `UPDATE`, not a migration.

**Two things currently cost time and change no decision, and both should be named rather than
left to be discovered:**

- `w_semantic` (0.05) is multiplied by `sem_sim`, which is `NULL` for every row because the
  embedding service is a stub and `narrative_vec` is never written. The maximum achievable
  score is therefore 0.95, not 1.0, while every threshold was chosen as if it were 1.0. Either
  turn embeddings on or drop the weight — a weight standing on an empty column is a false
  claim in the config, not a small number.
- `lex_rank` is computed on every candidate and used in no branch of the score. It either
  enters the scoring or it comes out of the query.

**The operating point (from the first real sweep):** queue floor `0.525`, lead band down to
`0.45`. 0.50 was rejected deliberately: it buys three points of recall for four of precision
across one 0.025 step, which is a cliff, and an operating point on a cliff stops holding the
day the data changes. The shortlist size is `correlation_config.candidate_limit` and nothing
may pass a literal — the measurement and the field must run the same engine.

---

## 5. Permissions (adopting ניצן's three levels)

- **Reporter — no account.** Holds an unguessable token (`/r/<ref>`, 128-bit, `Referrer-
  Policy: no-referrer`). May update *their own* report and mark "found". Cannot list or search
  beyond the public view. Token is rate-limited and revocable.
- **Operator (rescuer).** Authenticated. Sees everything, resolves duplicates, exports.
  No separate "management" tier for now.
- **Admin.** User management, deletion/anonymisation, system operations.

Enforced **in our API**, not in the database vendor — that's what keeps the provider swappable.
Every operator/admin write, every export, every merge, every deletion → `audit_log`.

---

## 6. Retention — reconciling ADR-001 with "don't auto-delete"

These looked contradictory. They aren't, once we separate the two layers:

| Layer | Policy |
|---|---|
| **Public listing** (`/buscar`, `/r/<ref>`) | expires automatically at event end, default 30 days (ADR-001 §7) |
| **Operational record** (SAR, audit) | retained; not auto-deleted (ניצן) |
| **Photos** | shortest clock of all — public exposure ends with the listing; recommend 90-day operational retention, then delete blob and keep metadata |
| **Right to erasure** | on request: anonymise in place — name/phone/photo/exact point destroyed, case skeleton and audit trail preserved. Erasure itself is audited |

Expiry of the *public* view is what prevents the Venezuela failure mode of frozen records
living forever; retention of the *operational* record is what makes the tool defensible.

---

## 7. Open items requiring a human decision

1. **Region.** Colombia → `southamerica-east1` (São Paulo) is nearest. Citizen data on US
   soil is a hard conversation with UNGRD, and Ley 1581 speaks to it.
2. **Account ownership.** If the GCP project sits on someone's personal card it is not a
   transferable asset. Open it under an organisation now.
3. **Domain** — short, radio-readable, registered *before* an event (`adoption-playbook.md`).
4. **Photo retention window** — policy call, drives cost.

---

## 8. Migration from today's mock — four steps

1. **`StoragePort` + `ReportRepo` interfaces**, current localStorage becomes one implementation.
   No behaviour change; the app stops knowing where data lives.
2. **API container + schema + intake endpoint.** PWA writes to IndexedDB queue, flushes to API.
   Offline behaviour is unchanged — that is the whole point of the queue.
3. **Dedup worker + operator queue** in the command panel.
4. **Public search served by the API** (rate-limited, `noindex`), photos via Blob.

Steps 1 and 2 are the only ones on the critical path to a deployable system.

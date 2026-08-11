# Cost Estimate — Backend & Infrastructure

**Status:** input to ADR-003. Prices verified against vendor pricing pages and 2026 pricing
breakdowns, retrieved 11 Aug 2026. All figures USD, list price, no committed-use discounts.
Re-verify before any commitment — vendor pricing changes quarterly.

---

## 0. Price table (verified 11 Aug 2026)

| Item | Price | Source |
|---|---|---|
| Vercel Hobby | $0 (non-commercial ToS) | vercel.com/pricing |
| Vercel Pro | $20 / seat / month, **1 TB** fast data transfer included | vercel.com/pricing |
| Vercel bandwidth overage | **$0.15 / GB** after 1 TB | vercel.com/pricing |
| Vercel Blob storage | $0.023 / GB-month | vercel.com/docs/vercel-blob |
| Vercel Blob transfer | $0.05 / GB | idem |
| Vercel Blob operations | $0.40 / 1M simple, $5.00 / 1M advanced | idem |
| Neon Free | $0 — 100 CU-hours compute, 0.5 GB storage | neon.com/pricing |
| Neon Launch | **$0.106 / CU-hour**, storage $0.35 / GB-month, no monthly minimum (removed 2026) | neon.com/pricing |
| Neon Scale | $0.222 / CU-hour | idem |
| Supabase Free | $0 — 500 MB DB, pauses when idle | supabase.com/pricing |
| Supabase Pro | $25 / month base, includes $10 compute credit (= 1 Micro instance) | supabase.com/pricing |
| Supabase compute add-ons | $12 → $3,730 / month depending on size | supabase.com/pricing |
| Cloud SQL `db-f1-micro` | ~$8 / month (us-central1) — **shared core, not viable for PostGIS+pgvector** | bytebase dbcost |
| Cloud SQL 2 vCPU / 8 GB | ~$140 / month us-central1 | bytebase dbcost |
| Cloud SQL 4 vCPU / 15 GB | **$0.386 / hr ≈ $282 / month** us-central1 | cloud.google.com/sql/pricing |
| Cloud SQL — South America premium | **+20–40%** vs us-central1 | usage.ai GCP analysis |
| Cloud Run CPU | $0.000024 / vCPU-second | cloud.google.com/run/pricing |
| Cloud Run memory | $0.0000025 / GiB-second | idem |
| Cloud Run requests | $0.40 / million | idem |
| Cloud Run free tier | 180k vCPU-s + 360k GiB-s + 2M requests / month | idem |
| GCS Standard storage | $0.020 / GB-month | cloud.google.com/storage/pricing |
| **GCS egress** | **$0.12 / GB** | idem |
| Cloudflare R2 storage | **$0.015 / GB-month, egress $0** | developers.cloudflare.com/r2/pricing |
| R2 free tier | 10 GB storage, 1M Class A, 10M Class B ops / month | idem |
| OpenAI `text-embedding-3-small` | $0.02 / 1M tokens ($0.01 batch) | openai pricing |
| Domain (.org) | ~$12 / year | — |

---

## 1. Scenario A — Standby (no event). The state we live in 99% of the time.

This is the number that actually matters, because the system must sit armed and paid-for
for months before it is ever used.

| Component | Choice | Monthly |
|---|---|---|
| Front-end | Vercel Hobby (Pro if we need a team seat / commercial ToS) | $0 – $20 |
| Database | Neon Free (0.5 GB, 100 CU-h) — enough for a warm schema + smoke tests | $0 |
| API + worker | Cloud Run, **min-instances = 0**, inside free tier | ~$0 |
| Images | R2 free tier (10 GB) or Blob (pennies) | ~$0 |
| Domain | .org | ~$1 |
| Embeddings | none generated at rest | $0 |
| **Total** | | **$1 – $21 / month** |

> **The single most important cost fact in this document:** with scale-to-zero compute and a
> free-tier Postgres, standby costs approximately nothing. Any architecture that requires an
> always-on database instance converts a $1/month standby into a **$180–370/month** standby
> (Cloud SQL 4 vCPU in São Paulo), paid every month for a disaster that may not arrive this
> year. That is the argument against provisioning Cloud SQL now — not performance.

**Cold-start caveat:** min-instances = 0 means the first request after idle pays a container
cold start (~1–3 s) and a Neon compute resume (~0.5–3 s). Acceptable at 3 a.m. for report #1;
the mitigation is a $0 cron ping during an active alert, not a permanently warm instance.

---

## 2. Scenario B — Live event, moderate. 20,000 reports over 14 days.

Assumptions: 20k reports, 60% with a photo (~150 KB after on-device compression),
~500k card-image views from WhatsApp sharing, ~3M API requests, ~1.5M page views.

| Component | Calculation | Cost |
|---|---|---|
| Vercel Pro | 1 seat | $20 |
| Vercel bandwidth | ~250 GB — well inside the 1 TB included | $0 |
| Image storage | 12k photos × 150 KB ≈ **1.8 GB** | $0.03 (R2) |
| Image egress | 500k views × ~120 KB ≈ **60 GB** | **$0 on R2** / $3 on Blob / **$7.20 on GCS** |
| Neon Launch | 2 CU sustained × 24h × 14d = 672 CU-h × $0.106 | **$71** |
| Neon storage | ~10 GB × $0.35 | $3.50 |
| Cloud Run API | 3M req × 100 ms × 1 vCPU/512 MB → 300k vCPU-s, 150k GiB-s | ~$8 |
| Cloud Run requests | 3M − 2M free | $0.40 |
| Cloud Run worker | min-instances = 1 for 14 d (idle CPU rate) | ~$5 |
| Embeddings | 20k × ~120 tokens = 2.4M tokens | **$0.05** |
| **Total for the event month** | | **≈ $110 – $120** |

Two things worth naming: **embeddings are free** at our volume ($0.05 — the entire
semantic-dedup layer costs less than a coffee), and **the database is 65% of the bill.**
Cost optimisation work belongs on Postgres compute, nowhere else.

---

## 3. Scenario C — Viral peak. 100,000 reports, national radio pickup.

Assumptions: 100k reports, 5M card-image views, 30M API requests, 8M page views, 30 days.

| Component | Calculation | Cost |
|---|---|---|
| Vercel Pro | 1 seat | $20 |
| **Vercel bandwidth** | ~2.5 TB → 1.5 TB over the included 1 TB × $0.15 | **$225** ⚠️ |
| Image storage | 60k × 150 KB ≈ 9 GB | $0.14 (R2) |
| Image egress | 5M × 120 KB ≈ **600 GB** | **$0 on R2** / $30 Blob / **$72 GCS** |
| Neon Scale | 4 CU × 24 × 30 = 2,880 CU-h × $0.222 | **$639** |
| Neon storage | 40 GB | $14 |
| Cloud Run | 30M req, 3M vCPU-s, autoscaling to ~8 | ~$100 |
| Embeddings | 12M tokens | $0.24 |
| **Total** | | **≈ $1,000 / month** |

At this tier **Cloud SQL becomes the cheaper database**: a dedicated 4 vCPU / 15 GB instance
is ~$282/month in us-central1, ~$340–395 in São Paulo — roughly **half** of Neon Scale at
sustained full load. Serverless Postgres wins on idle; dedicated wins on sustained load.
This is exactly why the architecture says *"managed Postgres to launch, Cloud SQL when there
is traffic"* — and why the exit path must be a `pg_dump`, not a rewrite.

---

## 4. Where the money actually leaks — three findings

**1. Egress, not storage.** Storage is rounding error at every tier. Delivery is not.
The same 600 GB of shared cards costs **$0 on R2, $30 on Vercel Blob, $72 on GCS**.
GCS egress ($0.12/GB) is the single most expensive line item per GB in the whole stack.
Recommendation: **R2 for images, not GCS and not Blob** — zero egress is precisely the right
shape for a product whose success metric *is* mass image sharing. It also keeps ניצן's
requirement intact: it is S3-compatible, so the storage abstraction is unchanged.
Blob stays a legitimate day-one choice (it is one line of code); it just should not be the
thing serving 5M card views.

**2. Vercel bandwidth is the uncapped tail risk.** $225 in scenario C, and it scales linearly
with exactly the virality we are trying to engineer. Mitigations, in order: serve card images
and photos from R2 (not through Vercel), keep the report page static and cacheable, and
**set a spend limit on the Vercel project before launch.** A viral humanitarian tool with an
unmetered credit card attached is a foreseeable failure mode.

**3. The database is 60–65% of every bill.** Which means the compute sizing decision —
and nothing else — is the budget conversation.

---

## 5. Recommendation

| Phase | Database | Compute | Images | Monthly |
|---|---|---|---|---|
| **Standby (now → event)** | Neon Free | Cloud Run, min = 0 | R2 free tier | **~$1–21** |
| **Active event** | Neon Launch, 2 CU | Cloud Run autoscale | R2 | **~$110** |
| **Sustained / post-event** | Cloud SQL 4 vCPU, São Paulo | Cloud Run | R2 | **~$450–500** |

**Answer to ניצן's budget question:** we do not need a budget to start. Standing this up
today costs **about a dollar a month plus a domain**, and the first real event costs
**roughly $110** — well inside what one person can absorb on a personal card without a
conversation. What *does* need a decision before an event is a **spend cap and a named
account owner**, because the failure mode is not a $50 surprise, it is a $1,000 one on a
personal card at 3 a.m. — and a project registered to a personal card is an asset that
cannot be handed to UNGRD or to a local NGO later.

**What this changes in the architecture proposal:** one thing only — **images move from
Vercel Blob / GCS to Cloudflare R2** (or at minimum, the storage abstraction defaults to R2
in production). Everything else in ADR-003 survives the cost analysis unchanged.

---

## Addendum — "Would Supabase cover what we need?" (11 Aug 2026)

**Capability: yes, fully.** Supabase is plain managed Postgres. All four extensions we
depend on are pre-installed and enable-able with one SQL statement: `postgis`,
`pgvector`, `pg_trgm`, `unaccent` (plus `pg_cron`, `pgaudit`). Supavisor gives us the
connection pooler that Cloud Run needs. S3-compatible Storage means the storage
interface from ADR-003 works unchanged if we prefer to keep images there instead of R2.

**The one disqualifying detail for the standby posture: Free-plan projects are paused
after 7 days of inactivity** and must be manually restored. Our product spends 99% of its
life idle, waiting for a disaster. A paused database at 03:00 on event night is a cold
start measured in human minutes, not milliseconds. Neon's scale-to-zero suspends and
resumes automatically (~350 ms–3 s) and never requires a human. **This, not price, is why
the standby database is Neon and not Supabase Free.**

**Supabase Pro removes the pause** at $25/month base (includes $10 compute credit ≈ one
Micro instance, 8 GB DB, 250 GB egress, spend cap ON by default). PITR is a $100/month
add-on — relevant to Nitzan's WAL/point-in-time requirement, and materially more than
Neon's included branch/restore window.

**Recommendation (unchanged architecture, refined provider choice):**
- Standby: **Neon Free** — auto-resume, no pause, $0.
- Event: either provider works; Supabase Pro at $25 + compute is competitive with Neon
  Launch (~$75) if we want managed backups and Storage in the same bill.
- If we ever want PITR before real traffic exists, Supabase Pro + PITR ($125/mo) is the
  cheapest turnkey path; self-managed WAL archiving to object storage is cheaper but is
  ops work we do not currently have.
- Constraint from ADR-003 stands either way: **provider used as Postgres only** — no
  Edge Functions, no supabase-js in the browser, no Supabase Auth. Exit = `pg_dump` +
  connection string.

Egress reference: Supabase $0.09/GB uncached beyond 250 GB — vs **$0 on R2**. If images
are served from Supabase Storage, the viral scenario adds ~$54 that R2 gives for free.
Images stay on R2.

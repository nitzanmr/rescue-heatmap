# Infrastructure as code — how the two halves fit

**Verified against provider docs on 11 Aug 2026.**

There are two layers and they are provisioned by different tools. Mixing them is the
most common way people get burned with Supabase + Terraform.

## Layer 1 — the platform (Terraform)

`supabase/supabase` provider, v1.x, official. Resources it actually offers:

| Resource | We use it |
|---|---|
| `supabase_project` | yes — org, name, region, db password, instance size |
| `supabase_settings` | yes — API/db settings as JSON |
| `supabase_branch` | maybe — preview branches per PR |
| `supabase_apikey` | yes — publishable/secret keys |
| `supabase_edge_function`, `supabase_third_party_auth` | **no** (ADR-003 forbids both) |
| data sources | `apikeys`, `branch`, `pooler`, `network_bans` |

What it does **not** offer, and this is the important part:

- no resource for **extensions** (`postgis`, `pgvector`, `pg_trgm`, `unaccent`)
- no resource for **tables, indexes, roles, RLS policies**
- no resource for **PITR / add-ons / compute size beyond `instance_size`**
- no resource for **Storage buckets**

So "provision the whole product from a schema, automatically" is **half true**:
Terraform creates an empty Postgres in the right region with the right size; it cannot
create our schema.

## Layer 2 — the schema (migrations)

Plain, numbered SQL files in `db/migrations/`, applied by a runner over the connection
string that Terraform outputs. Options, in order of preference:

1. **`supabase db push`** (Supabase CLI) — same file format, works in CI, no extra dep.
2. **`golang-migrate` / `atlas`** — vendor-neutral. Preferred if we ever move to Cloud SQL
   or a UNGRD server, because the exact same files apply to any Postgres 16.

Recommendation: numbered SQL + a vendor-neutral runner. It keeps the ADR-003 exit path
honest — the schema must not depend on Supabase existing.

## The whole flow

```
terraform apply          # empty project, right region, right size   (~2 min)
make db-migrate          # extensions + schema + indexes             (~10 s)
make seed-drill          # optional synthetic data for drills
docker push + deploy     # API/worker container
```

Target: **cold to live in under 15 minutes, executed by one person at 3 a.m.**
That is the real reason for doing this, not elegance.

## Rules

- **State is remote and encrypted.** It contains the DB password. Never local, never git.
- **`prevent_destroy` on the database project.** Non-negotiable.
- **One workspace per environment** — `standby`, `drill`, `event`. Same code, different
  tfvars. `instance_size` is the only meaningful difference on standby vs event.
- **A drill is a real test:** `terraform apply` into a fresh project, migrate, seed, hit
  the API, then destroy. If that fails, our recovery story is fiction.

## Caveats found while checking

- `supabase_project` creation is slow and occasionally times out — the resource exposes
  `timeouts`; set `create = "20m"`.
- Changing `region` or `database_password` forces replacement of the project. With
  `prevent_destroy` that means a manual, deliberate operation. Good.
- The pooler connection string (port 6543, Supavisor) is what Cloud Run must use.
  Direct port 5432 will exhaust `max_connections` under burst — the failure mode already
  flagged in `docs/architecture.md` §4.
- Neon has **no official** Terraform provider — two community ones exist
  (`kislerdm/neon`, `terraform-community-providers/neon`). If IaC is a hard requirement,
  that is a real point in Supabase's favour, and it partly offsets the free-tier pause
  problem raised earlier.

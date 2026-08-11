###############################################################################
# rescue-heatmap — infrastructure as code (proposal, ADR-004)
#
# What Terraform owns:  the *containers* — Supabase project, Vercel project,
#                       Cloud Run services, R2 bucket, DNS.
# What Terraform does NOT own:  the SQL schema, extensions, roles, RLS.
#                       Those live in db/migrations/ and are applied by
#                       `make db-migrate` (see ops/infra/README.md).
#
# Rule from ADR-003 still holds: the provider is plain managed Postgres.
# Nothing here provisions Edge Functions, provider Auth, or Realtime.
###############################################################################

terraform {
  required_version = ">= 1.9"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State holds the DB password. Never local, never in git.
  # backend "gcs" { bucket = "rescue-heatmap-tfstate" prefix = "infra" }
}

provider "supabase" {
  # env: SUPABASE_ACCESS_TOKEN (personal access token, scoped to the org)
}

variable "env" {
  description = "standby | drill | event"
  type        = string
  default     = "standby"
}

variable "supabase_org" {
  description = "Organization slug from the Supabase dashboard"
  type        = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "region" {
  description = "Closest region to Colombia. sa-east-1 = Sao Paulo."
  type        = string
  default     = "sa-east-1"
}

###############################################################################
# 1. Database project
###############################################################################

resource "supabase_project" "db" {
  organization_id   = var.supabase_org
  name              = "rescue-heatmap-${var.env}"
  database_password = var.db_password
  region            = var.region

  # micro on standby; bump to small/medium from a tfvars file during an event.
  instance_size = var.env == "event" ? "small" : "micro"

  # ADR-003: no browser SDK, no provider auth → no legacy anon/service keys.
  legacy_api_keys_enabled = false

  lifecycle {
    # A humanitarian database must not be destroyable by a stray plan.
    prevent_destroy = true
  }
}

resource "supabase_settings" "db" {
  project_ref = supabase_project.db.id

  # We speak SQL from our own API only. PostgREST stays reachable for the
  # dashboard but is not part of the contract.
  api = jsonencode({
    db_schema            = "public"
    db_extra_search_path = "public,extensions"
    max_rows             = 1000
  })
}

###############################################################################
# 2. Object storage for photos — Cloudflare R2 (zero egress, S3-compatible)
###############################################################################

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "rescue-heatmap-media-${var.env}"
  location   = "WNAM"
}

variable "cloudflare_account_id" {
  type    = string
  default = ""
}

###############################################################################
# 3. Outputs consumed by the API container and by CI
###############################################################################

output "project_ref" {
  value = supabase_project.db.id
}

output "database_url" {
  value     = "postgresql://postgres.${supabase_project.db.id}:${var.db_password}@aws-0-${var.region}.pooler.supabase.com:6543/postgres"
  sensitive = true
  # Port 6543 = Supavisor transaction pooler. Cloud Run must use this, never 5432.
}

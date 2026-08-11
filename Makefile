# One entry point for the whole stack. The target that matters is `drill`:
# from an empty machine to a running system with data, in one command.
.PHONY: help up down migrate seed test ablation build build-api build-web logs psql drill reset fresh web operator-token

COMPOSE ?= docker compose
# Host port for the dev database. Override when 5432 is already taken:
#   DB_PORT=55432 make drill
DB_PORT ?= 5432
export DB_PORT
# Build-time network for the API image. Leave it alone unless `docker build`
# on this host cannot resolve DNS; then: BUILD_NETWORK=host make drill
BUILD_NETWORK ?= default
export BUILD_NETWORK
DB_URL  ?= postgres://rescue:rescue@localhost:$(DB_PORT)/rescue

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build:   ## Build every image (api + the dev database image)
	$(COMPOSE) build

build-api: ## Build only the shared API image (api, worker, migrate, seed)
	$(COMPOSE) build api

build-web: ## Build only the web (PWA) image
	$(COMPOSE) build web

up:      ## Start db + api + worker + web (migrations run first, automatically)
	$(COMPOSE) up -d db
	$(COMPOSE) run --rm migrate
	$(COMPOSE) up -d api worker web
	@echo "API on http://localhost:$${API_PORT:-8080}  ->  /healthz  /readyz  /v1/meta"
	@echo "Web on http://localhost:$${WEB_PORT:-3000}  ->  /reportar  /buscar  /panel"

web:     ## Start only the PWA (assumes the API is already up)
	$(COMPOSE) up -d web
	@echo "Web on http://localhost:$${WEB_PORT:-3000}"

# Operators authenticate with a token minted here, never with a password typed
# into a browser: there is no login endpoint, on purpose.
#   make operator-token EMAIL=ana@ungrd.gov.co ROLE=admin
operator-token: ## Mint an operator token for /panel (EMAIL=..., ROLE=operator|admin)
	@test -n "$(EMAIL)" || (echo "EMAIL=... is required"; exit 1)
	@# The image entrypoint is tini; the args below become tini's command, so this
	@# stays a normal `tini -- node dist/operator.js` and signals still work.
	$(COMPOSE) run --rm -e OPERATOR_EMAIL=$(EMAIL) -e OPERATOR_ROLE=$${ROLE:-operator} \
	  -e OPERATOR_DAYS=$${DAYS:-7} migrate node dist/operator.js

down:    ## Stop everything, keep the data
	$(COMPOSE) down

migrate: ## Apply pending migrations
	$(COMPOSE) run --rm migrate

seed:    ## Synthetic incident with known duplicates (SEED_CASES=500)
	$(COMPOSE) run --rm seed

# Aid sites (shelters, hospitals, pharmacies, responders) for the public map.
# Two steps on purpose: PULL writes a GeoJSON a human reviews and commits, LOAD
# puts a reviewed file into the database. An activation with no outbound network
# still has the layer, because the file is in the repo.
#   make aid-sites-pull BBOX=5.55,-76.80,5.85,-76.55 OUT=data/aid-sites/quibdo-co.geojson
#   make aid-sites-load FILE=data/aid-sites/quibdo-co.geojson COUNTRY=CO
aid-sites-pull: ## Pull aid sites from OpenStreetMap into a GeoJSON file (BBOX=s,w,n,e OUT=...)
	@test -n "$(BBOX)" || (echo "BBOX=south,west,north,east is required"; exit 1)
	cd services/api && npm run aid-sites -- --bbox $(BBOX) --out ../../$${OUT:-../../data/aid-sites/sites.geojson}

aid-sites-load: ## Load a reviewed GeoJSON of aid sites into the database (FILE=... COUNTRY=CO)
	@test -n "$(FILE)" || (echo "FILE=data/aid-sites/....geojson is required"; exit 1)
	cd services/api && DATABASE_URL=$(DB_URL) DB_SSL=disable \
	  npm run aid-sites -- --file ../../$(FILE) --country $${COUNTRY:-CO} --load

test:    ## Correlation precision/recall against seeded ground truth
	cd services/api && DATABASE_URL=$(DB_URL) DB_SSL=disable npm test

# Phonetic name matching is the only proposed answer to duplicate-vs-duplicate
# recall, and it ships OFF. This scores the same seed twice, with the flag off
# and on, and prints the difference -- including what it costs in precision.
# It restores the flag to whatever it found. Enabling it is a separate decision,
# taken after reading this output.
ablation: ## Measure what phonetic name matching buys (does not enable it)
	cd services/api && DATABASE_URL=$(DB_URL) DB_SSL=disable ABLATION=1 npm test

logs:    ## Tail api + worker
	$(COMPOSE) logs -f api worker

psql:    ## Interactive shell on the dev database
	$(COMPOSE) exec db psql -U rescue -d rescue

# The drill from ops/drill-checklist.md: nothing, to a working system, to nothing.
# If this fails, our recovery story is fiction. Run it before an event, not during.
drill:   ## Full rehearsal: fresh db -> migrate -> seed -> smoke test
	@# Build the API image FIRST, and only that one. migrate/seed/api/worker all
	@# run rescue-api:dev, so a stale image means the drill silently tests an old
	@# checkout -- that is how a run applied 0001-0006 and never saw 0007.
	@# Only `build api`: the db image installs PostGIS/pgvector from apt, and a
	@# host whose docker build network cannot resolve deb.debian.org would fail
	@# here for no reason. `up -d db` builds it on demand when it is missing.
	$(COMPOSE) build api web
	$(COMPOSE) down -v
	$(COMPOSE) up -d db
	$(COMPOSE) run --rm migrate
	$(COMPOSE) run --rm seed
	$(COMPOSE) up -d api worker
	@sleep 4
	@curl -fsS http://localhost:$${API_PORT:-8080}/readyz && echo "" || (echo "READY CHECK FAILED"; exit 1)
	@curl -fsS -X POST http://localhost:$${API_PORT:-8080}/v1/reports \
	  -H 'content-type: application/json' \
	  -d '{"full_name":"Prueba Simulacro Perez Garcia","incident_slug":"drill-bogota","last_seen_lat":4.6533,"last_seen_lng":-74.0836,"location_accuracy":"building","status":"missing"}' \
	  && echo "" || (echo "INTAKE FAILED"; exit 1)
	@# The front end is part of the system, not a demo beside it. The drill now
	@# proves the browser-facing tier can actually reach the API through its own
	@# /api proxy -- a web container that boots but cannot talk to the backend is
	@# exactly the failure this repo shipped with for weeks.
	$(COMPOSE) up -d web
	@echo "waiting for the web tier..."
	@ok=0; for i in $$(seq 1 45); do \
	  if curl -fsS http://localhost:$${WEB_PORT:-3000}/api/readyz >/dev/null 2>&1; then ok=1; break; fi; \
	  sleep 2; \
	done; \
	if [ "$$ok" != "1" ]; then echo "WEB -> API PROXY FAILED"; $(COMPOSE) logs --tail 50 web; exit 1; fi
	@echo "web -> api proxy ok"
	@# End to end through the front door: submit a report the way a phone does,
	@# then read it back through the public card endpoint the shared link uses.
	@ref=$$(curl -fsS -X POST http://localhost:$${WEB_PORT:-3000}/api/v1/reports \
	  -H 'content-type: application/json' \
	  -d '{"full_name":"Simulacro Web Ramirez Mosquera","incident_slug":"drill-bogota","last_seen_lat":4.6540,"last_seen_lng":-74.0840,"location_accuracy":"building","status":"missing","consent_public_listing":true}' \
	  | sed -n 's/.*"reference_number":"\([^"]*\)".*/\1/p'); \
	if [ -z "$$ref" ]; then echo "WEB INTAKE FAILED"; exit 1; fi; \
	echo "web intake ok: $$ref"; \
	curl -fsS "http://localhost:$${WEB_PORT:-3000}/api/v1/public/cases/$$ref" >/dev/null \
	  || (echo "PUBLIC CARD FAILED FOR $$ref"; exit 1); \
	curl -fsS "http://localhost:$${WEB_PORT:-3000}/r/$$ref" | grep -q "Simulacro Web" \
	  || (echo "SHARED CARD PAGE DID NOT RENDER THE CASE"; exit 1); \
	echo "public card + shared page ok"
	@# The intake above only proves the HTTP path. The correlation engine runs in
	@# the worker, so a broken correlate_case() lands in job.last_error and the
	@# drill still printed "drill passed" over a dead dedup engine. It did, once.
	@echo "waiting for the worker to drain the queue..."
	@ok=0; for i in $$(seq 1 30); do \
	  pending=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	    "SELECT count(*) FROM job WHERE done_at IS NULL" 2>/dev/null | tr -d '[:space:]'); \
	  if [ "$$pending" = "0" ]; then ok=1; break; fi; sleep 2; \
	done; \
	if [ "$$ok" != "1" ]; then echo "QUEUE DID NOT DRAIN"; \
	  $(COMPOSE) exec -T db psql -U rescue -d rescue -c "SELECT * FROM job_health"; exit 1; fi
	@failed=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT count(*) FROM job WHERE last_error IS NOT NULL" | tr -d '[:space:]'); \
	if [ "$$failed" != "0" ]; then \
	  echo "WORKER JOBS FAILED ($$failed):"; \
	  $(COMPOSE) exec -T db psql -U rescue -d rescue -c \
	    "SELECT kind, attempts, left(last_error,200) AS last_error FROM job WHERE last_error IS NOT NULL LIMIT 10"; \
	  exit 1; fi
	@# The dedup engine must have proposed something against the seeded truth.
	@cands=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT count(*) FROM dedup_candidate" | tr -d '[:space:]'); \
	if [ "$${cands:-0}" -lt 1 ]; then \
	  echo "NO DEDUP CANDIDATES - the correlation engine produced nothing"; exit 1; fi; \
	echo "dedup candidates: $$cands"
	@# Bands, not one number. A 'lead' is below the queue floor on purpose; if one
	@# ever lands in the operator queue the two bands have crossed and the queue is
	@# quietly absorbing the noise the split exists to keep out.
	@$(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT state || ': ' || count(*) FROM dedup_candidate GROUP BY state ORDER BY state"
	@bad=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT count(*) FROM dedup_candidate d, correlation_config c \
	    WHERE c.id=1 AND ((d.state='lead' AND d.score >= c.auto_suggest_floor) \
	                   OR (d.state='pending' AND d.score < c.auto_suggest_floor))" \
	  | tr -d '[:space:]'); \
	if [ "$${bad:-1}" != "0" ]; then \
	  echo "BAND VIOLATION: $$bad candidates are in the wrong band"; exit 1; fi; \
	echo "dedup bands ok"
	@# Nothing may be decided without a human. The drill runs unattended, so any
	@# state beyond the two undecided ones means the machine merged something.
	@decided=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT count(*) FROM dedup_candidate WHERE state NOT IN ('pending','lead')" \
	  | tr -d '[:space:]'); \
	if [ "$${decided:-1}" != "0" ]; then \
	  echo "AUTO-DECIDED $$decided CANDIDATES WITHOUT AN OPERATOR"; exit 1; fi
	@echo "drill passed."

reset:   ## Drop the database volume (LOCAL DEV DATA ONLY)
	$(COMPOSE) down -v

fresh: reset up ## reset + up

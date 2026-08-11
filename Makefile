# One entry point for the whole stack. The target that matters is `drill`:
# from an empty machine to a running system with data, in one command.
.PHONY: help up down migrate seed test ablation build build-api build-web logs logs-edge psql drill reset fresh web operator-token

COMPOSE ?= docker compose
# Host port for the dev database. Override when 5432 is already taken:
#   DB_PORT=55432 make drill
DB_PORT ?= 5432
export DB_PORT
# Build-time network for the API image. Leave it alone unless `docker build`
# on this host cannot resolve DNS; then: BUILD_NETWORK=host make drill
BUILD_NETWORK ?= default
export BUILD_NETWORK
# The ONE published http port: the edge (nginx). The PWA is at / and the API at
# /api on the same origin. Override when 8080 is taken: EDGE_PORT=8090 make up
EDGE_PORT ?= 8080
export EDGE_PORT
EDGE_URL ?= http://localhost:$(EDGE_PORT)
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
	$(COMPOSE) up -d api worker web edge
	@echo "One origin: $(EDGE_URL)"
	@echo "  web  $(EDGE_URL)/         ->  /reportar  /buscar  /panel  /mapa"
	@echo "  api  $(EDGE_URL)/api/     ->  /api/readyz  /api/v1/meta"

web:     ## Start only the PWA + edge (assumes the API is already up)
	$(COMPOSE) up -d web edge
	@echo "Web on $(EDGE_URL)"

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

logs-edge: ## Tail the edge (nginx) access log -- which tier a request went to
	$(COMPOSE) logs -f edge

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
	$(COMPOSE) up -d api worker edge
	@sleep 4
	@# The edge answers this itself: "the front door is open" is a different
	@# question from "the API is ready", and confusing the two costs an hour.
	@curl -fsS $(EDGE_URL)/edge-health >/dev/null || (echo "EDGE NOT LISTENING"; \
	  $(COMPOSE) logs --tail 50 edge; exit 1)
	@curl -fsS $(EDGE_URL)/api/readyz && echo "" || (echo "READY CHECK FAILED"; exit 1)
	@curl -fsS -X POST $(EDGE_URL)/api/v1/reports \
	  -H 'content-type: application/json' \
	  -d '{"full_name":"Prueba Simulacro Perez Garcia","incident_slug":"drill-bogota","last_seen_lat":4.6533,"last_seen_lng":-74.0836,"location_accuracy":"building","status":"missing"}' \
	  && echo "" || (echo "INTAKE FAILED"; exit 1)
	@# The front end is part of the system, not a demo beside it, and since the
	@# edge went in there is exactly one address for both tiers. The drill proves
	@# that address serves BOTH: a page from the web container and /api from the
	@# API container. A web container that boots but cannot be reached through
	@# the front door is the same silent failure as one that cannot reach the API.
	$(COMPOSE) up -d web
	@echo "waiting for the web tier behind the edge..."
	@ok=0; for i in $$(seq 1 45); do \
	  if curl -fsS $(EDGE_URL)/reportar >/dev/null 2>&1; then ok=1; break; fi; \
	  sleep 2; \
	done; \
	if [ "$$ok" != "1" ]; then echo "EDGE -> WEB FAILED"; \
	  $(COMPOSE) logs --tail 50 edge web; exit 1; fi
	@echo "edge -> web ok (same origin as /api)"
	@# End to end through the front door: submit a report the way a phone does,
	@# then read it back through the public card endpoint the shared link uses.
	@ref=$$(curl -fsS -X POST $(EDGE_URL)/api/v1/reports \
	  -H 'content-type: application/json' \
	  -d '{"full_name":"Simulacro Web Ramirez Mosquera","incident_slug":"drill-bogota","last_seen_lat":4.6540,"last_seen_lng":-74.0840,"location_accuracy":"building","status":"missing","consent_public_listing":true}' \
	  | sed -n 's/.*"reference_number":"\([^"]*\)".*/\1/p'); \
	if [ -z "$$ref" ]; then echo "WEB INTAKE FAILED"; exit 1; fi; \
	echo "web intake ok: $$ref"; \
	curl -fsS "$(EDGE_URL)/api/v1/public/cases/$$ref" >/dev/null \
	  || (echo "PUBLIC CARD FAILED FOR $$ref"; exit 1); \
	curl -fsS "$(EDGE_URL)/r/$$ref" | grep -q "Simulacro Web" \
	  || (echo "SHARED CARD PAGE DID NOT RENDER THE CASE"; exit 1); \
	echo "public card + shared page ok"
	@# A report whose place is only a sentence. This is the case that used to be
	@# lost in silence: the form let a family label a typed address "exact", no
	@# geocoding ever happened, the database correctly stored no geography, and
	@# the person never reached the map with nothing anywhere raising an error.
	@# The drill now proves three things about it: it is ACCEPTED, its precision
	@# claim is DOWNGRADED to unknown, and it lands in the operator queue.
	@aref=$$(curl -fsS -X POST $(EDGE_URL)/api/v1/reports \
	  -H 'content-type: application/json' \
	  -d '{"full_name":"Simulacro Sin Punto Benson","incident_slug":"drill-bogota","last_seen_address":"Cra 1 con Calle 24, casa azul","location_accuracy":"exact","status":"missing"}' \
	  | sed -n 's/.*"reference_number":"\([^"]*\)".*/\1/p'); \
	if [ -z "$$aref" ]; then echo "ADDRESS-ONLY INTAKE REJECTED"; exit 1; fi; \
	echo "address-only intake ok: $$aref"
	@bad=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT count(*) FROM person_index pi JOIN person_case pc ON pc.id=pi.case_id \
	    WHERE pc.reference_number IS NOT NULL AND pi.name_raw LIKE 'Simulacro Sin Punto%' \
	      AND NOT (pi.last_seen IS NULL AND pi.location_accuracy='unknown' AND pi.location_source='none')" \
	  | tr -d '[:space:]'); \
	if [ "$${bad:-1}" != "0" ]; then \
	  echo "PRECISION CLAIMED WITHOUT A POINT - the location invariant is broken"; exit 1; fi
	@q=$$($(COMPOSE) exec -T db psql -U rescue -d rescue -tAc \
	  "SELECT count(*) FROM public.unmapped_case WHERE name_raw LIKE 'Simulacro Sin Punto%'" \
	  | tr -d '[:space:]'); \
	if [ "$${q:-0}" -lt 1 ]; then \
	  echo "UNMAPPED CASE DID NOT REACH THE OPERATOR QUEUE - it was lost silently"; exit 1; fi; \
	echo "unmapped queue ok"
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

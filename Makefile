# One entry point for the whole stack. The target that matters is `drill`:
# from an empty machine to a running system with data, in one command.
.PHONY: help up down migrate seed test build logs psql drill reset fresh

COMPOSE ?= docker compose
# Host port for the dev database. Override when 5432 is already taken:
#   DB_PORT=55432 make drill
DB_PORT ?= 5432
export DB_PORT
DB_URL  ?= postgres://rescue:rescue@localhost:$(DB_PORT)/rescue

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build:   ## Build the API image (same image runs api, worker and migrations)
	$(COMPOSE) build

up:      ## Start db + api + worker (migrations run first, automatically)
	$(COMPOSE) up -d db
	$(COMPOSE) run --rm migrate
	$(COMPOSE) up -d api worker
	@echo "API on http://localhost:$${API_PORT:-8080}  ->  /healthz  /readyz  /v1/meta"

down:    ## Stop everything, keep the data
	$(COMPOSE) down

migrate: ## Apply pending migrations
	$(COMPOSE) run --rm migrate

seed:    ## Synthetic incident with known duplicates (SEED_CASES=500)
	$(COMPOSE) run --rm seed

test:    ## Correlation precision/recall against seeded ground truth
	cd services/api && DATABASE_URL=$(DB_URL) DB_SSL=disable npm test

logs:    ## Tail api + worker
	$(COMPOSE) logs -f api worker

psql:    ## Interactive shell on the dev database
	$(COMPOSE) exec db psql -U rescue -d rescue

# The drill from ops/drill-checklist.md: nothing, to a working system, to nothing.
# If this fails, our recovery story is fiction. Run it before an event, not during.
drill:   ## Full rehearsal: fresh db -> migrate -> seed -> smoke test
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
	@echo "drill passed."

reset:   ## Drop the database volume (LOCAL DEV DATA ONLY)
	$(COMPOSE) down -v

fresh: reset up ## reset + up

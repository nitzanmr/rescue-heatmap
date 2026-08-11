# Multi-stage build. Node 24 LTS (Active LTS as of Aug 2026; Node 26 is Current
# and does not become LTS until October) on Debian trixie. One image runs the API, the worker and the migrations —
# the whole point of ADR-003: the same artefact on Cloud Run, on a UNGRD VPS and
# on a laptop, selected by ROLE at run time.
#
#   docker build -t rescue-api -f services/api/Dockerfile .      (context = repo root)
#   docker run -e ROLE=migrate -e DATABASE_URL=... rescue-api
#   docker run -e ROLE=api -p 8080:8080 -e DATABASE_URL=... rescue-api

# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json* ./
# npm ci when a lockfile exists (reproducible), npm install when it does not.
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY services/api/package.json services/api/tsconfig.json ./
COPY services/api/src ./src
RUN npm run build

# Production dependencies only — the runtime image carries no TypeScript.
FROM node:24-trixie-slim AS prod-deps
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production \
    ROLE=api \
    PORT=8080 \
    HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/db/migrations \
    NODE_OPTIONS="--enable-source-maps"

# tini: PID 1 must reap children and forward SIGTERM, or Cloud Run's 10-second
# shutdown window becomes a hard kill mid-transaction.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist         ./dist
COPY services/api/package.json          ./package.json
# Migrations ship inside the image: the artefact that runs is the artefact that
# knows its own schema. No "which branch were the migrations from" at 3 a.m.
COPY db/migrations ./db/migrations

# Non-root, and a writable media dir for STORAGE_DRIVER=fs.
RUN mkdir -p /data/media && chown -R node:node /data /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "if(process.env.ROLE&&process.env.ROLE!=='api')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

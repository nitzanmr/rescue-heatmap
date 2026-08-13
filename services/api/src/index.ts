// Bootstrap. One image, three roles, chosen by the ROLE env var:
//   ROLE=api      -> HTTP server        (default)
//   ROLE=worker   -> job loop only      (no port, no public surface)
//   ROLE=migrate  -> run migrations and exit
// This is what makes ADR-003 real: the same artefact runs on Cloud Run, on a
// UNGRD VPS and on a laptop, and nothing but the environment changes.
import "./types.js";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { config, assertConfig } from "./config.js";
import { pool, query } from "./db.js";
import { HttpError, resolveActor, hashIp, clientIp } from "./security.js";
import { systemAudit } from "./audit.js";
import intakeRoutes from "./routes/intake.js";
import reporterRoutes from "./routes/reporter.js";
import panelRoutes from "./routes/panel.js";
import publicRoutes from "./routes/public.js";
import structureRoutes from "./routes/structures.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Trust the proxy in front of us (Cloud Run / Cloudflare / nginx) so that
    // rate limiting keys on the real client and not on the load balancer.
    trustProxy: true,
    bodyLimit: config.limits.photoMaxBytes + 1024 * 1024,
    disableRequestLogging: true,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Never log a body: a body here is a frightened family's private data.
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "body", "req.body"],
        remove: true,
      },
    },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    credentials: false,
    maxAge: 600,
  });
  await app.register(multipart, {
    limits: { fileSize: config.limits.photoMaxBytes, files: 1 },
  });

  // -------------------------------------------------------------------------
  // Identity, resolved once per request. Failure to resolve is never fatal:
  // an unknown token degrades to anonymous, it does not reject the request.
  // -------------------------------------------------------------------------
  app.decorateRequest("actor", null as any);
  app.addHook("preHandler", async (req) => {
    try {
      req.actor = await resolveActor(req);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "actor resolution failed");
      req.actor = { kind: "anon", ipHash: hashIp(clientIp(req)) };
    }
  });

  // Access log without PII: method, route (not the URL — refs and tokens live
  // in URLs), status, duration.
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      method: req.method,
      route: (req as any).routeOptions?.url ?? "unmatched",
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      actor: req.actor?.kind,
    });
  });

  // -------------------------------------------------------------------------
  // Errors. HttpError is intentional and shaped; anything else is a bug and the
  // client learns nothing about it.
  // -------------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      // Details first: a refusal's payload explains the rule (e.g. who is still
      // unresolved inside a structure), but it must never be able to overwrite
      // the code or the message the client keys on.
      return reply.code(err.status).send({
        ...(err.details ?? {}),
        error: err.code,
        message: err.message,
      });
    }
    if ((err as any).statusCode === 429) {
      return reply.code(429).send({ error: "rate_limited", message: "too many requests" });
    }
    if ((err as any).code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.code(413).send({ error: "too_large", message: "photo too large" });
    }
    req.log.error({ err: err.message, stack: err.stack }, "unhandled error");
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: "not_found", message: "no such endpoint" });
  });

  // -------------------------------------------------------------------------
  // Health. /healthz is liveness (process up), /readyz touches the database:
  // Cloud Run must not send traffic to an instance whose pool is dead.
  // -------------------------------------------------------------------------
  app.get("/healthz", async () => ({ ok: true, role: config.role }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await query("SELECT 1");
      return { ok: true, db: "up" };
    } catch (err) {
      reply.code(503);
      return { ok: false, db: "down", message: (err as Error).message };
    }
  });
  app.get("/v1/meta", async () => {
    const rows = await query<{ slug: string; name: string; ref_prefix: string }>(
      `SELECT slug, name, ref_prefix FROM incident WHERE ended_at IS NULL
        ORDER BY started_at DESC LIMIT 5`
    );
    return { version: process.env.APP_VERSION ?? "dev", incidents: rows };
  });

  await app.register(intakeRoutes);
  await app.register(reporterRoutes);
  await app.register(panelRoutes);
  await app.register(publicRoutes);
  await app.register(structureRoutes);

  return app;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
async function main() {
  assertConfig();

  if (config.role === "migrate") {
    const { runMigrations } = await import("./migrate.js");
    await runMigrations();
    await pool.end();
    return;
  }

  if (config.role === "worker") {
    const { runWorker } = await import("./worker.js");
    await runWorker();
    return;
  }

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  await systemAudit("service.start", { role: config.role, port: config.port }).catch(() => {});

  // Graceful shutdown: Cloud Run gives us 10s after SIGTERM. Finish in-flight
  // requests, then close the pool — a half-written report is worse than a slow one.
  const stop = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

// Only run when executed directly, so tests can import buildServer().
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: err.message, stack: err.stack }));
    process.exit(1);
  });
}

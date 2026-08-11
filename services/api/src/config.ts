// Configuration. Everything comes from the environment: the same image must run
// on Cloud Run, on a UNGRD VPS and on a laptop with no code change.
function num(v: string | undefined, d: number) {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

// TLS to the database is a deployment fact, not something to infer from a
// hostname. Precedence: DB_SSL env -> sslmode= in the URL -> require.
// "require" is the default on purpose: a managed provider that forgot the
// parameter must still get an encrypted link, and a local stack says so out
// loud in docker-compose.yml (DB_SSL=disable).
export type SslOption = false | { rejectUnauthorized: boolean };

export function sslFor(url: string, envValue = process.env.DB_SSL): SslOption {
  const fromEnv = (envValue ?? "").trim().toLowerCase();
  const mode = fromEnv || sslModeFromUrl(url) || "require";
  switch (mode) {
    case "disable":
    case "off":
    case "false":
    case "0":
    case "allow":
    case "prefer":
      return false;
    case "require":
    case "on":
    case "true":
    case "1":
      // Providers (Supabase, Neon, Cloud SQL) present certs from CAs the image
      // does not carry; encryption without chain verification is what libpq's
      // sslmode=require means too.
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
    case "verify":
    case "strict":
      return { rejectUnauthorized: true };
    default:
      throw new Error(`invalid DB_SSL/sslmode value: ${mode}`);
  }
}

function sslModeFromUrl(url: string): string | "" {
  const m = /[?&]sslmode=([^&]+)/i.exec(url ?? "");
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  role: (process.env.ROLE ?? "api") as "api" | "worker" | "migrate",
  port: num(process.env.PORT, 8080),
  host: process.env.HOST ?? "0.0.0.0",

  db: {
    // Use the POOLER connection string (port 6543 on Supabase / -pooler on Neon).
    // Direct 5432 is only for migrations. See ops/infra/README.md.
    url: process.env.DATABASE_URL ?? "",
    directUrl: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? "",
    // Small pools on purpose: many container instances x large pool = max_connections
    // exhaustion exactly when the form goes viral.
    max: num(process.env.DB_POOL_MAX, 8),
    statementTimeoutMs: num(process.env.DB_STATEMENT_TIMEOUT_MS, 8000),
    // Where extension objects live is a provider fact, so it is configuration.
    // public first (postgis image, Cloud SQL), extensions second (Supabase).
    searchPath: (process.env.DB_SEARCH_PATH ?? "public,extensions").replace(/\s+/g, ""),
    ssl: process.env.DB_SSL,
  },

  // Rotating these invalidates every reporter link, so treat them as durable secrets.
  secrets: {
    tokenPepper: process.env.TOKEN_PEPPER ?? "",
    ipPepper: process.env.IP_PEPPER ?? "",
  },

  storage: {
    driver: (process.env.STORAGE_DRIVER ?? "memory") as "memory" | "s3" | "fs",
    bucket: process.env.STORAGE_BUCKET ?? "rescue-media",
    endpoint: process.env.STORAGE_ENDPOINT ?? "", // R2: https://<acct>.r2.cloudflarestorage.com
    region: process.env.STORAGE_REGION ?? "auto",
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL ?? "",
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
    rootDir: process.env.STORAGE_ROOT_DIR ?? "/data/media",
  },

  limits: {
    intakePerHour: num(process.env.RL_INTAKE_PER_HOUR, 20),
    searchPerMinute: num(process.env.RL_SEARCH_PER_MINUTE, 30),
    sightingPerHour: num(process.env.RL_SIGHTING_PER_HOUR, 30),
    publicPageSize: num(process.env.PUBLIC_PAGE_SIZE, 20),
    // No "show everything" endpoint. A public list is a scrapeable list.
    publicMaxOffset: num(process.env.PUBLIC_MAX_OFFSET, 200),
    photoMaxBytes: num(process.env.PHOTO_MAX_BYTES, 3 * 1024 * 1024),
  },

  retention: {
    publicDays: num(process.env.PUBLIC_RETENTION_DAYS, 30),
    mediaDays: num(process.env.MEDIA_RETENTION_DAYS, 90),
  },

  corsOrigins: (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim()),
  worker: {
    concurrency: num(process.env.WORKER_CONCURRENCY, 2),
    pollMs: num(process.env.WORKER_POLL_MS, 1000),
  },
};

export function assertConfig() {
  const missing: string[] = [];
  if (!config.db.url) missing.push("DATABASE_URL");
  if (config.env === "production") {
    if (!config.secrets.tokenPepper) missing.push("TOKEN_PEPPER");
    if (!config.secrets.ipPepper) missing.push("IP_PEPPER");
    if (config.corsOrigins.includes("*")) missing.push("CORS_ORIGINS (must not be * in production)");
  }
  if (missing.length) throw new Error(`missing configuration: ${missing.join(", ")}`);
}

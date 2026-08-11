import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { one, query } from "./db.js";

// ---------------------------------------------------------------------------
// Tokens. We store sha256(pepper + token) and never the token itself: a database
// leak must not hand an attacker every family's private link.
// ---------------------------------------------------------------------------
export function newToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url"); // 128-bit
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(config.secrets.tokenPepper + token).digest("hex");
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(config.secrets.ipPepper + ip).digest("hex").slice(0, 32);
}

// Human-readable reference: no ambiguous characters, readable over a bad phone line.
//
// LENGTH IS A COLLISION BUDGET, NOT A COSMETIC CHOICE.
// This was 4 characters = 32^4 ≈ 1.05M references. At 1,000 cases in one
// incident, the chance that SOME pair collides is already ~38% (birthday, not
// per-insert), and the seed hit it on the first real run against a live
// database. Intake survives it because it retries on clash; anything that
// inserts without retrying just dies. 6 characters = 32^6 ≈ 1.07 BILLION, which
// keeps the per-insert clash below one in a million at 10,000 cases, and
// "DRL-A3K9F2" is still six characters read out loud over a bad line.
// Existing 4-character references stay valid: nothing parses the length.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const REFERENCE_LENGTH = 6;
export function newReference(prefix: string): string {
  const b = crypto.randomBytes(REFERENCE_LENGTH);
  let s = "";
  for (let i = 0; i < REFERENCE_LENGTH; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return `${prefix}-${s}`;
}

// ---------------------------------------------------------------------------
// Identity attached to a request.
// ---------------------------------------------------------------------------
export type Actor =
  | { kind: "anon"; ipHash: string }
  | { kind: "reporter"; caseId: string; tokenHash: string; ipHash: string }
  | { kind: "operator"; userId: string; role: "operator" | "admin"; email: string; ipHash: string };

export function actorLabel(a: Actor): string {
  if (a.kind === "operator") return `operator:${a.userId}`;
  if (a.kind === "reporter") return `reporter:${a.tokenHash.slice(0, 12)}`;
  return `anon:${a.ipHash.slice(0, 12)}`;
}

export function clientIp(req: FastifyRequest): string {
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.ip || "0.0.0.0";
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim();
}

export async function resolveActor(req: FastifyRequest): Promise<Actor> {
  const ipHash = hashIp(clientIp(req));
  const tok = bearer(req);
  if (!tok) return { kind: "anon", ipHash };
  const th = hashToken(tok);

  const session = await one<{ user_id: string; role: "operator" | "admin"; email: string }>(
    `SELECT s.user_id, u.role, u.email
       FROM user_session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.disabled_at IS NULL`,
    [th]
  );
  if (session) {
    return { kind: "operator", userId: session.user_id, role: session.role, email: session.email, ipHash };
  }

  const rt = await one<{ case_id: string }>(
    `UPDATE reporter_token SET last_used_at = now(), use_count = use_count + 1
      WHERE token_hash = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING case_id`,
    [th]
  );
  if (rt) return { kind: "reporter", caseId: rt.case_id, tokenHash: th, ipHash };

  return { kind: "anon", ipHash };
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export function requireOperator(actor: Actor) {
  if (actor.kind !== "operator") throw new HttpError(401, "authentication required", "unauthorized");
  return actor;
}

export function requireAdmin(actor: Actor) {
  const op = requireOperator(actor);
  if (op.role !== "admin") throw new HttpError(403, "admin role required", "forbidden");
  return op;
}

// ---------------------------------------------------------------------------
// Rate limiting in Postgres. No Redis: one less system, and the limit must hold
// across container instances, which an in-memory counter cannot do.
// ---------------------------------------------------------------------------
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<void> {
  const rows = await query<{ count: number }>(
    `INSERT INTO rate_bucket (key, window_at, count)
     VALUES ($1, date_trunc('second', now()), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_bucket.window_at < now() - make_interval(secs => $2)
                    THEN 1 ELSE rate_bucket.count + 1 END,
       window_at = CASE WHEN rate_bucket.window_at < now() - make_interval(secs => $2)
                    THEN now() ELSE rate_bucket.window_at END
     RETURNING count`,
    [key, windowSec]
  );
  if ((rows[0]?.count ?? 0) > limit) {
    throw new HttpError(429, "too many requests", "rate_limited");
  }
}

// Public pages must never be indexed: an event ends, the traces must not outlive it.
export function noIndex(reply: FastifyReply) {
  reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cache-Control", "no-store");
}

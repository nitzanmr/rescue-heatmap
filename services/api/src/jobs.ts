import { query, one } from "./db.js";

export type JobKind =
  | "correlate"        // build the dedup shortlist for one case
  | "index_refresh"    // rebuild person_index for one case
  | "embed"            // narrative -> pgvector (stage 2, off by default)
  | "export"           // CSV / KML / GeoJSON for SAR
  | "retention"        // expire public listings, purge media
  | "media_derive";    // blurred derivative for minors, thumbnails

// The queue is a Postgres table with SKIP LOCKED. One less system to run at
// 3 a.m., and the enqueue is in the same transaction as the write that caused it.
export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown> = {},
  dedupeKey?: string,
  runAfterSec = 0
): Promise<void> {
  await query(
    `INSERT INTO job (kind, payload, dedupe_key, run_after)
     VALUES ($1,$2,$3, now() + make_interval(secs => $4))
     ON CONFLICT (dedupe_key) WHERE done_at IS NULL AND dedupe_key IS NOT NULL
     DO UPDATE SET payload = EXCLUDED.payload`,
    [kind, JSON.stringify(payload), dedupeKey ?? null, runAfterSec]
  );
}

export interface Job {
  id: number;
  kind: JobKind;
  payload: any;
  attempts: number;
  max_attempts: number;
}

export async function claim(workerId: string): Promise<Job | null> {
  return one<Job>(
    `UPDATE job SET locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id = (
        SELECT id FROM job
         WHERE done_at IS NULL AND locked_at IS NULL AND run_after <= now()
           AND attempts < max_attempts
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
    RETURNING id, kind, payload, attempts, max_attempts`,
    [workerId]
  );
}

export async function finish(id: number) {
  await query(`UPDATE job SET done_at = now(), locked_at = NULL WHERE id = $1`, [id]);
}

export async function fail(job: Job, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  // Exponential backoff, capped. A failing job must not spin the CPU during an event.
  const delay = Math.min(2 ** job.attempts * 5, 900);
  await query(
    `UPDATE job SET locked_at = NULL, locked_by = NULL, last_error = $2,
            run_after = now() + make_interval(secs => $3),
            done_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
      WHERE id = $1`,
    [job.id, msg.slice(0, 500), delay]
  );
}

// Locks left behind by a container that was killed mid-job.
export async function reapStaleLocks(olderThanSec = 300): Promise<number> {
  const rows = await query<{ n: string }>(
    `WITH x AS (
       UPDATE job SET locked_at = NULL, locked_by = NULL
        WHERE done_at IS NULL AND locked_at < now() - make_interval(secs => $1)
        RETURNING 1)
     SELECT count(*)::text AS n FROM x`,
    [olderThanSec]
  );
  return Number(rows[0]?.n ?? 0);
}

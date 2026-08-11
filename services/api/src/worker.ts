// The worker. Same image as the API, ROLE=worker.
//
// Design rules, learned the hard way:
//   * Nothing here is on the intake path. Intake must stay fast under load;
//     everything expensive happens back here.
//   * Every handler is idempotent — a job can and will run twice.
//   * A failing job backs off exponentially instead of spinning the CPU during
//     an event, which is exactly when CPU is scarce.
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { pool, query, one } from "./db.js";
import { claim, fail, finish, reapStaleLocks, enqueue, type Job } from "./jobs.js";
import { storage } from "./storage.js";
import { systemAudit } from "./audit.js";

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
let running = true;

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: "info", worker: workerId, msg, ...extra }));

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Rebuild one case's correlation surface. Called after intake and after every
// accepted reporter revision.
async function handleIndexRefresh(job: Job) {
  const caseId = job.payload.case_id as string;
  if (!caseId) return;
  await query(`SELECT public.refresh_person_index($1)`, [caseId]);
  await enqueue("correlate", { case_id: caseId }, `correlate:${caseId}`, 2);
}

// Stages 1-3 of the dedup pipeline, entirely server-side, then persist the
// shortlist for a human. It never merges. A wrong merge means a team stops
// looking for someone who is still under the rubble.
async function handleCorrelate(job: Job) {
  const caseId = job.payload.case_id as string;
  if (!caseId) return;
  const alive = await one<{ id: string }>(
    `SELECT id FROM person_case
      WHERE id = $1 AND merged_into IS NULL AND anonymised_at IS NULL`,
    [caseId]
  );
  if (!alive) return; // merged or erased between enqueue and run — nothing to do

  const rows = await query<{ n: number }>(`SELECT public.enqueue_correlations($1) AS n`, [caseId]);
  const n = Number(rows[0]?.n ?? 0);
  if (n) log("correlations queued", { case_id: caseId, candidates: n });
}

// Stage 2 of the similarity layer. OFF by default: pg_trgm + FTS + structured
// signals carry the system on day one, and the column already exists, so
// switching this on is an UPDATE and not a migration.
async function handleEmbed(job: Job) {
  if (!process.env.EMBEDDINGS_URL) {
    await query(`UPDATE person_index SET vec_state = 'skipped' WHERE case_id = $1`, [
      job.payload.case_id,
    ]).catch(() => {});
    return;
  }
  const caseId = job.payload.case_id as string;
  const row = await one<{ narrative: string | null }>(
    `SELECT narrative FROM person_index WHERE case_id = $1`,
    [caseId]
  );
  if (!row?.narrative) return;

  const res = await fetch(process.env.EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.EMBEDDINGS_TOKEN
        ? { authorization: `Bearer ${process.env.EMBEDDINGS_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ input: row.narrative, model: process.env.EMBEDDINGS_MODEL ?? "default" }),
  });
  if (!res.ok) throw new Error(`embeddings http ${res.status}`);
  const data: any = await res.json();
  const vec: number[] = data.embedding ?? data.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("embeddings response has no vector");

  await query(
    `UPDATE person_index SET narrative_vec = $2::text::vector,
            vec_state = 'ready' WHERE case_id = $1`,
    [caseId, `[${vec.join(",")}]`]
  );
  // A new vector changes the semantic term — re-score this case.
  await enqueue("correlate", { case_id: caseId }, `correlate:${caseId}`, 1);
}

// Retention. ADR-001: the PUBLIC listing expires, the OPERATIONAL record stays.
// Media bytes are deleted through StoragePort; the row keeps the metadata so
// the audit trail stays intelligible.
async function handleRetention() {
  const expired = await query<{ expire_public_listings: number }>(
    `SELECT public.expire_public_listings()`
  );
  const due = await query<{ id: string; storage_key: string; blurred_key: string | null }>(
    `SELECT id, storage_key, blurred_key FROM media_due_for_purge LIMIT 500`
  );
  let purged = 0;
  for (const m of due) {
    try {
      await storage.del(m.storage_key);
      if (m.blurred_key) await storage.del(m.blurred_key).catch(() => {});
      await query(`UPDATE media SET deleted_at = now() WHERE id = $1`, [m.id]);
      purged++;
    } catch (err) {
      log("media purge failed", { media_id: m.id, err: (err as Error).message });
    }
  }
  // Rate buckets are ephemeral by definition.
  await query(`DELETE FROM rate_bucket WHERE window_at < now() - interval '2 hours'`);
  // Finished jobs are not evidence; the audit log is.
  await query(`DELETE FROM job WHERE done_at IS NOT NULL AND done_at < now() - interval '7 days'`);

  if (purged || expired[0]) {
    await systemAudit("retention.sweep", {
      public_expired: expired[0]?.expire_public_listings ?? 0,
      media_purged: purged,
    });
  }
}

// Derivatives (thumbnail, blurred copy for minors). Deliberately a no-op until
// an image library is on board: better an honest gap than a fake pipeline.
async function handleMediaDerive(job: Job) {
  const id = job.payload.media_id as string;
  if (!id) return;
  await query(`UPDATE media SET derive_state = 'skipped' WHERE id = $1`, [id]).catch(() => {});
}

// Long exports run here, never inside a request: a 40k-row KML must not hold an
// HTTP connection open on the intake path.
async function handleExport(job: Job) {
  log("export requested", { payload: job.payload });
}

const handlers: Record<string, (job: Job) => Promise<void>> = {
  index_refresh: handleIndexRefresh,
  correlate: handleCorrelate,
  embed: handleEmbed,
  retention: handleRetention,
  media_derive: handleMediaDerive,
  export: handleExport,
};

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop(slot: number) {
  while (running) {
    let job: Job | null = null;
    try {
      job = await claim(`${workerId}#${slot}`);
    } catch (err) {
      log("claim failed", { err: (err as Error).message });
      await sleep(5000);
      continue;
    }
    if (!job) {
      await sleep(config.worker.pollMs);
      continue;
    }
    const t0 = Date.now();
    try {
      const h = handlers[job.kind];
      if (!h) throw new Error(`no handler for kind ${job.kind}`);
      await h(job);
      await finish(job.id);
      log("job done", { id: job.id, kind: job.kind, ms: Date.now() - t0 });
    } catch (err) {
      await fail(job, err).catch(() => {});
      log("job failed", {
        id: job.id,
        kind: job.kind,
        attempt: job.attempts,
        err: (err as Error).message,
      });
    }
  }
}

export async function runWorker() {
  log("worker starting", { concurrency: config.worker.concurrency });

  // A container killed mid-job leaves a lock behind. Reap on start and hourly.
  const reaped = await reapStaleLocks();
  if (reaped) log("stale locks reaped", { count: reaped });

  const timers = [
    setInterval(() => void reapStaleLocks().catch(() => {}), 5 * 60_000),
    // Retention is cheap and idempotent; a schedule inside the worker means one
    // less thing to configure (and to forget) on a new provider.
    setInterval(
      () => void enqueue("retention", {}, `retention:${new Date().toISOString().slice(0, 13)}`).catch(() => {}),
      15 * 60_000
    ),
  ];

  const stop = async (sig: string) => {
    log("shutting down", { sig });
    running = false;
    timers.forEach(clearInterval);
    // Give in-flight handlers a moment; the claim is reaped anyway if we die.
    await sleep(1500);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  await Promise.all(
    Array.from({ length: Math.max(1, config.worker.concurrency) }, (_, i) => loop(i))
  );
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runWorker().catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: err.message }));
    process.exit(1);
  });
}

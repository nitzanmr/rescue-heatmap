-- 0006_worker.sql — the small amount of schema the worker loop needs that the
-- earlier files did not anticipate. Idempotent.

-- Derivative state for media (thumbnail / blurred copy for minors). Tracked in
-- a column rather than inferred from blurred_key IS NULL, so a permanent failure
-- is distinguishable from "not attempted yet" — otherwise the queue retries
-- forever against a corrupt JPEG during an event.
ALTER TABLE media
  ADD COLUMN IF NOT EXISTS derive_state text NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS media_derive_pending
  ON media (derive_state) WHERE derive_state = 'pending' AND deleted_at IS NULL;

-- Housekeeping index: the retention sweep deletes finished jobs by age, and
-- during an event `job` is the busiest table in the database.
CREATE INDEX IF NOT EXISTS job_done_at ON job (done_at) WHERE done_at IS NOT NULL;

-- Convenience view for the operator panel and for the drill: is the queue
-- keeping up, or are we accumulating work we will never catch up on?
CREATE OR REPLACE VIEW job_health AS
SELECT kind,
       count(*) FILTER (WHERE done_at IS NULL AND locked_at IS NULL)             AS waiting,
       count(*) FILTER (WHERE done_at IS NULL AND locked_at IS NOT NULL)         AS running,
       count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts)      AS dead,
       max(now() - run_after) FILTER (WHERE done_at IS NULL)                     AS oldest_wait
FROM job
GROUP BY kind;

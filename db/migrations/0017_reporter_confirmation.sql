-- 0017_reporter_confirmation.sql — the `sumar` click stops being an orphan.
--
-- What existed before this migration: the form's dedup modal ("¿Es la misma
-- persona?") let a second reporter say "yes, same person" — and then threw the
-- answer away in three separate ways:
--
--   1. The signal was ORPHANED. The click attached a generic sighting note to
--      the EXISTING case ("otra persona reporta a la misma persona") with no
--      link to the new report — which could not exist yet, because the new
--      report was still sitting in the device's offline outbox and the server
--      only issues an id on arrival. An operator reading the note could not
--      tell which new report it referred to.
--   2. The ENGINE was blind to it. A human said "these are the same person" —
--      the strongest dedup signal this system will ever receive — and
--      correlate_case() recomputed name similarity from scratch as if nobody
--      had spoken.
--   3. It always bound to the FIRST candidate. The modal showed up to three
--      matches and silently attached the note to hits[0], even when the
--      reporter meant the second.
--
-- The fix moves the confirmation INTO the report payload (`confirmed_same_as`,
-- a reference number the reporter chose from the modal), so it travels through
-- the offline queue with everything else and there is no timing problem: when
-- the report is accepted, intake calls link_reporter_confirmation() below and
-- the pair is created with both real ids.
--
-- What this migration must NOT do, stated before the code so the code can be
-- checked against it: it must never merge. A second reporter's confirmation is
-- a strong CLAIM by a stranger, and the architecture rule stands — nothing
-- merges without a human (ניצן, 13.8: "אין לו הרשאה לאחד... צריך שבן אנוש
-- יעבור ויאשר"). The confirmation puts the pair in the operator queue with a
-- floor score and a visible badge. The operator still decides.
--
-- Append-only. Idempotent. Nothing already applied is edited.

SET LOCAL search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1 · The badge is a COLUMN, not only a key in the signals blob.
--
-- Why both: enqueue_correlations' upsert replaces the signals blob whenever the
-- engine later produces a stronger view of the same pair (0013: "the signals
-- must explain the score that is stored"). A confirmation that lived only in
-- the blob would be silently erased by the very next correlation pass. The
-- column cannot be erased by a score update; the blob copy is refreshed by the
-- upsert below so the panel keeps seeing it either way.
-- ---------------------------------------------------------------------------
ALTER TABLE dedup_candidate
  ADD COLUMN IF NOT EXISTS reporter_confirmed boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2 · link_reporter_confirmation — called by intake AFTER the new case exists.
--
-- Returns false instead of raising on every failure path: a wrong or stale
-- reference number must never bounce the report it rode in on. The report is
-- already accepted by the time this runs; the link is best-effort by design.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_reporter_confirmation(p_new_case uuid, p_ref text)
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  c        correlation_config%ROWTYPE;
  v_new    person_case%ROWTYPE;
  v_target person_case%ROWTYPE;
BEGIN
  SELECT * INTO c FROM correlation_config WHERE id = 1;

  SELECT * INTO v_new FROM person_case WHERE id = p_new_case;
  IF v_new.id IS NULL THEN RETURN false; END IF;

  -- The reference must resolve INSIDE the same incident. A reference number is
  -- only unique per incident (0001), and a cross-incident link would pair two
  -- unrelated events.
  SELECT * INTO v_target
    FROM person_case
   WHERE incident_id = v_new.incident_id
     AND reference_number = upper(trim(p_ref))
     AND merged_into IS NULL
     AND anonymised_at IS NULL
     AND id <> p_new_case;
  IF v_target.id IS NULL THEN RETURN false; END IF;

  -- The pair enters the operator queue at auto_suggest_floor — never below it,
  -- so a human sees it, and never at 1.0, because a stranger's certainty is not
  -- the system's. If the engine already scored the pair higher, the higher
  -- score stands (GREATEST); a pair a human already decided on keeps its state.
  INSERT INTO dedup_candidate
    (incident_id, a_case, b_case, score, signals, state, reporter_confirmed)
  VALUES
    (v_new.incident_id,
     LEAST(p_new_case, v_target.id), GREATEST(p_new_case, v_target.id),
     c.auto_suggest_floor,
     jsonb_build_object('reporter_confirmed', true),
     'pending', true)
  ON CONFLICT (a_case, b_case) DO UPDATE
    SET score              = GREATEST(dedup_candidate.score, EXCLUDED.score),
        signals            = dedup_candidate.signals
                             || jsonb_build_object('reporter_confirmed', true),
        reporter_confirmed = true,
        state              = CASE WHEN dedup_candidate.state IN ('pending','lead')
                                  THEN 'pending'
                                  ELSE dedup_candidate.state END;

  -- The note on the existing case now names the NEW report. This is what the
  -- old client-side note could not do — the new reference did not exist when
  -- the click happened. Here both cases are real rows.
  INSERT INTO sighting (case_id, kind, note, source, trust)
  VALUES (v_target.id, 'correction',
          'Quien reportó el caso ' || v_new.reference_number ||
          ' confirmó en el formulario que se trata de la misma persona. ' ||
          'Pendiente de revisión por un operador.',
          'public', 'unverified');

  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3 · enqueue_correlations — 0013 with ONE change: when the stronger incoming
--     view replaces the signals blob, a confirmed pair keeps its
--     reporter_confirmed key. Without this, the panel's explanation of the
--     score would lose the one signal a human contributed the moment the
--     engine re-scored the pair.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_correlations(p_case uuid)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  c correlation_config%ROWTYPE;
  n int := 0;
BEGIN
  SELECT * INTO c FROM correlation_config WHERE id = 1;

  INSERT INTO dedup_candidate (incident_id, a_case, b_case, score, signals, state)
  SELECT (SELECT incident_id FROM person_case WHERE id = p_case),
         LEAST(p_case, r.case_id), GREATEST(p_case, r.case_id),
         r.score, r.signals,
         CASE WHEN r.score >= c.auto_suggest_floor THEN 'pending' ELSE 'lead' END
  FROM public.correlate_case(p_case) r          -- limit comes from config
  WHERE r.score >= c.lead_floor
  ON CONFLICT (a_case, b_case) DO UPDATE
    SET score   = GREATEST(dedup_candidate.score, EXCLUDED.score),
        -- The signals travel with the score they explain (0013) — but the
        -- reporter's confirmation is not the engine's to discard: re-attach it
        -- to whichever blob wins.
        signals = (CASE WHEN EXCLUDED.score > dedup_candidate.score
                        THEN EXCLUDED.signals ELSE dedup_candidate.signals END)
                  || CASE WHEN dedup_candidate.reporter_confirmed
                          THEN jsonb_build_object('reporter_confirmed', true)
                          ELSE '{}'::jsonb END,
        state   = CASE
                    WHEN dedup_candidate.state NOT IN ('pending','lead')
                      THEN dedup_candidate.state
                    WHEN GREATEST(dedup_candidate.score, EXCLUDED.score)
                         >= c.auto_suggest_floor THEN 'pending'
                    -- A confirmed pair never slips back below the queue.
                    WHEN dedup_candidate.reporter_confirmed THEN 'pending'
                    ELSE 'lead'
                  END
    WHERE dedup_candidate.state IN ('pending','lead');

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

# Getting the external registry into YOUR database

Run these on the machine that runs Docker (Nitzan's). Every variable goes
BEFORE `make` — these are environment variables, not make arguments.

Prerequisites: `git pull` (migrations 0014/0015/0016 are new), `python3`.

---

## 0. Bring the stack up (applies pending migrations)

    make up

Do NOT run `make drill` — it does `down -v` and deletes the database, including
any reports testers entered.

## 0b. Deal with the synthetic drill data FIRST

`make seed` wrote ~500 invented people into the `drill-quibdo` incident. They
sit in the same tables, with the same columns, and produce the same heat cells
as real cases. Import 5,000 real names next to them and every number the tool
prints afterwards is a blend of a collapsed building and a rehearsal — and the
public map, asked for no slug, answers with **the most recent open incident**,
which today is the drill.

See what is actually in there:

    make census

Then pick one:

**A — retire it (reversible, recommended while testers are still poking):**

    SLUG=drill-quibdo make retire

Sets `ended_at`. The synthetic incident stops being the default incident and
drops off the public map, but the rows survive and `make test` /
`make ablation` still have their ground truth. Undo: set `ended_at = NULL`.

**B — purge it (irreversible, before anything goes to a field team):**

    SLUG=drill-quibdo CONFIRM=yes make purge

Deletes the incident and everything under it — cases, reports, sightings,
dedup queue, merge ledger, nominations — in one transaction, and drops
`seed_truth` so no later test can quietly score itself against dangling ids.
Aid sites are detached, never deleted: a hospital exists before the earthquake.

Run `make census` again afterwards. A half-purged incident is worse than an
untouched one, because the remainder looks like real data.

> Reseeding later is one command (`make seed`), so B costs nothing but the
> testers' own reports — check with them first if they entered any.

## 1. Harvest the registry into a file

    OUT=data/external/ctb-full.ndjson make harvest

~5k rows, a few minutes, polite concurrency. Writes a file only. Nothing
touches the database, no photos are fetched. Re-run any time to refresh.

## 2. See what you got, before importing anything

    FILE=data/external/ctb-full.ndjson make places       # resolution histogram
    FILE=data/external/ctb-full.ndjson make places-top    # structures by headcount

Read-only, no database.

## 3. Create a REAL incident to import into

Do not import third-party rows into `drill-quibdo` — that incident is synthetic
and mixing them makes every later number a lie.

    SLUG=sismo-choco-2026 NAME="Sismo Chocó 2026" LAT=4.8133 LNG=-75.6906 make incident

(Defaults centre on Pereira. `PREFIX=CTB` sets the reference prefix.)

## 4. Dry-run the import, then load

    INCIDENT=sismo-choco-2026 make import            # counts only, writes nothing
    INCIDENT=sismo-choco-2026 LOAD=1 make import     # writes

Each row lands as a case + a report, plus an `external_case` row holding the
source, their public code (`CTB-…`), the direct URL back to the original page,
their status and the raw payload. Re-running updates instead of duplicating
(unique on source + source_ref). `forget_external_source('colombiatebusca')`
removes the whole source again if a takedown ever arrives.

## 5. Build the review queue of structures

    INCIDENT=sismo-choco-2026 LOAD=1 make nominate

One PENDING nomination per structure, with the spellings it folded, so a human
can reject a bad merge. Still no coordinates.

## 6. Ask the geocoder, keep it as a suggestion

    INCIDENT=sismo-choco-2026 TOP=40 LOAD=1 make geocode

Writes into the `cand_*` columns only. The map cannot read those. A signed
human approval is what puts a point on a map.

## 7. Check it landed

    make psql

    select count(*) from external_case;
    select label, municipality, case_count, status from place_nomination
      order by case_count desc limit 20;

---

## The front end still says Quibdó

`app/web/src/lib/incident.ts` is the one file activation edits, and it is still
filled in for the drill: centre and zoom on Quibdó, a bbox of
`5.60..5.79 / -76.74..-76.58`, six invented landmarks, and `NEXT_PUBLIC_DEMO`
defaulting to on. The registry data is Pereira and Cali — **500 km outside that
bbox**. Until this file is updated the map opens on an empty jungle and the
location picker rejects every real point.

This is deliberate mock configuration, not a bug, but it has to be changed in
the same breath as the import — otherwise the demo banner is the only thing
still telling the truth.

## Photos

**Not imported, by design.** The scraper never downloads or stores images —
faces are the highest-risk field we could hold and nothing in the pipeline uses
them. What we do keep is the link to the original page, so anyone reviewing a
name can open it and see the photo and contact details at the source instead of
in our database.

If a field team ever needs faces on a printed sheet, the honest way is to fetch
them at print time from the source URL, not to build a face database.

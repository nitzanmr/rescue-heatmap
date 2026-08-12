# Getting the external registry into YOUR database

Run these on the machine that runs Docker (Nitzan's). Every variable goes
BEFORE `make` — these are environment variables, not make arguments.

Prerequisites: `git pull` (migrations 0014/0015/0016 are new), `python3`.

---

## 0. Bring the stack up (applies pending migrations)

    make up

Do NOT run `make drill` — it does `down -v` and deletes the database, including
any reports testers entered.

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

## Photos

**Not imported, by design.** The scraper never downloads or stores images —
faces are the highest-risk field we could hold and nothing in the pipeline uses
them. What we do keep is the link to the original page, so anyone reviewing a
name can open it and see the photo and contact details at the source instead of
in our database.

If a field team ever needs faces on a printed sheet, the honest way is to fetch
them at print time from the source URL, not to build a face database.

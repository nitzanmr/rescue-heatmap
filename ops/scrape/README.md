# Harvesting an external registry

Two commands, and a human between them.

```bash
# 1. Pull. Writes a file. Touches no database.
python3 ops/scrape/colombiatebusca.py --out data/external/ctb-full.ndjson \
        --category Terremoto     # detail pages are fetched by default

# 2. Look at it. This step is not optional.
cd services/api && npm run import-external -- \
        --file ../../data/external/ctb-full.ndjson --source colombiatebusca

# 3. Load, once someone has decided to hold this data.
npm run import-external -- --file ../../data/external/ctb-full.ndjson \
        --source colombiatebusca --incident sismo-choco --load
```

`data/external/` is git-ignored on purpose. The harvested file contains the names
of real missing people. The scraper and the importer belong in the repo; the
personal data does not, because a commit is forever and an erasure request is not.

## What the import is and is not

**Is:** thousands of real, human-entered Spanish names with real duplicate
patterns — the population our dedup engine was never measured on. Ranking
ablation on synthetic seed data told us the engine is good enough; this is the
first chance to check that claim against reality.

## Which place we keep

The listing card shows a municipality. The person's own page shows the line a
relative actually typed — `Parque la Libertad - Pereira, Risaralda`. The harvester
fetches that page for every record and the detail line **overrides** the listing
value; `place` is the resolved field, `place_source` says which one won, and both
raw values are kept so the decision can be audited without harvesting again.

That override is the difference between data that can and cannot reach the map.
A municipality is tens of kilometres wide and a heat cell is 500 m; a landmark is
something a geocoder can turn into a point.

**Still not, today:** more dots on the heat map. A finer *string* is not a
coordinate. Imported cases continue to land with `location_source = 'none'` in
the unmapped queue until a geocoding step exists and its output is reviewed —
guessing a point from free text is how a team gets sent to a plaza.

## Undoing it

```sql
SELECT * FROM public.forget_external_source('colombiatebusca');
```

One statement, by design. If we cannot erase a source cleanly, we should not
import it.

# Harvesting an external registry

Two commands, and a human between them.

```bash
# 1. Pull. Writes a file. Touches no database.
python3 ops/scrape/colombiatebusca.py --out data/external/ctb-full.ndjson \
        --details --category Terremoto

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

**Is not:** more dots on the heat map. The source publishes a municipality
("Pereira, Risaralda"), not a coordinate. Imported cases therefore land with
`location_source = 'none'` and appear in the unmapped queue, exactly like our own
address-only reports. Dropping a municipality centroid on the map would invent a
hot cell nobody reported and send a team to a plaza.

## Undoing it

```sql
SELECT * FROM public.forget_external_source('colombiatebusca');
```

One statement, by design. If we cannot erase a source cleanly, we should not
import it.

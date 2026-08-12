# Aid sites — the "where do I go" layer

Shelters, hospitals, pharmacies, fire/police, collection points. This is the
layer the public map is actually opened for, and the only layer that can be
built **before** an event. Building it in peacetime is the entire lesson of the
Venezuela activation: the form was three days late, and three days late is the
same as absent.

## Files

| File | Area | Sites | Source |
|------|------|-------|--------|
| `pereira-co.geojson` | Pereira metro, Risaralda (4.70,-75.96 → 4.98,-75.56) | 449 | OpenStreetMap via Overpass, pulled 12 Aug 2026 |
| `archive/quibdo-co.geojson` | Quibdó, Chocó (5.55,-76.80 → 5.85,-76.55) | 108 | Kept for the drill's history. Files under `archive/` are **not** loaded by seeding. |

Attribution is **mandatory**: © OpenStreetMap contributors (ODbL). The API
returns it on every response and the map prints it.

## Refresh / add an area

```
make aid-sites-pull BBOX=4.70,-75.96,4.98,-75.56 OUT=data/aid-sites/pereira-co.geojson
# review the diff — this is a human step, not a formality
make aid-sites-load FILE=data/aid-sites/pereira-co.geojson COUNTRY=CO
```

The file is committed so an activation with no outbound internet still has the
layer. Overpass is rate limited and occasionally down; do not put it on the
critical path of a deployment.

## Kinds, and the one that matters

`shelter`, `medical`, `pharmacy`, `responder`, `supply`, `water`, `morgue`,
`info_point`, `other` — and `shelter_candidate`.

`shelter_candidate` is schools and community centres. In Latin American disaster
response these are the default mass shelters, but **a school is not a shelter
until somebody opens it**. Publishing them as shelters sends people to locked
gates. They are a separate kind, drawn muted, and hidden by default on the
public map behind an explicit toggle.

## Verified vs imported

Every OSM row is **unverified by construction** and is drawn hollow and dashed,
with the words "confirm before travelling". A row a liaison physically stood in
gets `verified_at`, and the importer will never overwrite a verified row's name,
address or phone — field verification outranks the import.

Telling a family to walk to a shelter that collapsed is a failure mode we own.

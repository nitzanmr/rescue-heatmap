# mapadelterremoto.com — building-level damage points

Scraped by `tools/fetch-mapadelterremoto.py`. Re-run any time; files are overwritten
per municipio and `index.json` carries the fetch timestamp.

**Source grade: B.** Curated aggregator by Naboo Intelligence (commercial vendor),
not an official authority. It is *not* an emergency dispatcher and says so itself.
Full source assessment: `../../../docs/mapadelterremoto-assessment-2026-08-13.md`.

## Why this exists
No official body has published the collapsed-building list at address level
(checked `datos.cali.gov.co`, `datos.gov.co`, PMU reports, ReliefWeb). This is the
only address-level enumeration that exists for the event. Cali's 45 `Colapso` points
match the official PMU #006 count of 45 exactly — suggestive, **not proof** that they
are the same 45 buildings.

## Reading a point
- `category` — the site's damage class: `Colapso`, `Grave`, `Moderado`, `Leve`,
  `Sin evaluar`, plus non-damage classes (`Respuesta y atención`, etc.).
- `evidence` — the site's own confidence: `Confirmado` / `Reportado` / `Verificando`.
- `sources` — how many independent sources it merged. Treat `una sola fuente` as weak.
- `address` — often a street *intersection*, not a building address. No coordinates:
  the site publishes none. Geocoding is a separate step and is not done here.

## Rules
- **Do not bulk-load into `registries/cali-structures`.** The registry is operational
  ground truth; media aggregation enters only after human verification.
- Personal data (phones, emails, cédulas) is scrubbed at fetch time. Given names of
  missing people that appear in the site's free text are **not** to be copied into
  any dossier — Ley 1581/2012.
- Always cite as: point id + `mapadelterremoto`, with the evidence label.

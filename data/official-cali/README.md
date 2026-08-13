# Official Cali city data — source [A]

Primary official source for the 10 Aug 2026 Chocó earthquake at **city level**
for Santiago de Cali. Until now every source we held was either national
(UNGRD, PAHO) or civilian ([C], colombiatebusca). Neither could tell us how
many buildings collapsed *in Cali*, which is why our structures registry
covered 7 of what turned out to be 45.

## What is here

| File | What it is |
|---|---|
| `pmu-report-NNN.pdf` | The numbered PMU (Puesto de Mando Unificado) situation report, exactly as published. Append-only: a report number is never overwritten. |
| `pmu-report-NNN.txt` | `pdftotext -layout` rendering, so numbers are diffable in git. |
| `latest.json` | Machine-readable extract of the newest report **plus** the headline block scraped from the repository page, with fetch timestamp. |

## Where it comes from

- **Repository page (updated continuously):**
  https://www.cali.gov.co/gobierno/publicaciones/193607/terremoto-de-cali-repositorio-oficial-de-informacion/
  Carries a headline balance block, shelters, donation points, blood banks,
  missing-person hotlines and the press-release index.
- **The report PDF** is linked from that page as *"Descargar último reporte
  oficial"*. The link is a `loader.php` download with a numeric `idFile`, which
  changes every cut — so **always follow the link from the page, never hardcode
  the file id**.
- English mirror of the repository page:
  https://www.cali.gov.co/publicaciones/193606/cali-earthquake-official-information-repository/

## Refresh

    python3 tools/fetch-cali-official.py

Requires `pdftotext` (poppler-utils). The script saves the PDF, extracts the
text, writes `latest.json`, and refuses to overwrite an already-stored report
number.

## Known discrepancy — read before quoting a number

The headline block on the repository page and the newest report PDF **do not
always agree**. As of the 13 Aug 2026 fetch:

| Field | Repository page | Report #006 (cut 12 Aug 20:00) |
|---|---|---|
| Injured | 1,401 | 1,224 |
| Buildings fully collapsed | 46 | 45 |
| Dead / missing / rescued | 96 / 111 / 88 | 96 / 111 / 88 |

Both are labelled "last updated 12 Aug 20:00". The page block appears to be
edited more often than a new PDF is issued, so it is probably the fresher of
the two — but that is an inference, not a statement from the city. The fetcher
prints a loud `MISMATCH` line whenever they diverge; **do not silently pick
one**. When quoting to the delegation, cite the report number and the cut time.

## What report #006 gives us that nothing else did

- City-level human toll: 96 dead · 1,224 injured · 111 missing · 88 rescued.
- **Building damage: 45 fully collapsed, 35 partially, 832 structurally
  damaged, 18 under evacuation order.**
- **Six active work fronts with signs of life**; signs ruled out at 20 further
  points, which move to debris removal. 1,800 rescuers active.
  The report does **not name** the six fronts — that is the single most
  operationally valuable missing item (RFI #23).
- Utilities: 4,500 electricity users intermittent/out, 5,906 gas users without
  supply, 35 water/sewer failures of which 25 repaired.
- Debris disposal sites: EDT Carrera 50 · Carrera 8 with Calle 59 · Carrera 50
  between calles 5 and 1.

## What is NOT available here

The city has **not** published a per-building list of the 45 collapses — no
address, no coordinate, no per-site casualty count. `datos.cali.gov.co` (CKAN)
has a risk-management organisation with 8 datasets, all pre-earthquake
(historical fire-brigade incidents, risk maps, PMU counts 2018–2024) and none
updated for this event. `www.datos.gov.co` (national Socrata) likewise has
nothing for the event. Getting that per-building list remains RFI #24 and is
the thing that would close the 7-of-45 coverage gap in our structures registry.

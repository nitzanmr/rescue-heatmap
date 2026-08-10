# Rescue Heatmap

**Open-source missing-person reporting and heatmaps for search-and-rescue operations after earthquakes.**

> **Status:** early design repository. No production deployment exists yet.
> The project is designed for INSARAG-compatible workflows, but **no INSARAG endorsement has been independently verified** and none is claimed here.
> All incident figures in this repo are marked with their verification status.

---

## The problem

After a major earthquake, thousands of people are reported missing through fragmented channels — social media, WhatsApp groups, improvised spreadsheets. Search-and-rescue teams get no centralized, structured, geolocated data to prioritize search zones.

Rescue Heatmap aims to turn structured civilian reports — identity, photo, and last-known location — into an operational picture for authorized SAR teams, while protecting affected people from misuse of their data.

## Architecture

```text
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Public Form    │────▶│  Backend / API   │────▶│  Command        │
│  (PWA, offline) │     │  Validate, geo,  │     │  Dashboard      │
│  Civilian       │     │  dedupe, audit,  │     │  Heatmap,       │
│  reports        │     │  access control  │     │  triage, export │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          ▼
                                                 ┌─────────────────┐
                                                 │  Field App      │
                                                 │  Offline maps,  │
                                                 │  tasking, sync  │
                                                 └─────────────────┘
```

| Directory | Description |
|-----------|-------------|
| `app/public/` | Civilian reporting form (PWA, offline-first) |
| `app/command/` | Command-center dashboard with heatmap visualization |
| `app/field/` | Field-team app with offline maps and tasking |
| `docs/` | PRD, playbooks, offline design options, lessons learned |
| `data/` | CSV/KML/GeoJSON templates, offline map-tile guides |
| `ops/` | Operational contacts, drill checklists |

## Principles

1. **Offline-first** — usable on unreliable or absent networks; cached maps for known risk zones.
2. **Deployable within hours** from a reviewed, pre-tested template.
3. **Interoperable** — standard GIS formats; compatible with INSARAG-aligned coordination practices.
4. **Multilingual and accessible** — Spanish and English first, easily extensible.
5. **Privacy, consent, safeguarding, and data minimization by default.**
6. **Human verification before operational use** — verified field reports override unverified civilian reports.

## Quick deploy

> ⚠️ The application has not been implemented yet. This is the intended path.

1. Provision PostgreSQL with PostGIS.
2. Configure the incident: area, languages, retention policy, authorized teams (`config.json`).
3. Deploy the Next.js PWA to Vercel or an approved equivalent.
4. Configure Nominatim-compatible geocoding and offline map tiles.
5. Run the verification checklist before distributing the public URL.

See the [deployment playbook](docs/deployment-playbook.md) and [PRD](docs/PRD.md).

## Documentation

- [Product requirements (PRD)](docs/PRD.md)
- [Offline-first intake — design options](docs/offline-first-options.md) — how to collect reports without connectivity
- [Structure intel — room-level victim localisation](docs/structure-intel.md) — from "which building" to "where to breach"
- [Deployment playbook](docs/deployment-playbook.md) — who, when, how to activate
- [Distribution playbook](docs/distribution-playbook.md) — channels, audiences, timing, templates
- [Quarterly drill checklist](ops/drill-checklist.md)
- [Incident lessons](docs/lessons-learned/)

## Contributing

Built by volunteers from the disaster-response community. Help is needed in:

- Frontend (React/Next.js, PWA, offline maps)
- Backend (data pipeline, geocoding, entity resolution/deduplication)
- UX/UI (accessible forms, mobile-first, low literacy)
- Translation (Latin American Spanish, Portuguese, French, Creole)
- SAR domain expertise and safeguarding/privacy review
- Introductions to local disaster-response organizations

## Safety

Missing-person data is highly sensitive. Do not deploy this project without a lawful basis, incident ownership, access controls, a retention/deletion policy, moderation, and coordination with competent authorities.

## License

MIT

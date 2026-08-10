# Rescue Heatmap

Open-source, real-time missing-person reporting and heatmaps for search-and-rescue operations after earthquakes.

> **Status:** early design repository; no production deployment exists yet. The project is designed for INSARAG-compatible workflows, but no INSARAG endorsement has been independently verified.

## The problem

After a major earthquake, reports about missing people arrive through fragmented channels. Rescue Heatmap aims to turn structured civilian reports—identity, photo, and last-known location—into an operational picture for authorized search-and-rescue teams.

## Architecture

```text
Public Form → Backend / PostGIS → Command Dashboard → Field App
```

- **Public Form:** multilingual, low-bandwidth PWA for civilian reports.
- **Backend:** validation, deduplication, geocoding, access control, and audit logs.
- **Command Dashboard:** heatmaps, clustering, triage, and KML/GeoJSON exports.
- **Field App:** offline tasking, cached maps, status updates, and later sync.

## Principles

- Offline-first and useful on unreliable networks
- Deployable within hours from a reviewed template
- Compatible with INSARAG coordination practices and common GIS formats
- Multilingual and accessible
- Privacy, consent, safeguarding, and data minimization by default
- Human verification before operational use

## Quick deploy

The application has not been implemented yet. The intended deployment path is:

1. Provision PostgreSQL with PostGIS.
2. Configure the incident area, languages, retention policy, and authorized teams.
3. Deploy the Next.js PWA to Vercel or an approved equivalent.
4. Configure Nominatim-compatible geocoding and offline map tiles.
5. Run the verification checklist before distributing the public URL.

See the [deployment playbook](docs/deployment-playbook.md) and [PRD](docs/PRD.md).

## Documentation

- [Product requirements](docs/PRD.md)
- [Deployment playbook](docs/deployment-playbook.md)
- [Distribution playbook](docs/distribution-playbook.md)
- [Quarterly drill checklist](ops/drill-checklist.md)
- [Incident lessons](docs/lessons-learned/)

## Safety

Missing-person data is highly sensitive. Do not deploy this project without a lawful basis, incident ownership, access controls, a retention/deletion policy, moderation, and coordination with competent authorities.

## License

MIT

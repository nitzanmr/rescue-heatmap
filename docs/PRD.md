# Product Requirements Document

## Objective

Help authorized search-and-rescue coordinators identify geographic concentrations of missing-person reports after an earthquake while protecting affected people from misuse.

## Users

- Civilians submitting reports
- Command-center data monitors and SAR coordinators
- Field teams working with intermittent connectivity
- Incident administrators and safeguarding personnel

## Product requirements

### Civilian reporting form

- Reporter contact and consent
- Missing person's name and approximate age
- Last-known location on a map, plus timestamp and free-text context
- Optional photo upload
- Language selection and accessibility support
- Duplicate detection, abuse controls, and a reference number

### Command dashboard

- Role-based access and audit logs
- Map and heatmap views with time and confidence filters
- Cluster analysis that preserves access to the underlying verified reports
- Verification and deduplication workflow
- KML and GeoJSON export for authorized operations
- Retention, correction, and deletion controls

### Offline field app

- Installable PWA with cached incident map and assigned records
- Offline notes, status changes, and conflict-aware synchronization
- Minimal-data views appropriate to the team's assignment
- Device revocation and encrypted local storage

## Non-functional requirements

- Operate on low bandwidth and degraded networks
- Multilingual, accessible, observable, and auditable
- Encrypt data in transit and at rest
- Separate public submission from operational access
- Minimize collection and define incident-specific retention
- Export standard GIS formats and support INSARAG-aligned coordination workflows

## Proposed technology

- Next.js PWA
- PostgreSQL with PostGIS
- Nominatim-compatible geocoding, with usage-policy-compliant hosting
- Vercel for rapid initial deployment, with a portable deployment path

## Roadmap

1. **MVP:** secure reporting form, moderation queue, map, basic clustering, exports.
2. **Operational pilot:** offline field workflow, multilingual templates, drills, security review.
3. **Ecosystem readiness:** interoperability testing, deployment automation, governance, partner validation.

## Success criteria

- Verified form online within two hours of activation
- Reports visible to authorized monitors within one minute under normal connectivity
- Field workflow remains usable offline for 24 hours
- Every read, export, edit, and deletion is auditable
- Quarterly drill meets the checklist and produces documented follow-up actions

## Out of scope for the MVP

- Automated victim identification
- Public access to individual reports or precise heatmap points
- Claims of official endorsement without written verification

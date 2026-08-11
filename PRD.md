# Product Requirements Document

## Rescue Heatmap — missing-person reporting and heatmaps for SAR operations

**Version:** 1.1 draft
**Last updated:** August 2026
**Origin:** volunteer response to the Venezuela earthquakes, June 2026

---

## 1. Objective

Help authorized search-and-rescue coordinators identify geographic concentrations of missing-person reports after an earthquake, while protecting affected people from misuse of their data.

## 2. Background

During the June 2026 Venezuela earthquakes there was no centralized system for tracking missing persons. Civilians self-organized through social media and improvised platforms, producing large but fragmented and heavily duplicated datasets (see [lessons learned](lessons-learned/2026-06-venezuela.md)). SAR teams lacked structured, geolocated information to prioritize search zones.

A volunteer group created a reporting form. Discussion with INSARAG about future use has been reported within the group but **is not independently verified and is not claimed as an endorsement.**

## 3. Users

### 3.1 Civilians submitting reports
- Family members, neighbors, witnesses
- Limited connectivity, low-end phones, low battery
- Under acute stress — UX must be simple and forgiving
- Multilingual (priority: Spanish, English)

### 3.2 Command-center monitors and SAR coordinators
- INSARAG-certified teams, national agencies (e.g., UNGRD in Colombia)
- Need aggregated, deduplicated data with geospatial visualization and audit trails

### 3.3 Field teams
- Intermittent or zero connectivity
- Need offline maps, assigned sectors, and status updates that sync later

### 3.4 Incident administrators and safeguarding personnel
- Own the lawful basis, retention, moderation, and deletion decisions

## 4. Product requirements

### 4.1 Civilian reporting form (MVP)

**Fields**
- Missing person: full name, approximate age, gender, optional photo
- Last-known location: map pin, address, or landmark description + floor/apartment where relevant
- Time of last contact
- Free-text context
- Reporter: name, phone/WhatsApp, relationship to the missing person
- Status: missing / found / confirmed deceased
- Consent notice and language selection

**Requirements**
- Works offline (PWA with service worker + local queue) — see [offline-first options](offline-first-options.md)
- Mobile-first, low-bandwidth, accessible (WCAG 2.1 AA)
- Multilingual (Spanish/English minimum, extensible)
- No login required to submit
- **Duplicate detection at intake** (fuzzy name + proximity + phone), not bolted on later
- Abuse controls and a reference number returned to the reporter

### 4.2 Command dashboard

- Role-based access control and audit logs
- Map and heatmap views with time, status, and confidence filters
- Cluster analysis that preserves access to the underlying verified reports
- Verification and deduplication (entity-resolution) workflow with human review
- KML / GeoJSON / CSV export for authorized operations
- Retention, correction, and deletion controls
- Status-lifecycle management: prompts to update stale "still missing" records

### 4.3 Offline field app

- Installable PWA with cached incident map and assigned records
- Offline notes, status changes, conflict-aware synchronization
- Minimal-data views appropriate to each team's assignment
- Device revocation and encrypted local storage

## 5. Non-functional requirements

- Operate on low bandwidth and degraded networks
- Multilingual, accessible, observable, auditable
- Encrypt data in transit and at rest
- Separate public submission from operational access
- Minimize collection; define incident-specific retention (default: 90 days post-event, then anonymize)
- Export standard GIS formats; support INSARAG-aligned coordination workflows
- GDPR-compatible consent; reporter-initiated deletion requests

## 6. Proposed technology

- **Frontend:** Next.js PWA; Leaflet or MapLibre GL with offline tile support; Service Worker + IndexedDB
- **Backend:** serverless functions; PostgreSQL with PostGIS
- **Geocoding:** Nominatim-compatible, hosted in compliance with usage policy
- **Deduplication:** fuzzy name matching + proximity clustering + phone/identity signals
- **Hosting:** Vercel for rapid initial deployment, with a portable deployment path

## 7. Deployment model

The system is a **template**, not a permanently running service:

1. Earthquake detected → team activates
2. Clone repo → update `config.json` (event name, region, languages, map bounds)
3. Deploy
4. Distribute the URL per the distribution playbook
5. Monitor the dashboard
6. After the event: export, archive, deactivate, delete per retention policy

**Target activation time: under 2 hours from decision to live form.**

## 8. Success criteria

- Verified form online within two hours of activation
- Reports visible to authorized monitors within one minute under normal connectivity
- Field workflow remains usable offline for 24 hours
- Share of reports with usable geolocation
- Duplicate rate after entity resolution (baseline to beat: ~24% observed across Venezuela platforms — see lessons learned)
- Every read, export, edit, and deletion is auditable
- Quarterly drill meets the checklist and produces documented follow-up actions

## 9. Roadmap

### Phase 1 — MVP
- [ ] Public reporting form with offline capture and queued sync
- [ ] Moderation queue and intake deduplication
- [ ] Basic map view + clustering
- [ ] CSV/KML export
- [ ] Spanish + English

### Phase 2 — Operational pilot
- [ ] Heatmap and triage workflow
- [ ] Offline field app with cached maps
- [ ] Partner-reviewed translations, safeguarding procedures
- [ ] Drills and security review

### Phase 3 — Ecosystem readiness
- [ ] Interoperability testing with SAR coordination systems
- [ ] Deployment automation and multi-incident support
- [ ] AI-assisted duplicate detection
- [ ] SMS/USSD reporting for non-smartphone users
- [ ] Governance and partner validation

## 10. Out of scope for the MVP

- Automated victim identification
- Public access to individual reports or precise heatmap points
- Any claim of official endorsement without written verification

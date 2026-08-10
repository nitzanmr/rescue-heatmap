# Lessons Learned: Venezuela Earthquakes, June 2026

## ⚠️ Verification status

USGS records include M7.2 and M7.5 earthquakes in Venezuela in June 2026. **All casualty, displacement, and platform-scale figures below are reported figures from media, volunteer groups, and internal group discussion — they are not independently verified and must not be republished as fact.** No public source verifying INSARAG adoption or endorsement of this project was found; references below describe reported conversations only.

---

**Event:** M7.2 followed by M7.5 (reported)
**Date:** June 24, 2026
**Location:** Venezuela
**Population exposed:** ~8.6 million *(reported)*
**Casualties at 96h:** ~1,722 dead, 3,222+ injured, tens of thousands missing *(reported, unverified)*
**Infrastructure:** ~700 buildings collapsed, 200+ schools damaged, 10,222+ displaced *(reported, unverified)*

---

## 1. Early Warning

**What happened:** Venezuela has no official earthquake early warning system. Google provided alerts through Android phone motion sensors, which gave many people time to evacuate.

**Lesson:** Early warning systems that rely on a single channel (smartphones) exclude large portions of the population. Multi-channel alerts (SMS, sirens, radio) are essential.

## 2. Search & Rescue

**What happened:** Official rescue forces arrived with insufficient numbers and equipment. Citizens organized independent rescue efforts, forming human chains to clear rubble.

**Lesson:** Civilian-led rescue is inevitable and often the first response. Training and equipping local community teams should be a priority *before* an event.

## 3. Missing Persons Tracking

**What happened:** No official system for registering missing persons existed. Civilians filled the gap through social media and improvised spreadsheets, creating unreliable and fragmented data. The Venezuelan government declined to publish official missing-persons figures.

**Our response:** A volunteer group created a structured reporting form. However:
- The form arrived 2-3 days after the earthquake — too late for the critical 72-hour window
- Distribution was limited, primarily reaching Jewish communities rather than the broader affected population
- By the time the form launched, local civilian initiatives had already emerged

**INSARAG:** Group members report that INSARAG reviewed the form and expressed interest in using it in future operations. *This is unverified and should be treated as an internal note until confirmed in writing.*

### Case Study: VenezuelaReporta.org

The most successful civilian platform was **Venezuela Reporta** (venezuelareporta.org), created by Carlos Ruiz, a Miami-based Venezuelan web developer. Key facts:

**Scale (reported figures):** ~41,000+ missing persons registered; ~140,000 total records across all platforms; 689+ pages of results. Referenced by NYT, CNN, Al Jazeera, AP, BBC, IRC, and cited by international agencies as a primary data source when the government refused to publish figures.

**✅ What worked well:**
- **Speed to market** — launched within hours/days of the earthquake, filling a critical vacuum
- **Simple UX** — three clear actions: report someone missing ("Se busca"), mark someone as found, or report a sighting
- **Photo-first design** — visual cards with photo, name, age, and last known location made browsing intuitive even on mobile
- **Minor protection** — photos of children are automatically blurred ("Menor de edad") with identity protection
- **Search functionality** — simple search by name on /buscar page
- **Bilingual** — Spanish and English versions available
- **Status tracking** — clear status badges ("Se busca" = being searched for)
- **Supabase backend** — scalable, serverless architecture that handled massive traffic
- **Community trust** — became the de facto registry when government refused to provide numbers. Media organizations and even the government eventually used the data
- **Detailed location data** — captures city, specific building/complex, floor, apartment (e.g., "OPP26 Torre H Caribe")
- **Pagination** — handles tens of thousands of records cleanly

**⚠️ What needed improvement:**
- **Massive duplicate problem** — NYT reported at least 10 people reporting the same person missing on the platform. Across all platforms, Tilores (a German entity resolution company) found 33,756 duplicates out of 140,831 total records (24% duplication rate). Same person appears with slightly different name spellings (e.g., "Stefania coromoto sanchez ramires" vs "Stefania coromoto sanchez ramirez")
- **No deduplication built-in** — required a third party (Tilores) to offer free dedup service after the fact via "Venezuela Te Busca" (tilores.io/venezuela-te-busca)
- **Fragmented ecosystem** — at least 3 competing platforms emerged (venezuelareporta.org, Desaparecidos Terremoto Venezuela, buscatupaciente.com), each with partial overlapping data. RedQuipu tried to aggregate them but this should have been built-in
- **No official verification layer** — all entries are community-submitted, unverified. No mechanism for SAR teams to override or validate citizen reports
- **No heatmap / geographic visualization** — data is presented as a flat list of cards; no map view to help SAR teams identify clusters of missing persons by location
- **No offline capability** — fully web-dependent; useless in areas with no connectivity
- **No structured export** — no CSV/KML export for SAR teams to import into their operational tools
- **Read-write for everyone** — no RBAC; anyone can see all reports (good for families searching, but raises privacy and panic concerns per INSARAG guidelines)
- **Static status** — most entries still show "Se busca" months later; no systematic process to update statuses as people are found or confirmed deceased
- **No integration with authorities** — remained a parallel, informal system; the government's refusal to publish official data made this both necessary and problematic

**📊 Key metrics for comparison** *(all reported, unverified):*
- ~41,000 missing persons registered (venezuelareporta.org alone)
- ~44,000 initially reported missing across "Venezuela Te Busca" aggregation; 17,790 still not found as of August
- 24% duplication rate across platforms
- Government official death toll: 4,333 (as of latest reports); USGS estimated >10,000 actual fatalities

**Lessons:**
- **Speed matters:** The form must be deployable within hours, not days
- **Broad distribution:** Must reach affected populations directly, not just diaspora communities
- **Pre-built templates:** Don't build from scratch each time — have a configurable template ready
- **Local partnerships:** Pre-establish contacts with local organizations in risk zones
- **Deduplication is critical from day 1** — entity resolution must be built into the system, not bolted on after 140K records accumulate
- **Single source of truth** — multiple competing platforms fragment the data and confuse families. Aim to be THE platform, or build aggregation/dedup from the start
- **Status lifecycle management** — automated workflows to prompt for updates; integration with hospitals, morgues, and shelters
- **Geographic visualization** — missing persons data on a map is exponentially more useful to SAR teams than a flat list
- **Official override mechanism** — per INSARAG guidelines, verified field reports must override unverified citizen reports
- **Export for interoperability** — CSV/KML/GeoJSON export so SAR teams can import data into their existing tools

## 4. Evacuation & Shelter

**What happened:** Thousands slept in streets, parks, and cars due to fear of aftershocks. Evacuation centers were set up in sports halls and stadiums, primarily by volunteers.

**Lesson:** Clear, authoritative guidance on when it's safe to return home is critical. In its absence, people stay displaced longer than necessary, straining resources.

## 5. Infrastructure & Communications

**What happened:** Power, water, and internet disruptions in affected areas. Starlink offered free service. The education system was suspended for a week.

**Lesson:** Any disaster response tool must work offline. Dependence on internet connectivity is a critical failure point.

## 6. International Aid

**What happened:** Within 24 hours, 1,600 rescuers arrived from the Americas. Support included rescue dogs, World Central Kitchen mobile kitchens, and UN field hospitals. Israel sent a diplomatic/educational mission but no official rescue team (though Israeli volunteer organizations did participate).

**Lesson:** Coordination with international bodies (INSARAG, OCHA, IFRC) should be established *before* an event, not during.

## 7. Key Recommendations for Future Events

1. **Pre-deploy reporting templates** — configurable form ready to launch in < 2 hours
2. **Build distribution networks in advance** — contacts in risk zones, local media, community groups
3. **Offline-first technology** — PWA with cached maps, works without internet
4. **Broad audience targeting** — reach affected populations directly, not filtered through specific communities
5. **INSARAG relationship** — seek a documented, written relationship; align data formats. Treat interoperability or endorsement as unverified until documented
6. **Quarterly drills** — simulate activation to keep the team ready
7. **After-action documentation** — capture lessons while they're fresh (like this document)

---

## Follow-up

- Build and test an MVP (see [offline-first options](../offline-first-options.md)).
- Create partner-reviewed translations and safeguarding procedures.
- Seek formal review from relevant disaster-response organizations, in writing.
- Measure whether reports become actionable assignments, not only submission volume.

---

*Compiled from volunteer group discussions, a PDF summary report ("Lessons for the Population — Venezuela Earthquake, June 2026"), public media coverage, and field observations. Figures are reported, not verified.*

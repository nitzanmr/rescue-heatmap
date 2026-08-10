# Structure Intel — room-level victim localisation

**Status:** design blueprint, v0.1 draft
**Scope:** what happens *after* the heatmap says "this building". This document covers the micro level: which floor, which unit, which room, and where to breach in the first hours.
**Source:** field practice described by an experienced USAR responder (population-intelligence method used by Israeli delegations). Treat every number here as a design assumption until calibrated against real outcomes.

---

## 1. Why this is a separate product

The heatmap answers **"which pile do we go to?"** — it aggregates thousands of citizen reports into geographic priority.

This module answers a different, harder question:

> I am standing on a collapsed 6-storey building. I have one team, one set of breaching gear, and roughly six hours before the survival curve drops. **Do I cut through the roof slab here, or three metres to the left, or at the north wall?**

That decision is not made from report volume. It is made from **population intelligence**: reconstructing who was inside, on which floor, in which room, at the minute of collapse — and then translating that into a point on the rubble.

This is the differentiator. Report collection is a commodity; several platforms did it in Venezuela. Room-level occupancy reconstruction, done systematically and handed to a team leader as a printable building card, is not something any of the public platforms produced.

---

## 2. The core inference chain

```
Person  →  Habitual location at time-of-collapse  →  Room
Room    →  Unit / floor in the pre-collapse structure
Structure + collapse mode  →  Displacement of that room into the debris pile
Debris location  →  Breach point + expected void type + expected depth
```

Each arrow loses confidence. The product's job is to make each arrow explicit, evidence-backed, and revisable — not to output a single false-precision "X marks the spot".

Two independent directions of inference must both be supported:

**Forward (before digging):** interviews → expected occupancy → breach recommendation.
**Backward (while digging):** a found artifact (a shirt, a necklace, a school bag, a phone) → whose it is → therefore we are standing in unit Y on floor X → update all other estimates on this pile.

The backward direction is the one that field teams already do intuitively. Making it a system feature is cheap and high-value: it requires that the intake form captured **personal effects** in the first place.

---

## 3. Data model

Additions to the shared schema (see `form-spec.md`). All of it is **field-team visibility only** — never public.

### 3.1 Structure

| Entity | Key fields |
|---|---|
| `structure` | id, address, lat/lng, footprint polygon, storeys above/below ground, construction type (RC frame / masonry / precast / informal), year, units per floor, collapse mode, collapse orientation, pancake layer count |
| `floor` | structure_id, level, plan sketch (image/GeoJSON), unit list |
| `unit` | floor_id, unit label (apt 4B), household, occupancy at night/day |
| `room` | unit_id, label (bedroom 1 / kitchen / bathroom), position in unit sketch, exterior wall(s), window side |
| `void_hypothesis` | structure_id, room refs, void type (lean-to / V-shape / pancake layer / cantilever), estimated depth, access route, confidence |
| `breach_point` | structure_id, position on the pile, target void, rank, rationale, status (proposed / in progress / cleared / result) |

### 3.2 Occupancy claim — the atomic unit of intelligence

Every statement made by any informant about where a person was becomes one record. Claims are never merged, never overwritten. Conflicts are surfaced, not resolved silently.

| Field | Notes |
|---|---|
| `person_ref` | Links to the missing-person report |
| `structure_id`, `floor`, `unit`, `room` | Whatever granularity the informant could give |
| `time_reference` | "at the moment of the quake" / a clock time / "usually at that hour" |
| `basis` | eyewitness / phone call / habit / third-hand / document (roster, lease) / device signal |
| `informant` | Who said it, relationship to the person, contactable? |
| `certainty_stated` | What the informant said: sure / fairly sure / guessing |
| `weight` | System-computed evidence weight (§5) |
| `conflicts_with` | Other claim ids |
| `recorded_by`, `recorded_at`, `offline_queued` | Chain of custody |

### 3.3 Personal effects — the backward-inference key

Captured on the intake form, used on the pile.

| Field | Notes |
|---|---|
| `clothing_at_time` | What they were wearing — critical, and only knowable in the first hours while memory is fresh |
| `jewellery` | Ring, necklace, watch — often the only intact identifier |
| `distinctive_items` | School bag, work uniform, prosthesis, hearing aid, wheelchair |
| `phone_model_colour`, `phone_number` | Enables ring-through search and IMEI-style matching |
| `physical` | Height, build, hair, scars, tattoos, dental work |
| `medical` | Dialysis, diabetes, oxygen — changes survival window and triage order |
| `pet` | Frequently the artifact actually found first |

A dedicated **artifact-found** intake: field team photographs an object, the system runs it against personal-effects records and returns ranked candidate persons → therefore ranked candidate rooms → therefore an updated position estimate for the whole pile.

---

## 4. Where the structure model comes from

Ordered by how fast they are obtainable in the first 24 hours.

1. **Occupant and neighbour interviews.** The primary source. Ask people to sketch, not just describe (§6).
2. **Satellite and aerial imagery, including historical construction-phase imagery.** Images taken while the building was being built expose floor count, slab layout, column grid and stair core — information that is invisible once the façade is up and impossible to recover after collapse. Sources to pre-arrange: Maxar Open Data Program (activated for major disasters), Copernicus EMS rapid mapping, Google/Bing historical imagery, Planet.
3. **Street-level imagery** (Google Street View, Mapillary) for façade, entrance position, balcony pattern, storey count, ground-floor commercial use.
4. **Municipal / cadastral records** — building permits, floor plans, unit counts, occupancy registers. Slow, bureaucratic, but sometimes available in a day if requested through the national disaster agency.
5. **Building administrator / landlord / doorman** — the single highest-yield human source: unit list, household composition, who was away.
6. **Social media and photos from residents** — interior photos reveal room layout and furniture positions.
7. **Exclusion data:** school attendance, workplace rosters, hospital admissions, shelter check-ins. Knowing who was **not** in the building is as valuable as knowing who was, and it is the cheapest way to shrink the search.

---

## 5. Confidence — deliberately simple

Resist inventing a probability model. Field teams distrust numbers they cannot audit, and a fabricated 87% is worse than a defensible "strong".

Score each occupancy claim on three axes, then combine:

- **Directness** — eyewitness inside the building at the time (3) > phone contact at the time (3) > habit/routine (2) > third-hand report (1).
- **Recency of reference** — anchored to the minute of collapse (3) > that morning (2) > "usually" (1).
- **Corroboration** — independent informants who did not talk to each other. Count them; two independent informants beat one confident one. Family members who arrived together are *one* source, not three — record who spoke with whom.

Output a four-level band: **Confirmed / Strong / Plausible / Weak**, always displayed with the evidence chain behind it ("3 independent claims, one eyewitness, all say 4th floor, north side"). Every breach recommendation must be explainable in one sentence to the team leader.

**Conflicts are a feature.** When two informants place the same person in different rooms, that is the highest-value item on the board — it tells the interview team exactly what to re-ask.

---

## 6. Interview protocol (structured debriefing)

The quality ceiling of the entire module is set here. Design rules:

- **Sketch, don't describe.** Hand the informant a blank floor-plan sheet or a tablet sketch surface. "Draw your apartment. Where is the bed? Where were you standing?" Spatial memory is far more reliable than verbal description, and it transfers directly into the data model.
- **Anchor to the event, not to the clock.** Never ask "what time". Ask "when it started shaking, where was he?" People do not remember clock times; they remember the moment.
- **Interview separately.** Family members standing together converge on one story within minutes. Separate them, then compare — divergence is information.
- **Ask about routine explicitly.** "On a normal Tuesday at 07:30, where is she?" Habit is legitimate evidence and often the only evidence available.
- **Ask the exclusion question.** "Who normally lives there but was definitely not home?" — fastest way to cut the list.
- **Ask what they were wearing.** Only reliable in the first hours; degrades fast.
- **Do not contaminate.** Never repeat back what another informant said before the person has given their own version.
- **Record who was asked, and what was *not* asked** — so a second team knows where to resume.

Deliverable: a one-page structured interview form (Spanish/English/Hebrew), designed to be filled on paper by a volunteer with no training and typed in later, or filled directly on tablet offline.

---

## 7. From room to breach point

The step most likely to be wrong, and the one where the module must be honest about its limits.

A room's pre-collapse coordinates are **not** its post-collapse coordinates. The translation depends on collapse mode:

- **Pancake** — floors stack near-vertically; horizontal position roughly preserved, depth = layer number. Voids are thin and edge-biased (near furniture, near walls).
- **Lean-to / V-shape** — the slab tilts; occupants slide toward the low or high side. Position shifts metres.
- **Overturn / soft-storey** — the upper structure rotates off the footprint entirely; a 4th-floor bedroom can end up at ground level twenty metres away.
- **Debris avalanche on slope** — everything moves downhill.

So the model's output must be a **ranked list of breach points with rationale and uncertainty**, aligned with the established INSARAG/structural-triage practice teams already use, not a replacement for it. The product's contribution is the occupancy layer that structural assessment alone does not have — plus a fast, auditable way to keep it updated.

The output artifact for the team leader:

**Building card (A4, printable, works offline):**
- Structure sketch: elevation + per-floor plan
- Per-unit occupancy: names, count, confidence band, medical flags
- Time-of-collapse assumption stated explicitly
- Top 3 breach points, ranked, each with a one-line rationale
- Known voids and access routes
- Personal-effects quick reference for the people expected in that sector
- What we do not know — the open questions the interview team should chase next

---

## 8. Learning loop

Every extraction — live or deceased — records the **actual** found location: floor, unit, room, depth, void type. Compared against the pre-dig estimate, this produces the only thing that will ever make the model credible:

- Calibration of habit priors ("at 07:34 on a weekday, adults were found in the bedroom X% of the time")
- Displacement statistics per collapse mode
- Which interview questions actually predicted the outcome, and which were noise
- An after-action record that is defensible to authorities and to the families

Without this loop, the module is opinion. With it, after two or three events it becomes the asset no one else has.

---

## 9. Privacy, ethics and legal

Room-level occupancy data is the most sensitive data in the entire system.

- **Never public.** No search, no export, no map layer. Public search shows name, photo, city — nothing else (unchanged from `form-spec.md`).
- **Access:** authenticated field teams and the coordination cell only, scoped to the structures they are assigned.
- **Retention:** hard deletion or transfer to the national authority at end of operation; defined, dated, and stated to informants at intake.
- **Colombia:** Ley 1581 (habeas data) applies — informed consent, purpose limitation, right to deletion, named data controller. Resolve before any real deployment.
- **Deceased and identification:** any personal-effects matching that touches identification of remains must be handed to the legally competent authority, not resolved by the platform.
- **Misuse risk:** a database of who was in which apartment is exactly the dataset an abusive actor would want. Encryption at rest, per-structure access scoping, and an audit log are not optional.

---

## 10. Build path

**Phase A — paper and process (days, no code).** Interview form + building-card template + sketch sheet. Immediately usable, and it produces the training data for everything else. This alone would improve the current operation.

**Phase B — structured capture.** Extend the schema with structure/floor/unit/room and occupancy claims. Add personal-effects fields to the intake form. Offline-capable tablet entry for interview teams. Generate the building card automatically from entered data.

**Phase C — inference support.** Corroboration and conflict detection, confidence bands, habit priors by hour and demographic, artifact→person→room reverse matching, ranked breach points, outcome capture and calibration.

**Phase D — imagery pipeline.** Pre-arranged access to satellite/historical imagery; assisted floor-count and footprint extraction; overlay of the sketch on the current rubble image.

---

## 11. Open questions

1. Who owns the structural assessment — us, or the USAR team's own structures specialist? (Almost certainly theirs. We supply occupancy, they supply structure. The interface between the two needs defining.)
2. Do we push room-level output into an existing INSARAG worksite form, or is our building card a parallel artifact? Aligning with what teams already fill in beats inventing a new form.
3. Habit priors: is there published data on time-of-day room occupancy, or must we build it from our own extraction outcomes?
4. How do we handle informal/self-built structures where no plan, permit or unit numbering exists — probably the majority of collapses in the region?
5. Consent: what exactly do we tell a family member whose interview will be stored as an occupancy record?

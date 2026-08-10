# Missing-Person Report Form — Blueprint (v0.1 draft)

**Status:** design blueprint, not yet implemented
**Applies to:** every intake channel (PWA, Rescue Node captive portal, WhatsApp bot, SMS, paper+QR, field app)
**Rule:** all channels write to **one shared schema**. A channel that cannot capture a field leaves it null — it never invents its own field names.

---

## 1. Design principles

1. **Under 90 seconds to submit.** The reporter is in distress, on a low battery, possibly standing in a shelter queue.
2. **Two required fields only.** Name + where. Everything else is optional enrichment. A partial report is infinitely more useful than an abandoned one.
3. **Never block on connectivity.** Save first, transmit later. Always show transmission state honestly.
4. **Deduplicate at intake, not afterwards.** The Venezuela baseline to beat is ~24% duplicates (unverified figure — see lessons learned).
5. **Always return a reference number**, even offline. It is the only thing that lets a family update or correct a report later.
6. **Collect the minimum.** Every extra field is a privacy liability and a completion-rate loss.

---

## 2. Form flow

```
Step 0  Language + consent notice        (1 tap)
Step 1  Who is missing                   (name, age, gender, photo)
Step 2  Where were they last             (map pin / address / shelter, floor + apartment)
Step 3  When were they last seen         (date/time, or "I don't know")
Step 4  Who is reporting                 (name, phone, relationship)
Step 5  Confirm → reference number
```

Progressive: each step is a separate screen on mobile, all steps on one page on desktop. Draft is persisted to local storage after **every field change**, not on submit.

---

## 3. Fields

### 3.1 The missing person

| Field | Type | Req. | Notes |
|---|---|---|---|
| `full_name` | text | ✅ | Free text. Accept partial names, nicknames, "el hijo de María". Do not force a format. |
| `age_approx` | int | | "About how old?" — a slider or age band is faster than a number pad |
| `gender` | enum | | M / F / other / unknown |
| `photo` | image | | Compressed client-side to ≤200 KB. **Auto-blur faces of minors** (Venezuela Reporta did this — copy it) |
| `distinguishing_info` | text | | Clothing, height, medical condition, disability, language spoken. Free text |
| `national_id_last4` | text | | Optional, high-value dedup signal. Never the full ID |
| `consent_public_listing` | bool | | **Opt-out** (default on). Name / approx age / area / status in public search. Withheld reports still feed the heat map and still reach SAR |
| `consent_photo_public` | bool | | **Opt-in** (default off). Separate decision from the listing — agreeing to be searchable by name is not agreeing to have your face on a public page. Only meaningful when a photo exists |
| `consent_recorded_at` | datetime | auto | When the two flags above were captured |

### 3.2 Last known location — the field that makes the product work

| Field | Type | Req. | Notes |
|---|---|---|---|
| `last_seen_lat` / `last_seen_lng` | float | ✅* | Map pin. Defaults to device GPS if permitted |
| `location_accuracy` | enum | | exact / building / block / neighbourhood / unknown — **drives heatmap confidence weighting** |
| `last_seen_address` | text | ✅* | Address, landmark, shelter name, or "the school next to the church" |
| `building_name` | text | | |
| `floor` | text | | **Critical for SAR triage in a collapse** |
| `apartment` | text | | |
| `admin_area` | text | auto | Department / municipality, derived by geocoding |

\* At least one of {coordinates, address text} is required. A report with a name and no location is accepted but flagged `geo_missing` and excluded from the heatmap.

**Offline note:** with no network there is no geocoder and no map tiles. Fallbacks, in order: (a) cached tiles for the incident bounding box, (b) raw device GPS with no basemap, (c) a picker of pre-loaded shelter/landmark names for the incident, (d) free text.

### 3.3 Timing

| Field | Type | Req. | Notes |
|---|---|---|---|
| `last_contact_at` | datetime | | Offer quick chips: "before the quake" / "after the quake" / "I don't know" |
| `last_contact_precision` | enum | | exact / same day / approximate / unknown |

### 3.4 The reporter

| Field | Type | Req. | Notes |
|---|---|---|---|
| `reporter_name` | text | ✅ | |
| `reporter_phone` | text | | Phone/WhatsApp. Strongest dedup key we have. Explain plainly: "so we can reach you if they are found" |
| `reporter_relation` | enum | | family / neighbour / friend / colleague / witness / other |
| `reporter_lang` | enum | auto | es / en / other |

### 3.5 Status and lifecycle

| Field | Type | Default | Notes |
|---|---|---|---|
| `status` | enum | `missing` | missing / found_safe / found_injured / deceased / withdrawn |
| `status_source` | enum | `citizen` | citizen / verified_field / official — **official overrides citizen, always** |
| `status_updated_at` | datetime | auto | |
| `stale_prompt_at` | datetime | auto | Venezuela's failure: thousands of records frozen at "still missing" forever. Prompt the reporter after 72h |

### 3.6 System fields (auto)

`uuid` (generated **client-side**, so retries never duplicate) · `incident_id` · `channel` (pwa/whatsapp/sms/paper/node/field) · `node_id` (which Rescue Node accepted it) · `created_at_device` · `received_at_server` · `sync_state` (queued / sent / acked / conflict) · `reference_number` (short, human-readable, e.g. `CO-4F7K`) · `app_version` · `dedup_cluster_id` · `confidence_score`

---

## 4. Deduplication at intake

Runs **on submit**, before the record is committed.

| Signal | Weight |
|---|---|
| Fuzzy name match (phonetic, Spanish-aware — Ramírez ≈ Ramirez) | high |
| Distance between pins < 100 m | high |
| Same reporter phone | very high |
| Same `national_id_last4` | very high |
| Age within ±3 years | medium |
| Same building + floor | high |

**Behaviour:** above the threshold, show the reporter the possible match — *"Someone already reported a person with a similar name at this address. Is this the same person?"* → `Yes, add my information` (merge, keep both reporters as contacts) / `No, different person` (creates a record with `dedup_reviewed: true`).

Never silently reject. Never silently merge. Below the threshold but above the noise floor → mark `dedup_cluster_id` and send to the human review queue.

---

## 5. Offline behaviour requirements

- Save the draft to IndexedDB on every keystroke; survives a tab crash or a dead battery
- Submissions enter a local queue with `sync_state: queued`
- Honest status text: **"Saved on this device — not yet sent"** and, once sent, **"Received by the command centre"**
- A **manual "Send now" button** — background sync is unreliable and effectively absent on iPhone
- Reference number is issued locally and immediately, prefixed with the incident and node
- Photos queue separately from the text record: **text syncs first**, photos when bandwidth allows
- Queue must survive at least 72 hours and ~200 reports per device

---

## 6. Privacy and safeguarding

- Consent notice in plain language before step 1, not a checkbox wall
- **Two separate consents, never one bundled checkbox:**
  - *Public listing* — opt-out, default on. It is the engine of adoption, but withdrawing it must cost exactly one tap
  - *Photo publication* — opt-in, default off. A face on a public page is a different exposure from a name in a list
  - Removing the photo automatically clears its consent flag
  - Both are reversible at any time using the reference number
- Minor photos auto-blurred **even when photo consent was granted**; full national ID never collected
- Public view shows **name, photo, city, approximate area only** — never floor/apartment, never the reporter's phone, never a precise pin
- Precise coordinates and reporter contact are visible to authorised coordinators only, with an audit log
- Reporter can withdraw a report using their reference number
- Retention: 90 days after the incident closes, then anonymise
- Local storage on a Rescue Node is encrypted; reports are wiped after a confirmed sync

---

## 7. Spanish strings (first draft — needs native review)

| Key | Español | English |
|---|---|---|
| title | Reportar persona desaparecida | Report a missing person |
| name | Nombre completo de la persona | Full name |
| age | Edad aproximada | Approximate age |
| photo | Foto (opcional) | Photo (optional) |
| where | ¿Dónde se le vio por última vez? | Where were they last seen? |
| floor | Piso / apartamento | Floor / apartment |
| when | ¿Cuándo fue el último contacto? | When was the last contact? |
| dontknow | No lo sé | I don't know |
| reporter | Sus datos de contacto | Your contact details |
| offline | Guardado en este dispositivo — aún no enviado | Saved on this device — not yet sent |
| sent | Recibido por el centro de coordinación | Received by the command centre |
| ref | Su número de referencia | Your reference number |
| dup | Alguien ya reportó a una persona con un nombre parecido en esta dirección. ¿Es la misma persona? | Someone already reported a similar name at this address. Same person? |

---

## 8. Explicitly out of scope for v1

- Login or account creation
- Free-text chat with the command centre
- Public browsing of individual reports (a search-by-name lookup is a phase-2 decision with a safeguarding review)
- Automatic facial matching
- Full national ID collection

---

## 9. Open questions

1. Do we allow public search by name? Venezuela Reporta did, and it drove adoption — but it exposes vulnerable people.
2. Do we accept anonymous reports with no reporter phone? Raises volume, destroys the strongest dedup signal.
3. Is a "found safe" report trusted from a citizen, or does it require verification?
4. Who owns the data at the end of the incident — us, UNGRD, or INSARAG?

# Offline-First Intake — Design Options

**Scope:** Phase 1 of the product only — *collecting missing-person reports from civilians when connectivity is degraded or absent.*
Heatmaps, triage, and the field app are out of scope for this document.

**Status:** decision document. No option has been implemented. Recommendation in §7.

---

## 1. Why this is the hardest part of Phase 1

After a major earthquake the network is the first thing to fail and the last to recover:

| Failure mode | Effect on intake |
|---|---|
| Cell towers lose power / backhaul | No data, sometimes SMS still works |
| Network congestion | Requests time out; page never loads |
| Internet blackout or state throttling | Nothing web-based works at all |
| Phone battery dies | Any long or heavy flow loses the report |
| User is standing in rubble | Flow must survive being interrupted mid-way |

The Venezuela platforms (see [lessons learned](lessons-learned/2026-06-venezuela.md)) were **fully web-dependent** — they collected tens of thousands of reports, but only from people who had working connectivity. That is the gap this document addresses.

**A crucial distinction:** "offline" can mean two very different things.

- **A. Offline capture** — the app loads once, then keeps working with no network; reports are stored locally and sync later.
- **B. Offline delivery** — the report reaches us over a non-internet channel (SMS, voice, radio, paper, sneakernet).

Option A solves "the network is slow/flaky." Only option B solves "there is no network at all." A serious Phase 1 needs at least one of each.

---

## 2. Option 1 — PWA with local queue *(offline capture)*

**How it works:** Next.js PWA. A service worker caches the app shell, form, translations, and map tiles on first load. Submissions are written to IndexedDB and flushed by a Background Sync queue whenever the network returns. The user gets a reference number immediately, before the report leaves the device.

| | |
|---|---|
| **Effort** | ~1–2 weeks for a solid version |
| **Cost** | Near zero (Vercel free tier) |
| **Reach** | Anyone with a modern smartphone who loaded the page at least once |
| **Photos** | Yes — stored as blobs, uploaded on sync |
| **GPS** | Yes — device GPS works with no network |

**Pros**
- Same codebase as the online product; no parallel system to maintain
- Full field set — photos, GPS pin, structured data
- Reports survive tab closure, battery death, and days offline
- Installable to the home screen; keeps working after the site goes down

**Cons**
- ❌ **Requires one successful load.** If a person never had connectivity, they never get the app. This is the fatal limitation.
- iOS Safari has historically weak/absent Background Sync — needs a manual "retry" fallback
- Browsers can evict IndexedDB under storage pressure — needs a warning + export escape hatch
- Sensitive personal data sitting unencrypted on a possibly-shared phone

**Verdict:** Necessary but not sufficient. Build it — but do not call it "offline" in public messaging without also having option 2 or 3.

---

## 3. Option 2 — SMS / USSD intake *(offline delivery)*

**How it works:** A short code or local number accepts structured SMS. A gateway (Twilio, Africa's Talking, or a local carrier partnership) parses messages into report records. USSD (`*123#`) gives a menu-driven session on any phone, including feature phones.

Example format:
```
DESAPARECIDO Maria Gomez 34 / Torre H apt 12 Caribe / visto 06:00
```

| | |
|---|---|
| **Effort** | ~1 week technical + **days to weeks for carrier/short-code approval** |
| **Cost** | Per-message; can be zero-rated if a carrier partners |
| **Reach** | Every phone ever made — highest reach of any option |
| **Photos** | No (MMS is unreliable/expensive) |
| **GPS** | No — text location description only, geocoded later |

**Pros**
- SMS often survives when data networks are saturated or down
- Works on feature phones, dying batteries, and for low-literacy users via USSD menus
- Radio can broadcast the number — no internet needed to *learn about* the service either

**Cons**
- ❌ **Short-code provisioning is slow** — this must be arranged *before* an event, per country. It cannot be done inside the 72-hour window.
- Free-text parsing is messy; needs human review
- No photo, no precise location
- SMS costs money for a victim who may have no credit

**Verdict:** The highest-reach option and the biggest pre-event homework item. Pre-negotiate numbers in priority risk countries now.

---

## 4. Option 3 — WhatsApp / Telegram bot *(low-bandwidth delivery)*

**How it works:** A WhatsApp Business API or Telegram bot walks the reporter through the same fields conversationally. Both clients queue outbound messages locally and send them the moment a sliver of connectivity appears.

| | |
|---|---|
| **Effort** | ~1 week (Telegram) / 2–3 weeks (WhatsApp, incl. business verification) |
| **Cost** | Telegram free; WhatsApp per-conversation |
| **Reach** | Very high in Latin America — WhatsApp is the default channel |
| **Photos** | Yes |
| **GPS** | Yes — native location sharing |

**Pros**
- **Zero install friction** — it is already the app people use to ask for help
- Native offline queueing built into the client, for free
- Distribution and intake collapse into one channel: the same forwarded message *is* the entry point
- Photo + GPS + conversation, at very low bandwidth

**Cons**
- Still needs *some* data connectivity eventually (unlike SMS)
- WhatsApp Business verification takes time — again, pre-event work
- Platform dependency; template-message rules constrain outbound messaging
- Conversational flows are easy to abandon halfway

**Verdict:** Best reach-per-effort ratio for Latin America. Strong candidate to pair with the PWA.

---

## 5. Option 4 — Paper + QR bulk capture *(fully offline delivery)*

**How it works:** A one-page printable form (PDF, per-language) distributed at shelters, hospitals, churches, and aid points. Volunteers with a phone photograph the completed sheets; an operator-side "bulk entry" screen transcribes them, assisted by OCR. A QR code on the sheet links to the online form for anyone who does have connectivity.

| | |
|---|---|
| **Effort** | ~2 days for the form; ~1 week for the transcription tool |
| **Cost** | Printing only |
| **Reach** | Everyone, including the elderly, phoneless, and displaced |
| **Photos** | Physical photos can be attached/photographed |
| **GPS** | No — address/landmark text only |

**Pros**
- The only option that works with **no phone, no power, and no network at all**
- Shelters are exactly where families of missing people congregate
- Doubles as the distribution artifact
- Trivial to produce and translate in advance

**Cons**
- Manual transcription is slow and needs volunteers
- Paper is easily lost; no reference number for the reporter
- Serious privacy exposure — sheets of personal data lying on a table
- Highest duplicate rate of any channel

**Verdict:** Cheap, unglamorous, high-value. Prepare the PDFs in advance regardless of which digital option wins.

---

## 6. Option 5 — Volunteer field-collector app *(offline capture, delegated)*

**How it works:** Instead of relying on victims' devices, a small number of trained volunteers carry an offline-capable app (custom PWA, or an off-the-shelf tool like KoBoToolbox / ODK Collect) and interview families at shelters. They sync in bulk when they reach connectivity.

| | |
|---|---|
| **Effort** | Days, if using KoBoToolbox/ODK off the shelf |
| **Cost** | Free (KoBo is free for humanitarian use) |
| **Reach** | Limited by volunteer headcount, but very high data quality |
| **Photos / GPS** | Yes to both |

**Pros**
- **Fastest path to a working offline product** — ODK/KoBo are battle-tested in humanitarian work and already offline-first, multilingual, and INSARAG-adjacent in the ecosystem
- Data quality far above self-report: consistent fields, fewer duplicates
- Sidesteps the "victim must have loaded the app" problem entirely
- Proven with UN agencies — easier to justify to institutional partners

**Cons**
- Requires people on the ground — which we did not have in Venezuela or Colombia
- Doesn't scale to the tens of thousands of self-reports that Venezuela Reporta captured
- Off-the-shelf tools export data, but the heatmap remains ours to build

**Verdict:** The pragmatic bridge. Could be piloted with an existing tool this week, with zero development.

---

## 7. Comparison and recommendation

| Option | Effort | Reach | No-network? | Photo/GPS | Pre-event work needed |
|---|---|---|---|---|---|
| 1. PWA + queue | Medium | High | Capture only | ✅ | Low |
| 2. SMS / USSD | Medium | **Highest** | ✅ Yes | ❌ | **High** (carrier deals) |
| 3. WhatsApp bot | Medium | Very high | Partial | ✅ | Medium (verification) |
| 4. Paper + QR | **Lowest** | Universal | ✅ Yes | Partial | Low (print + translate) |
| 5. Field collector app | **Lowest** (off-shelf) | Low–medium | ✅ Yes | ✅ | Low |

**Recommended Phase 1 combination — "two channels, one pipeline":**

1. **PWA with local queue** (option 1) as the primary product and the codebase we own.
2. **WhatsApp bot** (option 3) as the true reach channel for Latin America — it is where the audience already is, and it solves distribution and intake at once.
3. **Paper form PDFs** (option 4) prepared now, at near-zero cost, as the no-power fallback.
4. **SMS short codes** (option 2) as pre-event homework for priority countries — cannot be improvised during an event.
5. **KoBoToolbox/ODK** (option 5) as the *immediate* stopgap if a delegation deploys before our MVP is ready.

All channels must write into **one normalized report schema with deduplication at intake** — the single most important lesson from Venezuela, where ~24% of records across platforms were duplicates *(reported figure, unverified)*.

---

## 8. Cross-cutting requirements for any offline option

- **Deduplication at intake**, not after 140,000 records accumulate
- **Reference number returned immediately**, so the reporter knows the report exists
- **Local encryption** for anything stored on a device
- **Explicit consent text** in every channel, including paper and SMS
- **Retention and deletion policy** applied identically across channels
- **Language parity** — a channel that only works in English is not a channel
- **Graceful degradation** — every flow must be completable in under two minutes on a dying phone
- **Human verification before operational use** — verified field reports override civilian reports

## 9. Open questions

- [ ] Which countries are priority for pre-negotiated SMS short codes?
- [ ] Do we own the WhatsApp Business account, or does a partner organization?
- [ ] Who transcribes paper forms, and where do the physical sheets go afterwards?
- [ ] Do we build our own collector app, or standardize on KoBoToolbox and focus our effort on the heatmap?
- [ ] What is the lawful basis and data controller for each channel?

---

*Next step: pick the combination, then convert §7 into dated issues in this repo.*

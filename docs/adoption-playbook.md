# Adoption Playbook — How the form becomes the thing everyone forwards

**Question this document answers:** Venezuela Reporta became, within days, the link that Venezuelans sent each other when looking for family. How do we make that happen deliberately instead of hoping for it?

**Short answer:** you do not make a *form* go viral. You make a *person* shareable, and distribution becomes a by-product of a family's own desperate search. Everything below follows from that one inversion.

> ⚠️ All figures referencing Venezuela are reported and unverified. See `lessons-learned/2026-06-venezuela.md`.

---

## 1. The core inversion: the share unit is a person, not the platform

Nobody forwards "a reporting form." People forwarded **cards** — a photo, a name, an age, a last known location — because they were begging their own network for help finding that specific person.

Design consequence: **every submitted report must instantly produce a shareable object.**

- A generated poster image (WhatsApp-native aspect ratio, readable at thumbnail size) with photo, name, age, last seen location, reference code, and the short URL.
- A permanent per-person page at a short URL (`/p/CO-4821`) with correct OpenGraph tags so the WhatsApp preview renders the photo and name. **A link that previews as a blank grey box reads as phishing and does not get forwarded.** This single technical detail is probably worth more than the entire social media plan.
- A one-tap "Compartir por WhatsApp" button with the message pre-written in Spanish.

The family is not promoting us. They are looking for their son. We are the paper their poster is printed on.

## 2. The receiving end must convert

Every card lands on a person already inside the affected network. That page must offer, in this order:

1. **"¿Lo has visto?"** — a sighting report. Low commitment, high value, feeds the heatmap.
2. **"Yo también busco a alguien"** — report another person.
3. **"Estoy bien"** — self-report as safe. Cheapest possible way to close records.

That is the loop: report → card → forward → recipient reports → new card. Measure it as a K-factor per report. Below 1.0, the thing dies without paid distribution; above 1.0 it spreads by itself.

## 3. Friction is the only real enemy

Every one of these kills forwarding, and all of them are avoidable:

- Any login, any app install, any permission prompt before the first field. **None.**
- First paint over 100 KB, or slower than ~3 seconds on 2G on a five-year-old Android.
- A cookie banner, an analytics consent dialog, an interstitial.
- A URL nobody can read aloud on the radio.

The name matters more than it seems. `venezuelareporta.org` works because it is the country plus a verb: sayable, spellable, guessable. Register the equivalent in each risk country **before** the event and keep it parked. Also register the obvious typos and the `.co`/`.com` twins, because clone and scam sites appear within hours of any disaster.

## 4. Trust is the actual bottleneck, not reach

A stranger's link asking for your missing brother's ID digits and your phone number, in a country where people distrust authorities, gets ignored — no matter how many people saw it.

What buys trust, in order of strength:

1. **One recognizable local endorser.** A national broadcaster, the Red Cross chapter, UNGRD, a diocese, a well-known local radio host. One logo on the page beats a thousand retweets. This is a pre-event relationship, not a same-day ask.
2. **A visible "quiénes somos"** with real names and a way to contact a human.
3. **Explicit data promises up front:** who sees the data, what is never shown publicly, when it is deleted.
4. **Not asking for what you don't need.** Every sensitive field is a tax on adoption; the ID digits and reporter phone number are exactly where people abandon.

## 5. Seed through physical hubs, not broadcast

The first 500 reports do not come from Twitter. They come from where frightened families physically gather:

- Hospital entrances and triage tents (this is precisely the niche `buscatupaciente` filled)
- Shelters and aid distribution points
- Churches, mosques, community halls
- Morgue and registration queues
- Municipal offices, fire stations, the SAR base perimeter
- University volunteer networks — a few hundred students with printed posters cover a city in a day

Deliverable: an A4/A3 poster PDF, printable in black and white on a bad printer, with two QR codes (join Rescue Wi-Fi / open form) plus the printed URL and SSID as fallback. Ready in the repo **before** the next event.

## 6. Do not fight for the front page — offer to be the plumbing

Within 24 hours of any major event, three to five civilian platforms will exist. In Venezuela there were at least three, plus an aggregator, plus a third-party dedup service bolted on afterwards. Fragmentation was the outcome, and it cost more than any single platform's weakness.

Two honest strategies, and we should hold both:

- **Be first** (only possible if the launch list is pre-built — see §8), or
- **Be the layer underneath.** Our differentiator is not the intake form. It is dedup, the weighted heatmap, and the SAR handoff. If someone else wins the public front end, we win by ingesting their data, deduplicating it, and handing the map back to them and to INSARAG for free.

Build for that from day one: a public ingest API, a documented CSV/JSON import, and an embeddable widget any news site can drop into an article. **If we cannot be the destination, be the pipe.** That converts a distribution race we might lose into a role nobody else is filling.

## 7. Good news is the strongest advertisement

Venezuela's records froze on "Se busca" forever. Nobody ever saw the system work.

- A live public counter: *"X personas reportadas · Y encontradas."*
- Consent-gated "encontrado" cards. A found-alive card gets forwarded harder than a missing one, and it is the only proof that filling the form does something.
- A 72-hour nudge to every reporter: "¿Ya la encontraron?" This is simultaneously the data-quality fix and the retention loop.

## 8. The uncomfortable truth: virality is a pre-event asset

You cannot manufacture reach in the six hours when it matters. What you can do beforehand, quietly, on a normal Tuesday:

- [ ] Parked domain per risk country + short-link domain
- [ ] Approved WhatsApp Business number and message templates (approval takes days to weeks — this is the single hardest deadline in the whole project)
- [ ] 20+ named contacts per country in `registries/distribution-channels`: radio, TV, Red Cross chapter, civil protection, diocese, university volunteer coordinator, three large local community groups
- [ ] One signed or verbally agreed endorser per country
- [ ] Posters, Spanish copy, and card templates pre-translated and reviewed by a native speaker
- [ ] A 10-line launch checklist that one person can execute in 90 minutes at 3 a.m.

The registry being empty today is the highest-leverage open item in this repo. Five real Colombian contacts are worth more than another architecture document.

## 9. Zero-rating and the poorest phone

Ask mobile operators to zero-rate the domain, and ship a text-only `lite` version under ~20 KB with no images. There is GSMA precedent for operator cooperation after major disasters, and it is a request that gets said yes to in week one and ignored in week three. For anyone with no data at all, the fallback ladder already exists: SMS → Rescue Node captive portal → paper.

## 10. Measure adoption honestly

Total reports is a vanity number — 41,000 records with a 24% duplication rate and no status updates is not 41,000 people helped.

Track instead:

- Reports **inside the affected polygon** with location precision at building level or better
- Unique people after dedup, not raw rows
- Share → report conversion, and reports per share (K-factor)
- Time from launch to 1,000 unique reports
- Percentage of records with a status change after 72 hours
- Records handed to SAR teams that led to a documented search action

---

## Open questions for the group

1. Do we allow public search by name? It is the single biggest driver of adoption — it is why people forwarded Venezuela Reporta — and it is also the biggest privacy exposure for vulnerable people. Currently unresolved in `form-spec.md`.
2. Do we accept anonymous reports with no phone number? Higher volume, weaker dedup and no closure loop.
3. Are we willing to be second and act as the dedup/heatmap layer for whoever wins the public front end?
4. Who owns the endorser relationships, and can we get one signed before the next event?

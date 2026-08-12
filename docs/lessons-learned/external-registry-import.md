# What ~5,000 real names did to an engine tuned on synthetic ones

Run: 12 Aug 2026, live PostgreSQL 16, incident `drill-quibdo`, alongside the
4,579 synthetic seed cases already in the database.

## What was imported

`ops/scrape/colombiatebusca.py` produced 4,987 listing records
(`data/external/ctb-listing.ndjson`, git-ignored). `import-external.ts` loaded
them: **4,977 created, 10 already present, 4,987 correlation jobs queued**. The
worker drained the queue in ~100 s (~20 ms/case).

Composition:

| | |
|---|---|
| status | 4,135 missing · 852 found |
| category | 4,343 Terremoto · 290 Persona extraviada · 230 Desastre natural · … |
| place | 1,466 "Pereira, Risaralda" · 853 no place at all · the rest a long tail of spellings of Cali and Pereira |
| age | missing on 1,168 (23%) |
| coordinates | **zero** — the source publishes a municipality |

Every imported case is `public_listed = false`, has no reporter phone, and has
`location_source = 'none'`. None of them touch the heat map. That is the design,
not a gap: a municipality centroid rendered as a hot cell sends a team to a plaza.

## Defect found by loading it

`is_minor` is `NOT NULL DEFAULT false`, and the importer passed `NULL` when the
source left age blank — 1,168 rows, i.e. the import aborted on the first one.
Fixed by coalescing to false, with the real answer kept verbatim in
`external_case.source_payload`. The column cannot express "unknown"; false here
means "not known to be a minor", and since imported cases are never publicly
listed, nothing is exposed on the strength of the flag.

## What the real population looks like — and where our model does not fit it

Correlation produced **182 pending pairs and 2,367 leads**; 320 distinct cases
appear in at least one pending pair. Broken down by origin:

| pair | pending | lead |
|---|---|---|
| imported ↔ imported | 86 | 2,255 |
| ours ↔ ours (seed) | 86 | 84 |
| imported ↔ ours | 10 | 28 |

Three things the synthetic seed never contained:

**1. One record is not one person.** Fifteen entries carry several people in the
name field, and 36 names are longer than 40 characters:

> `Luz Amparo,Nataly Andrea,Jhon Hamilton, karen,Marlon y Anthony Grajales vallejo,…`
> `Héctor Ignacio Herrera , Nayibeth, Niños: Juan Pablo y José David Herrera Jaramillo`

A relative reports a whole family in one submission. Our data model assumes
case = person, so these compare as one giant name against every family member's
individual entry — and they score at the very top of the queue: the two 1.000
pairs and most of the 0.80–0.93 band are a family blob matching one of its own
members. This is not a scoring bug; it is a missing intake concept.

**2. Age contradiction does not veto.** Of 182 pending pairs, 18 have an age gap
above 10 years and still sit in the queue — including `age_delta = 49` at score
0.80 ("José Juan Vivas, 16" vs a family blob whose listed age is 65). A 49-year
gap is not a duplicate under any reading. Age is currently a soft term; against
real data it needs to be a hard-negative, the way `id4_match` is a hard-positive.

**3. Names arrive with quotes, nicknames and inconsistent case.**
`Dolores "Lolita, Loli" Jaramillo Patiño` — the Spanish-surname parser added in
0012 was written for `Nombre Apellido1 Apellido2` and has no opinion about this.

Note what this does **not** show: no evidence that the phonetic work or the IDF
work matters. The failures above are structural, not marginal-similarity.

## Suite status

134 tests, 131 pass, 2 skip, **1 fail**: `the worker's enqueue path agrees with
the swept scores at the live floor` — one pair per run lands in `lead` where the
test's own scoring says `pending`, with a different uuid each run. It reproduces
on repeat runs and is not caused by the import (the test seeds its own incident).
The likely mechanism is the shortlist: `correlate_case` returns the top
`candidate_limit = 50` and the test calls it once, the enqueue path calls it
again; a pair sitting at the shortlist boundary can be inside one call and
outside the next, so it is only ever recorded from its weaker direction. If that
is right, the defect is real and not test-only: **a pair's band can depend on how
many other candidates happen to crowd the shortlist**. Not yet fixed — it needs a
repro that prints both scores, and it should be fixed before the operating point
is quoted to anyone.

## Erasing it

```sql
SELECT * FROM public.forget_external_source('colombiatebusca');
```

---

## Second pass: from "how precise is this line?" to "which building?"

Classifying each place line (`place-resolution.ts`) answered the safety
question — 1,052 of 4,989 lines are precise enough that a coordinate could ever
be sought, and 3,937 are not. But the operationally important fact was still
invisible, because it does not live in any single row.

Grouping the eligible lines into structures (`place-clusters.ts`) produced it:

| people named | structure |
|---|---|
| 93 | Hotel Dibeni, Pereira |
| 37 | Torres del Limonar, Cali |
| 26 | Parque Industrial, Pereira |
| 16 | Edificio Vanessa, Cali |
| 14 | Hospital Universitario del Valle, Cali |
| 13 | Clínica Comfamiliar, Pereira |
| 13 | Universidad Tecnológica de Pereira |

654 distinct structures; **48 named by three or more people**. That is the whole
review queue — an afternoon of human attention, not a project.

### What the folding had to survive

Every one of these arrived spelled several ways, and each variant class had to
be handled without becoming a machine that merges different buildings:

- **Vowels.** `dibeni` / `debani` / `dibani` — two edits apart. A blind
  two-edit rule at that length also swallows names that merely rhyme, so the
  rule is: two edits pass only when the *consonant skeleton* is identical
  (Spanish s/z/c, b/v, y/ll, silent h folded first). Same consonants, different
  vowels, is one word said twice.
- **Word order.** `Hotel Dibeni` / `Dibeni Hotel`. Type words are dropped from
  the identity key and the remainder is sorted. This also exposed a classifier
  gap: `Dibeni Hotel` scored *neighbourhood* while `Hotel Dibeni` scored
  *point*, so one collapsed building was two half-sized facts.
- **Type words.** `Torres del Limonar` / `Edificio Torres del Limonar` /
  `Conjunto Torres del Limonar` — one building.
- **Digits, which must NOT fold.** `bloque 1` and `bloque 2` are two buildings,
  and a team in the wrong one is exactly the failure this tool exists to avoid.
- **A trap found only by running it.** Dropping type words made
  `Aeropuerto de Pereira` and `Alcaldía de Pereira` both reduce to `pereira` —
  an airport and a town hall counted as one structure. When nothing but a town
  name survives the stripping, the type word *is* the identity and goes back in.

### Known and deliberate: it under-folds

`Edificio Vanessa` (16) and `Edificio Vanessa, Carrera 44 #9-35` (8) stay
separate, as do `Torres del Limonar` and `Torres del Limonar, Capri`. Almost
certainly the same buildings. Merging them needs containment rules that also
merge things that merely share a word, and the cost is asymmetric: an
under-fold shows a reviewer two rows instead of one, an over-fold sends a team
somewhere nobody is. A person reading the queue joins them in a second.

### What is deliberately still missing

**No coordinate.** Nothing here geocodes. Migration 0015 stores each cluster as
a `place_nomination` — a question addressed to a person — and the table refuses
to hold a latitude in `pending`, refuses an unsigned decision, and exposes
coordinates only through the `approved_place` view. The map reads that view and
nothing else.

The reason is not caution for its own sake. The source field means *last seen
at*, not *buried under*. "93 people were last seen at this hotel" is the
strongest lead in the file and still not a claim about rubble. A human decides
which it is — the same rule as the dedup queue.

Erasure keeps its one-statement promise: `forget_external_source` now sweeps
nominations first, so a labelled address with a count of zero cannot survive
the deletion of the people it was derived from.

## Geocoding: the answer is easy, the grade is the work (12 Aug 2026)

Turning a clustered structure into a coordinate took about 40 lines. Deciding
which coordinates to believe took the rest, and is the only part worth reading.

A geocoder always answers. Live, on this registry:

| line | what came back | usable? |
|---|---|---|
| Universidad Tecnológica de Pereira | amenity/university, rank 30 | yes — a campus |
| Parque la Libertad, Pereira | boundary/administrative, rank 18 | **no** — the *sector named after* the park, ~900 m across |
| Parque industrial, Pereira | place/city, rank 16 | **no** — the town centroid |
| clínica, Pereira | a real clinic, precisely located | **no** — an arbitrary one |

All four have the same shape in JSON. So every answer is graded, and the grade
is stored beside the point: `exact` (a building/amenity feature) / `street` /
`area` (a boundary that merely carries the name) / `town` (the municipality
centroid — the failure that puts a hot cell on a town square) / `none`.

Rules the live run forced, none of which were obvious beforehand:

- **Most precise wins, not most popular.** The provider ranks by importance, so
  the famous sector outranks the building inside it. Take the best *grade* out
  of five results, not the first result.
- **Wrong municipality ⇒ no coordinate at all**, not a low score. "Parque
  Central" exists in every town in Colombia; a confident point 400 km away is
  not a near miss, it is a team sent to another department.
- **A category is never asked about.** `clínica`, `el edificio` — a gazetteer
  answers with *a* clinic, precisely. But `aeropuerto de Pereira` *is* a name,
  because a town has one airport and forty clinics. The distinction is a small
  list of singular structure types.
- **Query with the readable municipality, not the identity key.** Clustering
  folds "Cali, Valle del Cauca" to the sorted key `cali cauca valle`; a
  gazetteer parses that as an address and fails. Clusters now carry both.

Result on the top 40 structures: 11 `exact` (74 people), 1 `street`, 1 `area`,
1 `town`, 26 `none`. **The two largest clusters — the hotel with 93 names and
the Cali residential towers with 37 — are not in OpenStreetMap at all.** That is
the honest headline: for private buildings, which is what collapses, automatic
geocoding does not answer the question. It clears the easy third so a human hour
goes to the hard two-thirds.

Migration 0016 keeps the suggestion in `cand_*` columns, physically separate
from the human-signed `lat/lng` from 0015. Reason: in the type system they are
identical, in meaning they are not, and one pre-filled form is all it takes for
a lookup to become a signature. `approved_place` still reads only the human
columns. `place_review_queue` shows both, with the next action spelled out.

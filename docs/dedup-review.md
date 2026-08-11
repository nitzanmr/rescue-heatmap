# Second review of the duplicate-detection engine

Status: **review only — no scoring change is made by this document.** It records what a
second, adversarial read of `correlate_case()` (0003 → 0007 → 0010) found, why the
previously reported operating point (precision 0.976 / recall 0.804) does not support the
claim it was used for, and the order in which the defects should be fixed.

> **Update, 11 Aug 2026 (migration 0012, ADR-007).** F1 and the sibling half of F2 are
> **fixed**; the hard negatives F4 asks for are **in the seed** (households: one parent,
> several children, one address, one phone — labelled `distinct` / `sibling` in
> `seed_truth`); and a defect not listed below — one reporter inflating one heat cell — is
> capped in `heat_cells()`, which is the only fix here that holds when dedup fails
> entirely.
>
> The rest (F3, F5, F6, F7, F8) is **deliberately deferred**, on an argument this document
> did not make: a heat map is a ranking, and an error that is uniform across cells changes
> no rescue decision. What is not affordable is an error correlated with severity, and F1
> and the sibling case are exactly that — they shrink the cell where a whole household is
> missing. Whether the remainder matters at all is now a measurement rather than an
> opinion: `make rank-ablation` compares cell RANKING (Spearman, top-20 overlap) between a
> perfectly deduplicated map, an undeduplicated one, and two corrupted ones (20% random
> false merges vs 20% sibling false merges). If the top-20 does not move, the pairwise work
> below does not change where teams are sent.

Two failure modes, still not symmetrical:

* a missed duplicate → two teams dig for one person. Wasteful.
* a false suggestion accepted by an operator → **one real person stops being searched for.**

Everything below is ordered by that asymmetry, not by effort.

---

## F1 — The engine scores the *reporter's* phone as if it were the *subject's* (critical) — **FIXED (0012)**

`refresh_person_index()` fills `person_index.phone_e164` from
`report.payload->>'reporter_phone'` (0003 line 229, unchanged in 0011 line 68). The intake
form has exactly one phone field, `Paso 4 · ¿Quién reporta? → "Tu teléfono o WhatsApp"`,
described to the citizen as *"para avisarte si aparece"*. There is no field anywhere for the
missing person's own number.

Consequences, all three of them wrong in the same direction:

1. `phone_match` (`w_phone = 0.15`, the third-heaviest signal) fires for **any two cases
   reported by the same person** — a neighbour who reports five neighbours, a parent who
   reports three children, a tester who submits twice.
2. The same-reporter correction `− 0.10 * (reporter_overlap AND NOT phone_match)` is
   **disabled exactly when it is needed**: for the same reporter, `phone_match` is true, so
   the intended −0.10 never applies and +0.15 applies instead. The penalty is inverted into
   a bonus.
3. Blocking widens on the same mistake: `pi.phone_e164 = s.phone_e164` pulls every case a
   reporter ever filed into one another's candidate set.

Worked example — the false suggestion Nitzan reported (two Marías, different surnames, both
entered by him):

| term | value |
|---|---|
| name (`María Gómez` vs `María Rojas`, token overlap 1/2) | 0.40 × 0.5 = 0.200 |
| geo (~100 m, `exp(-m/150)`) | 0.20 × 0.51 = 0.102 |
| **phone_match (same reporter)** | **+0.150** |
| age within 3 y | +0.050 |
| within 6 h | +0.050 |
| same building | +0.050 |
| **total** | **≈ 0.60 → `pending`, in the operator queue** |

Without F1 the same pair scores ≈ 0.45 — a `lead`, never a queued suggestion. F1 alone is
the difference between "shown on the case screen" and "proposed as the same child".

Fix: `phone_e164` must hold a *subject* phone or nothing. Either add an explicit optional
field ("¿tiene celular la persona? número") — highly discriminative in Colombia, family
members usually know it — or drop `w_phone` to 0 until such a field exists. Same-reporter
overlap must be neutral-to-negative, never positive: a reporter filing twice is weak
evidence of *different* people, because a person re-telling the same case normally uses the
`sumar` path.

## F2 — The name comparison cannot tell a sibling from a duplicate (critical) — **sibling half FIXED (0012)**

`name_tokens()` sorts tokens alphabetically, so Spanish structure (given + given +
apellido paterno + apellido materno — see *Naming customs of Hispanic America*) is
destroyed before comparison, and `name_overlap()` divides by the **shorter** token array.
Two consequences:

* a single given name against a full name scores **1.0** ("María" ≡ "María José Gómez Rojas");
* a given-name disagreement is invisible, because the surnames carry the overlap.

The dangerous direction is not the two Marías; it is **siblings**, the single most common
real pattern (one parent reports several children):

`Juan Pérez Gómez` vs `Ana Pérez Gómez`, same address, same reporter, 2 h apart →
0.4×0.67 + 0.20 + 0.15(F1) + 0.05 + 0.05 = **0.72**, reduced to 0.47 only by the gender
penalty. **Two brothers** — no gender conflict — stay at **0.72–0.77 `pending`**. Age
helps only if the gap exceeds 8 years.

Fix: decompose into given-set and surname-set before comparing; require surname agreement
when both sides carry one; make **given-name disagreement a negative term**, not a diluted
average; stop normalising by the shorter side (a subset is partial evidence, not proof).
Per-token Jaro–Winkler beats trigram on short personal names (ANU TR-CS-06-02, *A
Comparison of Personal Name Matching*) — trigram similarity is length-dependent and
punishes exactly the short tokens names are made of.

## F3 — A missing field is scored as a disagreement, so ungeolocated duplicates are unreachable

Every term is `weight × 0` when the field is absent, and the floor (0.525) is applied to
that sum. So the reachable maximum depends on which fields exist:

| realistic pair | best achievable score |
|---|---|
| true duplicate, two different reporters, no ID, **no coordinates** | 0.40 + 0.05 + 0.05 + 0.05 = **0.55** |
| same, name similarity 0.8 instead of 1.0 | **0.47 → lead only** |
| any pair, `w_semantic` (embeddings are a stub, always 0) | **−0.05 on everything, permanently** |

A true duplicate with no point on the map therefore needs a *perfect* name plus agreement
on age, time and building name just to reach the queue floor. The "Sin ubicar" queue holds
precisely those reports. This is a known, named defect with a known fix — **weight
redistribution**: renormalise over the weights of the fields that are actually comparable
for the pair (Ong et al., *Improving record linkage performance in the presence of missing
linkage data*, J Biomed Inform 2014; the Fellegi–Sunter formulation treats a missing field
as neutral, not as evidence against). At minimum, `w_semantic` must leave the denominator
while embeddings are off — today it silently taxes every pair 0.05.

## F4 — The measurement does not support the numbers, in both directions — **partly addressed (0012)**

The seed is the evaluation. Three separate validity problems:

1. **Leakage that flatters recall.** `baseReport()` and `makeVariant()` both use
   `p.phone` as `reporter_phone` (50 % of the time in variants), so synthetic true
   duplicates share a phone. Combined with F1 that hands the scorer +0.15 on pairs where
   the field would carry no signal in the field. The one feature that is *anti*-correlated
   with reality contributes positively to the measured recall.
2. **Negatives are too easy, so precision is not measured at all.** `makePerson()` scatters
   people uniformly over a 2 km box with independent random names; there are no families,
   no shared surnames, no two people in one building, no twins, no father/son with the same
   given name. Precision 0.976 is precision against *random strangers* — a population in
   which nothing collides. Every false positive actually observed (F1, F2) belongs to a
   class the seed does not contain.
3. **Pairwise metrics for a clustering task.** The goal is one case per human, not one
   correct pair. A single wrong pairwise link merges two clusters and creates a large
   number of implicit false positives; conversely a missed variant–variant pair costs
   nothing if both variants already link to a common third record. Cluster-level metrics
   are the correct instrument (Linacre, *The Challenges of Measuring the Accuracy of Record
   Linkage*, 2025; Draisbach et al., *Transforming Pairwise Duplicates to Entity Clusters*,
   JDIQ 2019; `er-evaluation`).

What the measurement should become: keep the random sweep as a regression guard, and add a
**fixed, hand-written adversarial fixture** with labels — two brothers, twins, two Marías
in one cuadra, one reporter filing four children, father and son sharing a given name, a
true duplicate with no coordinates, a true duplicate where both spellings are mangled.
Adversarial cases of this kind tell us more about field behaviour than any single
precision figure, and they are what the operator will actually see.

## F5 — Duplicate-vs-duplicate recall 0.41 is partly an artefact of pairwise accounting

0010 §4 treats it as a scoring problem and proposes phonetics. Re-reading it as a
clustering problem changes the conclusion: with transitive grouping, variant↔variant does
not need to be detected independently whenever both variants link to the base report.
`person_case.dedup_cluster_id` exists in the schema and is **never written**. Grouping the
pending/lead graph into connected components — proposed to the operator as one cluster to
confirm, still never merged automatically — recovers most of that 0.41 without touching a
single weight, and it also makes the review screen honest ("these five reports may be one
child" rather than ten separate pair decisions).

## F6 — Phonetics: `dmetaphone` is the wrong tool for Spanish

The double-metaphone path in 0010 is English-tuned. In a direct comparison on Spanish,
English/Slavic/Yiddish-derived algorithms (Soundex, Metaphone, Double Metaphone, NYSIIS)
reached a maximum precision near 10 %, with Phonem and Phonet ahead of the rest
(*Comparative Analysis of Phonetic Algorithms Applied to Spanish*, 2016); Beider-Morse is
tuned for Ashkenazic surnames, not Latin American Spanish. The transliteration noise we
actually need to collapse is a short, closed list of Spanish-specific confusions —
`h`∅, `b`/`v`, `s`/`z`/`c`, `g`/`j`, `y`/`ll`/`i`, `qu`/`k`, `x`, doubled letters — which is
cheaper and more testable as a deterministic fold in SQL than as an English phonetic key,
and needs no extension (`fuzzystrmatch` may be absent, as 0010 itself notes). Keep the
flag and the ablation; change the implementation behind it.

## F7 — Term frequency (rarity) is not in the model

`María` and `García` carry a fraction of the evidence of `Yeison` or `Mosquera`-rare
combinations, and the model weighs them identically. This is standard and well specified —
term-frequency adjustment inside Fellegi–Sunter (Splink; Yamamoto & Kawahara, frequency-based
record linkage). It cannot be validated on the current seed, where names are drawn
uniformly: **rarity weighting only shows its value against a realistically skewed name
distribution**, which is another reason F4 comes before F7.

## F8 — Smaller, real, cheap

* **Age tolerance is absolute.** `age_delta ≤ 3 → 1.0` treats a 2-year-old and a
  5-year-old as the same age. Tolerance must scale with age (e.g. ±1 y under 5, ±3 y under
  15, ±5–8 y for adults).
* **Field dependency / double counting.** Geo decay and the same-building bonus are
  strongly correlated; so are `lex_rank` (unused) and the name term, since the tsvector
  includes the name. Conditional independence is assumed and violated; combined location
  evidence should be capped.
* **`refresh_person_index()` averages coordinates** (`avg(lat)`, `avg(lng)`) across a
  case's reports. The mean of two points 400 m apart is a spot **nobody reported** — it can
  land in the river. Take the point with the best provenance/accuracy (0011 already records
  both), not the centroid.
* **`max(age_approx)`** as the case age is arbitrary; use the value from the most reliable
  or most recent report, consistently with every other field.
* **Two magic numbers escaped config** — the `0.05` building bonus and the `−0.25` gender
  penalty are literals inside the function while everything else is in
  `correlation_config`. An operator cannot loosen them at 3 a.m.
* **`lex_rank`** is computed on every candidate and used nowhere: pure cost. Either give it
  a weight and measure it, or stop computing it.

---

## Order of work

Revised 11 Aug 2026 (ADR-007). The ordering principle changed: not "worst defect first"
but **"worst defect that is correlated with severity first"**, because a uniform error in
cell weight does not change a ranking and therefore does not change a rescue decision.

**Done (migration 0012):**

1. **F1** — phone semantics. `person_index.phone_e164` holds a subject phone or nothing;
   the optional `subject_phone` field exists on the form and in the intake schema; the
   same-reporter penalty is unconditional.
2. **F2, sibling half** — `given_tokens` / `surname_tokens` split the name before the
   alphabetical sort; surname agreement with given-name disagreement is a configurable
   penalty; a matching document number suppresses the rule; a one-character typo does not
   trigger it (`given_conflict_sim`). Known cost, accepted: hypocorisms (Pepe/Jose) now
   read as two people.
3. **F4, hard negatives** — households are in the seed and labelled `sibling`, so
   precision is finally measured against a population that collides. The adversarial
   fixture is `test/dedup-semantics.test.ts` (eight named pairs, including the two that
   must NOT be demoted).
4. **Not on this list originally, and the cheapest of all** — a per-reporter cap on what
   one phone can contribute to one heat cell (`heatmap_config.reporter_cell_cap`). It is
   the only fix that neutralises family inflation *whether or not* the duplicates were
   ever detected.
5. **F8, the config half** — the building bonus and the gender penalty moved out of the
   function body into `correlation_config`.

**Waiting on a measurement, not on effort (`make rank-ablation`):**

6. **F3** — weight redistribution for missing fields; `w_semantic` out of the denominator.
7. **F5** — write `dedup_cluster_id`; group leads/pending into components for review. This
   is what would show an operator a household as one cluster of distinct people, which is
   the constructive counterpart to the sibling penalty.
8. **F6/F7** — Spanish fold and rarity weighting, behind the existing flag.
9. **F8, the rest** — age tolerance scaling with age, the location double-counting cap,
   `max(age_approx)`, and deleting `lex_rank` or giving it a weight.

If the ablation shows the top-20 cells unchanged by both corruption regimes, 6–9 are not
worth doing before real data arrives, and saying so out loud is cheaper than doing them.

Nothing here changes the invariant: the engine proposes, a human decides, and every merge
stays reversible with its evidence recorded.

### Sources

* Splink — *The Fellegi–Sunter model*; *Term frequency adjustments*.
* Ong TC et al., *Improving record linkage performance in the presence of missing linkage
  data*, J Biomed Inform 2014 (weight redistribution).
* Linacre R., *The Challenges of Measuring the Accuracy of Record Linkage*, 2025
  (labelling, adversarial testing, cluster-level metrics).
* Draisbach U. et al., *Transforming Pairwise Duplicates to Entity Clusters for
  High-quality Duplicate Detection*, JDIQ 2019.
* Christen P., *A Comparison of Personal Name Matching: Techniques and Practical Issues*,
  ANU TR-CS-06-02.
* *Comparative Analysis of Phonetic Algorithms Applied to Spanish*, 2016.
* *Naming customs of Hispanic America* — paternal surname first, two surnames, order varies.

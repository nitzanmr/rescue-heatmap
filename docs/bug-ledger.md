# Bug ledger

Every defect this project has actually shipped or nearly shipped, in one place.

**Why this file exists.** The reasoning behind each fix already lives in its commit
message, and the rules that came out of them live in `AGENTS.md`. Neither answers the
question you ask before writing code: *"has this class of mistake bitten us before?"*
This file does. It is a checklist, not a history.

**How to use it.** Before you write a migration, a scorer change, a map layer or an
import path, read the class table below and check your change against the classes that
touch it. Before you claim a change is done, run the "recurrence checks" at the bottom.

**How to extend it.** One row per defect, appended in the same commit that fixes it.
Never edit a row to make the past look better — this file is append-only in spirit, the
same rule as the migrations.

---

## The seven classes

Ordered by how much damage the class causes in a live event, not by frequency.

| # | Class | What it looks like | Count so far |
|---|---|---|---|
| A | **Work that disappears silently** | Everything returns 200/green; the data is simply not there | 8 |
| B | **Confidence not earned** | A coordinate or a score that looks precise and is invented | 5 |
| C | **A measurement that measured something else** | The number quoted came from a different engine, or from a race | 4 |
| D | **The environment guessed instead of configured** | Behaviour inferred from a hostname, a port, a machine | 5 |
| E | **A schema/type error only a live DB can find** | Static checks clean, first real call raises | 4 |
| F | **The UI swallowed the reason** | A blocked control that does not say why | 3 |
| G | **Real data broke an assumption synthetic data never tested** | One row ≠ one person; blank fields; site markup drift | 5 |

**Class A is the one that kills.** In a rescue tool, a loud failure costs a retry and a
silent one costs a person. Every class-A entry below passed every check we had at the
time.

---

## The ledger

### Class A — work that disappears silently

| id | Defect | Root cause | Found by | Fixed |
|---|---|---|---|---|
| A1 | A report with an address but no coordinate was accepted and never reached the heat map | The form claimed a precision the payload had no point for | Reading the intake path | `8eb2d4f` |
| A2 | A NULL similarity score removed a pair from the queue entirely — not as a rejection, as nothing | `x IS NOT NULL AND x = y` yields NULL when `y` is null; one NULL nullified the sum, and `NULL >= floor` is false | First run against live PostgreSQL | `a6008ef` (0013) |
| A3 | `ORDER BY score DESC` is NULLS FIRST — unscorable pairs sorted to the top and evicted real candidates from the LIMIT | Same as A2, second consequence | Same run | `a6008ef` |
| A4 | The weaker direction of an asymmetric pair demoted it from `pending` to `lead`, so it left the operator queue | `state = EXCLUDED.state` on upsert | Same run | `a6008ef` |
| A5 | A merge dropped a person out of a building's head-count with nothing saying so | Structure links stayed on the swallowed case; every reader filtered `merged_into IS NULL` | Self-review of 0018 | `bf77324` (0019) |
| A6 | A signed `clear` stayed signed after an unresolved person was attached afterwards | 0018 guarded the signing moment only, not the state | Self-review of 0018 | `bf77324` |
| A7 | A legitimate heat cell rendered as nothing — below the first gradient stop | Intensity normalised against the hottest cell only | Field report (Oshri) | `6548e65` |
| A8 | Editing the address after confirming a point discarded the coordinate without a word | The discard was correct; the silence was not | Field report (Oshri) | `6548e65` |

### Class B — confidence not earned

| id | Defect | Root cause | Found by | Fixed |
|---|---|---|---|---|
| B1 | A municipality centroid became a 500 m red cell and would have sent a team to a plaza | A geocoder answers "Pereira" and "Parque la Libertad" with the same confidence | Classifying the real harvest | `352c9bd`, `f0d84c3` |
| B2 | The bare word "clinica" resolved to a real, precise, arbitrary clinic | A gazetteer always answers | Live geocoding run | `f0d84c3` |
| B3 | `phone_match` fired for any two cases filed by the same reporter, and disabled the same-reporter penalty exactly when it was needed | `person_index.phone_e164` was filled from the *reporter's* number | Dedup review | `7f2f3bf` (0012) |
| B4 | Siblings scored as one child — surnames agreeing while given names disagreed was averaged away | Name tokens sorted alphabetically before comparison | Dedup review | `7f2f3bf` |
| B5 | One family could manufacture a hotspot | No per-reporter per-cell contribution cap | Dedup review | `7f2f3bf` |

### Class C — a measurement that measured something else

| id | Defect | Root cause | Found by | Fixed |
|---|---|---|---|---|
| C1 | Every recall figure we quoted came from a more generous engine than the field one | Test called `correlate_case(case, 50)`; worker and panel called it with 25 | Precision/recall sweep | `e20442b` (0010) |
| C2 | The suite flapped by exactly one pair per run, with a different uuid each time | `ORDER BY score DESC` with no tie break — equal scores straddling the LIMIT swapped | Repeated runs | `e20442b` |
| C3 | ms/case was timing a race: the drill's worker scored the test's own cases in parallel | `seed()` enqueued jobs unconditionally | Reproducibility check | `6ac778f` (`SEED_ENQUEUE=1`) |
| C4 | Tests and ablation measured the *previous* schema for a while | A build failure killed the drill before `down -v`, so 0008–0010 were never applied | Investigating the SSR crash | `462d3e5` (`requireFreshSchema()`) |

### Class D — the environment guessed instead of configured

| id | Defect | Root cause | Found by | Fixed |
|---|---|---|---|---|
| D1 | TLS to the database inferred from `localhost` in the connection string; compose hostname `db` was treated as a managed provider | Hostname inference | Drill | `6915dad` (`DB_SSL`) |
| D2 | `network: host` committed as the default for every clone to work around one host's DNS | A machine's property became a repo default | Review | `05d821d` (`BUILD_NETWORK`) |
| D3 | `DB_PORT` hardcoded to 5432 while the drill ran on 55432 | Same class | Drill | `6915dad` |
| D4 | Share links and QR codes pointed at `buscamos.co` from a staging deployment | Base URL hardcoded unless set at build time | Tailscale deployment | `ea00a6b` |
| D5 | A stale `rescue-api:dev` made a run apply 0001–0006 and never see 0007 | The drill reused a cached image | Drill | `0222165` |

### Class E — schema/type errors only a live DB finds

| id | Defect | Root cause | Found by | Fixed |
|---|---|---|---|---|
| E1 | `correlate_case()` raised at RETURN — the dedup engine was dead in every environment, and the drill still printed "passed" | `extract(epoch FROM interval)` is numeric in PG14+, returned into a double precision column; the failure lived in the worker, not the HTTP path | Drill hardening | `2d6dd7e` (0007) |
| E2 | `type extensions.geography does not exist` | PostGIS is `relocatable = false`; `CREATE EXTENSION ... WITH SCHEMA extensions` was a no-op and every qualified reference pointed at an empty schema | Drill | `96a0b29` |
| E3 | `project_structure_point()` referenced an alias it does not declare (`o.case_id = sc.case_id`) — raised on first call | Untestable without a database | Self-review of 0018 | `bf77324` |
| E4 | `npm ci` rejected the lockfile (`@types/node` 20 pinned against ^24) | Lock not regenerated | CI | `b2abc0c` |

### Class F — the UI swallowed the reason

| id | Defect | Root cause | Found by | Fixed |
|---|---|---|---|---|
| F1 | "punto exacto" did not respond to a tap and read as broken | `disabled` on a phone swallows the tap with no reason; the chip was correctly capped by the accuracy ceiling | Field report (Oshri) | `6bc3a1f` |
| F2 | 103 of 108 shelters were invisible — a layer off by default reads as "does not exist" | Safety argument served by hiding instead of by rendering | First tester | `04ec541` |
| F3 | The dedup modal's "sumar" was an orphan: it fired a sighting at the wrong candidate before the report had a server id, and the wording read as a merge | Client action with no server contract | Field tester | `815e9bb` (0017) |

### Class G — real data broke a synthetic assumption

| id | Defect | Root cause | Found by | Fixed / recorded |
|---|---|---|---|---|
| G1 | Import aborted on its first row: `is_minor` is NOT NULL, the source leaves age blank on 1,168 of 4,987 | A column that cannot say "unknown" | Live import | `fc41442` |
| G2 | One record is not one person — 15 entries list a whole family in the name field, and those blobs score at the *top* of the queue against their own members | Missing intake concept, not a scoring bug | Live import | Open, recorded in `lessons-learned/external-registry-import.md` |
| G3 | Age contradiction does not veto — one pair sits at 0.80 with a 49-year gap | Weighted sum with no hard constraint | Live import | Open |
| G4 | The scraper returned zero cards on every page and said nothing | Card href is `/?person=<uuid>` on page 1 and `/?page=N&person=<uuid>` afterwards; the parser anchored on position, not parameter | Verifying a different change | `f678ec0` |
| G5 | One hotel written four ways was never counted together — 93 names on one building | Place strings folded per row, not per structure | Live harvest | `22d85b0` |

---

## Recurrence checks

Run these against your own change *before* saying it is done. Each one exists because
of a numbered row above.

**Silent loss (A)**
- If your change can drop a row, a person or a point from a count — name the place that
  says so out loud. A green path and a missing person is the worst outcome available.
- Any SQL predicate comparing two nullable columns: does it survive one side being NULL?
  Does the sum? Does the `>=` after it? (A2)
- Any `ORDER BY` on a nullable column: `NULLS LAST`. (A3)
- Any upsert on a state machine: can it move a row *backwards*? (A4)
- Anything that reads cases: does it handle the merge chain, or does it filter
  `merged_into IS NULL` and lose the survivor's inheritance? (A5)
- Any invariant enforced at a moment: what happens when the world changes *after* that
  moment? (A6)

**Earned confidence (B)**
- Any coordinate: what grade is it, who signed it, and does the display say the grade in
  words? A gazetteer always answers — grade the answer and never sign it. (B1, B2)
- Any similarity signal: whose attribute is it actually? (B3)
- Any averaged score: is there a disagreement in it that should be a penalty rather than
  dilution? (B4)

**Honest measurement (C)**
- The test must call the same function with the same parameters as the worker. Config
  the parameter once; fail the build on a literal. (C1)
- Deterministic tie break on every shortlist. (C2)
- Nothing runs concurrently with a measured pass. (C3)
- Every DB-backed test calls `requireFreshSchema()` first. (C4)
- Never quote one operating point as "the accuracy".

**Configuration, not inference (D)**
- No behaviour from a hostname, a URL substring or `NODE_ENV`. (D1)
- A workaround for your machine goes behind a variable with a neutral default and a line
  in the runbook. (D2, D3)
- The drill must test the current checkout, not a cached image. (D5)

**Live database (E)**
- `tsc`, the static tests and `next build` cannot see a bad alias, a numeric/double
  mismatch or a schema-qualified extension. A migration is not verified until it has run
  against PostgreSQL. In this workspace that means: **verified statically here, run at
  Nitzan's.** Say which one you did.

**The screen (F)**
- No `disabled` on a control a user might reasonably try. A blocked control explains, on
  tap, in terms of the action that unblocks it.
- A layer that is off by default reads as "does not exist". Render the caveat on the
  object, not by hiding it.

**Someone else's data (G)**
- Assume blank fields, whole families in one name field, and markup that changed since
  you last looked. Assert the parser found *something* and fail loudly when it does not.

---

## What has never bitten us — and why that is not comfort

No defect so far has leaked personal data publicly, and none has merged two people
automatically. That is not luck: `public_case_view` is the single filter and merging
requires a human. It does mean both are untested by failure, so treat any change near
either one as the highest-risk change in the repo.

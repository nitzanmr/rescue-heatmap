# Structures — the unit a rescue team is dispatched to

**Status:** implemented in `0018_structure_entity.sql` (13 Aug 2026)
**Why now:** an Israeli SAR delegation lands in Cali. What they need is not a heat map. It is a
list of buildings, the people named against each one, and a way to sign "we searched this, it is
clear".

---

## 1. What was missing

The database knew about people (`person_case`), about questions concerning free-text places
(`place_nomination`, 0015/0016), and about one operator's point for one person
(`case_location_override`, 0011). It did not know about **buildings**.

A nomination is not a structure. It is a folded spelling of a string, it dies when its source is
forgotten (`forget_external_places`), and it has no operational state. Hanging "cleared / not
cleared" off it would put a rescue decision on a row whose entire purpose is data hygiene.

So the Cali target dossier was assembled *outside* the product — a registry of 7 buildings and a
tracker of 136 anchor names in the working space. That is scaffolding, and scaffolding during an
event becomes a second source of truth that contradicts the first. **0018 is what lets the
scaffolding be deleted.**

## 2. The model

| Table | What it is |
|---|---|
| `structure` | A building. Name, address, an optional **graded and signed** point, a scan state, authority verification. |
| `structure_case` | A person named against a building, with a **resolution** for *this* building. |
| `structure_event` | Append-only log: who moved the pin, who signed the scan, who resolved whom. `app_rw` may insert, never rewrite. |
| `structure_board` (view) | One row per structure with open head-count, minors and 65+ counted separately. Counts only — no names. |

### Resolution is about the link, not the person

`structure_case.resolution` is one of `unresolved`, `recovered_alive`, `recovered_deceased`,
`not_at_structure`, `withdrawn`. It answers **"is this person still to be searched for in THIS
building"** — never "what happened to this person". `person_case.status` remains the only place
that says a person was found or died, and it is changed through its own route with its own
signature. A body recovered and a person found at their sister's house must not be one click.

## 3. The one invariant

> A structure may not be marked `clear` while anyone linked to it is unresolved.

Enforced by a trigger (`structure_no_silent_clear`), not by the API — an operator on a screen, a
script and a `psql` session must all hit the same wall. "Clear" is the sentence that makes people
stop digging.

When the panel is refused, it does not grey a button out: `structure_blockers(id)` returns the
people standing in the way, the route answers `409 structure_has_open_cases` with that list, and
the card names them. A blocked control that will not say why reads, correctly, as broken.

## 4. Points: graded, signed, never invented

- A structure has no point until somebody places one. `lat` without `lng` is refused; a coordinate
  without a `point_precision` is refused; a point without `point_set_by` and `point_set_at` is
  refused.
- Vocabulary is 0016's, deliberately: `building | street | area | town`. There is no `exact` —
  staff working from a written address are locating a building at best.
- The board says the grade **in words** next to the head-count ("solo calle ±150–200 m"), because
  a street-level pin and a door are different objects and a colour cannot say that.

### `project_structure_point()` — the field workaround, made a rule

During the Pereira load, approving a place put nothing on the heat map and the points were copied
into `case_location_override` by hand. That work was right; this function is it, with three guards
the manual copy did not have:

1. **Refuses an `area`/`town`-grade point.** Projecting a municipality centroid onto 48 people
   manufactures a hotspot on a square where nobody is buried — and afterwards it is
   indistinguishable from real data.
2. **Never overwrites an existing location.** A family's GPS fix outranks a building pin, always.
3. **Caps the claim.** A `street` pin becomes `block` accuracy on each person, never `building`.

It leaves provenance (`structure_event`, note carrying the structure's name) and refreshes the
person index, which is the step whose absence made approvals invisible on the map.

## 5. Loading the dossier

```sh
ACTOR=nitzan make structures                                    # dry run, no database needed
INCIDENT=cali-2026 ACTOR=nitzan LINK=1 LOAD=1 make structures   # writes
```

- `--actor` is **mandatory**: somebody's name goes on every point.
- An import **may not** mark a structure clear.
- An unknown precision word is an error, never a default — silently degrading it would hide a
  building-grade pin behind a refusal, and silently promoting it would do something far worse.
- A re-run never overwrites a pin whose source is `operator_pin`.
- `LINK=1` attaches people through the existing place-nomination fold (0015) rather than
  re-matching strings, so there is only ever one matcher to be wrong.

## 6. What this is not

- It is not a second dedup engine. Nothing in 0018 writes `merged_into`, touches `person_case`, or
  can express "these two are the same person".
- It is not a public surface. Every route is operator-only and audited; the board carries counts,
  and names live behind the audited detail route.
- Erasure keeps working: `structure_case` cascades from `person_case`, so forgetting a person under
  Ley 1581/2012 takes their structure links with them.

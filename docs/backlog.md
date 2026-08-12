# Backlog — tickets not yet built

Small file on purpose. A ticket lands here when we agreed it matters but chose not
to build it now. Each ticket says what breaks today, what "done" means, and what it
must refuse to do.

---

## RH-01 — Create an incident from the control panel UI

**Status:** open · **Raised by:** Nitzan, 12.8.2026 · **Size:** ~half a day

**What breaks today.** Creating an incident is a Makefile target that shells into
psql:

```
SLUG=sismo-choco-2026 NAME="Sismo Chocó 2026" LAT=4.8133 LNG=-75.6906 make incident
```

That means the first act of every deployment requires a terminal, the repo, and
docker access on the host. In a real activation the person who knows the incident
name, the affected municipalities and the map centre is a coordinator, not whoever
has the shell. Today they have to dictate coordinates over the phone to a developer.
It is also the one step with no audit row: nobody can later tell who opened the
incident, or when.

**Done means.** In `/panel`, an operator can:
- see the list of incidents with their slug, status (open / retired), case count,
  and which one the public map answers with by default;
- open a form: name, slug (auto-suggested from the name, editable, immutable after
  first import), country, reference prefix, map centre picked **on a map** rather
  than typed as two floats, bounding box, public expiry;
- create it, and be told plainly that it is now the active incident for the public
  map — or that it is not, if another one is open;
- retire an incident from the same screen (reversible), with the purge staying
  CLI-only and CONFIRM-gated.

**Must refuse to do.**
- No delete button in the UI. `purge` is irreversible and stays in the shell.
- No editing the slug once the incident has cases — the slug is what field teams
  and public tracking codes are printed against.
- No silent switching of which incident the public map answers with. If creating an
  incident changes what the public sees, the screen says so before saving.
- Every create / retire writes an audit row with the operator and timestamp, like
  merge decisions do.

**Notes for whoever builds it.**
- API side: new `POST /v1/panel/incidents`, `GET /v1/panel/incidents`,
  `POST /v1/panel/incidents/:slug/retire` in `services/api/src/routes/panel.ts`.
  The insert is the same SQL the `incident` Makefile target already runs
  (`ON CONFLICT (slug) DO UPDATE SET name`), so behaviour stays identical whichever
  door you come through.
- The Makefile target stays. A UI that is the only way in is a UI that blocks
  recovery when the web app is down.
- **Blocked-adjacent:** `app/web/src/lib/incident.ts` still hard-codes Quibdó as map
  centre and bbox. Whatever this form writes to the DB is ignored by the map until
  that file reads incident geography from the incident row instead of a constant.
  Doing the ticket without that is a form that appears to work and changes nothing.

---

## RH-02 — Per-site anchor list ("rescate" roster per worksite)

**Status:** open · **Raised by:** O and Nitzan, 12.8.2026

Clicking a point on the map should open the roster of everyone reported missing at
that structure, and the roster should shrink over time as people are accounted for:
rescued alive, recovered dead, or found outside the site. The end state is a signed
decision that the structure is **cleared**.

This is O's operational doctrine — worksites are classified by structure, and the
roster is the working document. Our place clustering (migration 0015) already
produces the candidate rosters; what is missing is the state machine on top:
per-person outcome, who recorded it, and a site-level "cleared / not cleared" that
requires every name to be resolved or explicitly written off.

Warning already learned from the data: some clusters are neighbourhoods, not
buildings (Parque Industrial, Pereira — 59 records across `sector A..E`). A roster
UI must let a site be split into sub-sites, or it will invite a team to treat a
neighbourhood as one worksite.

---

## RH-03 — Click a heatmap cell in the panel and see who was reported there

**Status:** open · **Raised by:** Nitzan, 12.8.2026 · **Evidence:** Oshri, same day
· **Size:** ~a day

**What breaks today.** The heatmap endpoint returns *aggregates only* — cell
centroid, weight, case count. Names and reference codes never reach the browser.
That is the correct privacy boundary for the public map, but the panel inherits it,
and there it is wrong: an authenticated operator who sees a hot cell and cannot ask
"who is in it" is looking at a picture they cannot act on.

This is not theoretical. Oshri filed three reports at a point he marked himself,
saw three cases appear on the panel map, and had **no way to tell which cases they
were** — he only knew because he had picked the coordinate personally. In the field
nobody will have that.

**Done means.** In `/panel`, clicking a cell (or a clustered site) opens a side
panel listing, for every case inside that cell:
- display name, age, reference code, status;
- number of distinct reports and whether a merge is pending in the review queue;
- source — our intake form vs. external registry — visibly different, because
  "where they were when the building fell" and "where they were last seen" are not
  the same claim;
- link back to the source record for imported rows;
- export the list for the site (CSV) for a team going out.

Cell radius follows the panel's existing 100 m grid; a click on the coarser public
grid resolves to the finer cells beneath it.

**Must refuse to do.**
- **Panel only, behind auth.** The public map keeps returning aggregates with the
  `cases >= 2` floor. No route added here may serve names unauthenticated.
- No lookup by free coordinate — the query takes a cell id / site id the server
  itself issued, so the endpoint cannot be walked as a "who is at this address"
  API.
- Every open of a roster writes an access audit row. Reading names is an action.
- No implicit merging in this view. Two rows that look like the same person stay
  two rows and go to the review queue; the roster shows the suspicion, a human
  decides.

**Notes for whoever builds it.**
- Server side: a `GET /v1/panel/cells/:cellId/cases` next to the existing heatmap
  route in `services/api/src/routes/panel.ts`, reusing the same cell function so
  the list can never disagree with the square that was clicked.
- This is the read half of RH-02. Build it first: the roster state machine
  (rescued / recovered / found outside / site cleared) is worth much more once
  there is a screen that shows the names at all.
- Related wording bug found the same day: the intake button `sumar mi información`
  reads as "add me to that case" but actually files a separate report with a note.
  Fix the copy while in this area.

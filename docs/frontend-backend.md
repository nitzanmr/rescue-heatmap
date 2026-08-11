# The web app and the API

Until now the PWA rendered from a `mock.ts` array in `localStorage`. It looked
finished and it was not connected to anything. This document describes how the
two halves are joined, and — more usefully — which decisions are load-bearing.

## Shape

```
browser ──/api/*──▶ Next.js server ──rewrite──▶ API (http://api:8080) ──▶ Postgres
```

The browser only ever calls a **relative** `/api/...` path. Next rewrites it to
`API_ORIGIN` (`next.config.mjs`).

Why not call the API directly from the browser:

- **Same origin means no CORS**, and therefore no preflight on the intake POST.
  On a degraded cell tower that is one round trip per report, not zero.
- **One hostname to configure** during an activation instead of two. The API's
  address is a server-side environment variable; moving the API does not rebuild
  the client.
- **One DNS lookup** on a phone with a bad connection.

The single exception is `app/r/[ref]/page.tsx`, which fetches the API directly
for link-preview metadata. It runs on the server, where a relative path has no
origin to resolve against, so it uses `API_ORIGIN` too.

## The offline queue (`lib/outbox.ts`)

This is the file that decides whether "works without a signal" is a claim or a
fact. Three properties:

1. **Persist before you send.** A submitted report is written to storage before
   any network call. A report lost because the tab was closed mid-request is not
   recoverable, and the person it describes is under rubble.
2. **The device generates a uuid, and it is the idempotency key.** It is sent as
   `uuid` on the wire; the API returns the original answer on replay. Three
   retries produce one case.
3. **"No signal" and "no" are different answers.** A transport failure retries
   forever. A 4xx does not — resending the same rejected bytes is a loop, so it
   surfaces to the person instead.

The photo is uploaded **after** the report is accepted, never with it. Text is
what the rescue teams need; a 200 KB image must not be able to hold it hostage.
Once the bytes are on the server they are dropped from `localStorage`.

### The reference number is not ours to invent

The old flow minted a reference on the device, so the confirmation screen could
show one instantly. That is wrong: the server issues references, and a retry
would produce a different one for the same person — the family writes down the
number that does not exist.

So while a report is queued, the confirmation screen says exactly that: it is
saved on this phone, it has not been sent, and **the reference arrives with the
acknowledgement**. This is worse UX and correct.

### The private link is shown once

`POST /v1/reports` returns a `reporter_token`. The server stores only
`sha256(pepper + token)`, so it cannot be reissued. The confirmation screen says
so plainly, and `/mi-reporte/<ref>` is where a family corrects the report,
withdraws consent or asks for erasure — a right that requires emailing a
stranger is not a right.

Tokens arriving in a URL (`/r/ABCD?t=…`) are captured and **stripped from the
address bar**: a token in a URL ends up in screenshots, chat previews and
history.

## What the browser is not allowed to have

Deleted, and kept deleted by `services/api/test/frontend-wiring.test.ts`:

| Removed | Why |
|---|---|
| `lib/mock.ts`, `lib/store.ts` | The browser held every report, including other people's. |
| `lib/dedup.ts` | A second correlation implementation drifts from `correlate_case()`. |
| `newReferenceNumber()` | See above. |
| `reportWeight()` | The heat weighting lives in SQL. Two copies of one formula diverge, and the map would stop matching the ranking the teams work from. |

The map takes **aggregated cells** from `heat_cells()`, never case points.
Coarsening in the client is not coarsening: the exact coordinates would sit in
the network tab.

## Panel authentication

There is no password login endpoint, on purpose — an emergency is the worst
possible moment to invent authentication. An operator token is minted server
side and pasted into `/panel` once:

```
make operator-token EMAIL=ana@ungrd.gov.co ROLE=admin DAYS=7
```

It is printed once, hashed at rest, and expires. The export button carries the
token rather than being a plain link, because the export is audited: "who took a
copy of the missing list" is a question we must be able to answer.

## Running it

```
make up                     # db + api + worker + web
# http://localhost:3000     reportar / buscar / panel
# http://localhost:8080     the API directly
```

`make drill` now also builds and starts the web tier and asserts:

1. `GET /api/readyz` **through the web container** — the proxy is real;
2. a report submitted through the web origin is accepted;
3. its public card resolves;
4. `/r/<ref>` renders the case server-side.

A web container that boots but cannot reach the API is exactly the failure this
repository shipped with, and a green drill must not be able to hide it.

## Environment

| Variable | Where | Meaning |
|---|---|---|
| `API_ORIGIN` | web (server) | Where `/api/*` is forwarded. `http://api:8080` in compose. |
| `NEXT_PUBLIC_API_BASE` | web (browser) | Override the relative base. Leave unset. |
| `NEXT_PUBLIC_BASE_URL` | web | Public host used in shared links and QR codes. |
| `NEXT_PUBLIC_DEMO` | web | `0` only for a real activation. Anything else shows the "not a real deployment" banner. |
| `WEB_PORT` | compose | Host port for the PWA (default 3000). |

## Still not done

- **`media_derive` is a stub.** A photo uploaded for a minor has no blurred
  derivative, so the public card shows no photo at all for minors. That is the
  safe direction of the failure, and it is still a gap.
- **Sightings do not notify anyone.** They land in the panel and in the family's
  private page; nothing pushes them.
- **No service worker.** The outbox survives a closed tab, but the app itself
  must be loaded once while online. A real PWA install story is separate work.

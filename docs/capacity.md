# Capacity: what one box actually serves

Written because the question "how many people at once?" was answered with an
estimate, and an estimate is not a number. The last section says how to get the
number. Everything before it is the reasoning that makes the number predictable.

## What runs, and what competes with what

Five processes: Postgres, the API (Fastify, **one** Node process, one event
loop), the worker, Next, nginx. Postgres and the API contend for the same cores,
and neither has a `deploy.resources` limit — under pressure whichever asks first
wins.

The load splits into three shapes, and they fail in this order:

| Path | Cost | Cached? |
|---|---|---|
| `/v1/public/heat` | highest: `heat_cells()` reprojects every indexed person of the incident into a metre grid | **yes** — 30 s at the edge, 20 s in process |
| `/v1/public/aid-sites` | one function call, up to 5000 rows | **yes** — 120 s at the edge, 60 s in process |
| `/v1/public/search` | trigram + FTS per caller | **no, and never** — it is a named-person query |
| `POST /v1/reports` | one insert + one enqueue | no (a write) |
| correlation | 50 candidates per case, in the worker | asynchronous by design |

## The cache is the capacity decision

Before the cache, every phone that opened the map ran the most expensive query
in the system. Everyone sees the same map, so that work was being repeated
thousands of times to produce identical bytes.

Now: **one query per 30 seconds**, no matter how many phones. Concretely, at
30 000 cases and 300 concurrent viewers, the heat layer goes from ~300 grid
recomputations per 30 s window to 1.

Two properties matter as much as the speed:

* **`proxy_cache_lock`** — a cold cache under load sends *one* request upstream
  and makes the rest wait. Without it, the first second of a traffic spike sends
  the expensive query once per connection: the stampede that turns a slow query
  into an outage.
* **`proxy_cache_use_stale updating error timeout http_5xx http_429`** — when the
  API is down, restarting or rate-limiting, the map keeps drawing the last good
  answer. **A blank map reads as "nobody is missing here."** That is the worst
  lie this system can tell, and it is worth serving a 90-second-old picture to
  avoid it.

What is **not** cached, deliberately: search, the shared card, media bytes,
everything in the panel. A cache entry is shared between callers by definition,
so caching a per-caller authorisation decision would eventually serve one
family's answer to a stranger. `services/api/test/public-cache.test.ts` fails if
anyone widens the cache to those paths, and `make drill` proves at runtime both
that heat *is* cached (MISS then HIT) and that search is *not*.

## Sizing

Postgres memory is now stated in `docker-compose.yml` and overridable, because
the same file runs on very different machines. `max_connections` dropped from
200 to 60: our pools ask for 8+8, and a 200 limit on a small box is not headroom,
it is permission to OOM.

**2 vCPU / 4 GB** (the defaults):

```
PG_MAX_CONNECTIONS=60 PG_SHARED_BUFFERS=1GB PG_EFFECTIVE_CACHE=2GB \
PG_WORK_MEM=16MB PG_MAINTENANCE_WORK_MEM=256MB
```

**4 vCPU / 16 GB** — put the RAM where it changes things (the working set fits
in cache, and the worker gets a second core to itself):

```
PG_MAX_CONNECTIONS=100 PG_SHARED_BUFFERS=4GB PG_EFFECTIVE_CACHE=12GB \
PG_WORK_MEM=32MB PG_MAINTENANCE_WORK_MEM=1GB \
WORKER_CONCURRENCY=4
```

On 4 cores the API is still **one** event loop. If a load run shows the API
saturating one core while three sit idle, the fix is a second API container
behind the same edge (nginx already balances an upstream with two servers), not
a bigger box. That change is three lines and should be made only once a
measurement asks for it.

Rough shape of what to expect once heat and aid-sites are cached: browsing
capacity stops being a function of case count (everyone shares one cached
answer) and becomes a function of how many *searches* per second the box can
run. Which is why the number below has to come from the machine.

## Getting the real number

```
make load                        # against the local edge, drill incident
EDGE_PORT=8443 DURATION=30 STEPS="10 50 200 500" make load
```

`ops/load/run.sh` is curl and awk on purpose — no image to pull, so it works on
an activation week with no outbound network. It ramps concurrency against heat,
aid-sites, search and intake, and prints n / rps / p50 / p95 / max / 429s /
errors per step.

How to read it:

* **heat and aid p95 flat as concurrency climbs** — the cache is absorbing the
  load. If p95 climbs linearly instead, the cache config is not in effect; the
  drill check exists to catch exactly that.
* **search p95** is the real ceiling for browsing.
* **intake 429s** are the rate limiter working. `intake err > 0` is not.
* **any errors at low concurrency** are a bug, not a capacity limit.

Never point `make load` at a deployment holding real families: the intake step
writes.

// A tiny in-process cache with single-flight, for AGGREGATE public layers only.
//
// The edge (ops/edge/nginx.conf) already caches these two endpoints for every
// browser. This exists for the case the edge is not there: on a managed host
// (Cloud Run behind a Google load balancer, Fly, a bare container on a laptop)
// there is no nginx of ours, and then `heat_cells()` runs once per request per
// phone. The layer that must not go blank under load cannot depend on a piece
// of infrastructure we might not deploy.
//
// Two properties matter more than the caching itself:
//
//   1. SINGLE FLIGHT. Ten simultaneous misses run ONE query and share its
//      promise. Without this, a cold start under load sends the most expensive
//      query we own to the database once per connected phone.
//
//   2. STALE ON FAILURE. If the refresh throws and we still hold a recent
//      answer, we serve the stale answer. A blank map reads as "nobody is
//      missing here", which is the worst lie this system can tell; a map that
//      is 40 seconds old reads correctly.
//
// What must NEVER go in here: anything about a named person. This cache is
// keyed by URL-ish strings with no actor in them, so an entry is by definition
// shared between callers. Search results, cards and media are per-request
// authorisation decisions and stay uncached — that is why this module is
// imported by exactly one file and only for two routes.

type Entry<T> = {
  value: T;
  /** When the value stops being fresh (ms epoch). */
  freshUntil: number;
  /** After this, even a failure may not serve it (ms epoch). */
  staleUntil: number;
  /** In-flight refresh, shared by every concurrent caller. */
  inflight?: Promise<T>;
};

const store = new Map<string, Entry<unknown>>();

/** Bounded on purpose: the key space is small (a few cell sizes x a few filters). */
const MAX_ENTRIES = 200;

export type CachedResult<T> = { value: T; age_ms: number; stale: boolean };

export async function cached<T>(
  key: string,
  freshMs: number,
  staleMs: number,
  load: () => Promise<T>
): Promise<CachedResult<T>> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  if (hit && now < hit.freshUntil) {
    return { value: hit.value, age_ms: freshMs - (hit.freshUntil - now), stale: false };
  }

  // Expired or absent: exactly one caller loads, everyone else awaits the same
  // promise. `inflight` is cleared in a finally so a rejection cannot wedge the
  // key permanently.
  if (!hit?.inflight) {
    const p = (async () => {
      const value = await load();
      const t = Date.now();
      store.set(key, { value, freshUntil: t + freshMs, staleUntil: t + freshMs + staleMs });
      if (store.size > MAX_ENTRIES) {
        // Cheapest sane eviction: drop the oldest insertion. Map preserves it.
        const oldest = store.keys().next().value;
        if (oldest !== undefined && oldest !== key) store.delete(oldest);
      }
      return value;
    })();
    if (hit) hit.inflight = p;
    else store.set(key, { value: undefined as T, freshUntil: 0, staleUntil: 0, inflight: p });
    p.finally(() => {
      const e = store.get(key) as Entry<T> | undefined;
      if (e?.inflight === p) delete e.inflight;
    }).catch(() => {});
  }

  const entry = store.get(key) as Entry<T>;
  try {
    const value = await entry.inflight!;
    return { value, age_ms: 0, stale: false };
  } catch (err) {
    // The refresh failed. Serve the last good answer if we still have one.
    if (hit && hit.staleUntil > now && hit.freshUntil > 0) {
      return { value: hit.value, age_ms: now - (hit.freshUntil - freshMs), stale: true };
    }
    throw err;
  }
}

/** Tests and the panel's "recompute now" path need a way to drop everything. */
export function clearPublicCache(): void {
  store.clear();
}

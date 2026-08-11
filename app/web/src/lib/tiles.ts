// Basemap providers, in order, with automatic failover.
//
// The problem: tile.openstreetmap.org is a donated community service with a
// fair-use policy. The day our map works is the day we violate it, and their
// response is a block — an all-grey map, during an event, with no deploy able to
// fix it in time.
//
// The tempting fix is to spread requests across several providers at once. We do
// NOT do that, for three reasons:
//   1. Every provider's terms are written per-application, not per-request. A
//      round robin does not make you compliant with three policies, it makes you
//      non-compliant with three policies.
//   2. Mixed tiles look broken. Two styles interleaved on one screen reads as a
//      corrupted map to a person who is already panicking.
//   3. It defeats caching. A tile fetched from a different host on every pan is
//      a cache miss every time — the opposite of what a saturated cellular
//      network needs.
//
// So: ONE active provider, an ordered fallback chain, and a switch that happens
// automatically when tiles start failing. Keys are build-time public values
// (they are in the browser anyway) and every provider is optional — a chain with
// nothing but OSM in it still works, it is just fragile, and `tileChain()` says
// so out loud in the console.
export interface TileProvider {
  id: string;
  url: string;
  attribution: string;
  maxZoom: number;
  /** Available only when its key is configured. */
  ready: boolean;
  /** Free-tier ceiling, for the ops note — not enforced in code. */
  note?: string;
}

const MAPBOX = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const STADIA = process.env.NEXT_PUBLIC_STADIA_KEY ?? "";
const MAPTILER = process.env.NEXT_PUBLIC_MAPTILER_KEY ?? "";

// A self-hosted or proxied tile origin. This is the only entry that can be made
// unblockable, and during a real activation it should be first: point it at a
// caching reverse proxy in front of whichever provider we are entitled to use,
// and one download serves every phone in the country.
const SELF = process.env.NEXT_PUBLIC_TILE_URL ?? "";

export const PROVIDERS: TileProvider[] = [
  {
    id: "self",
    url: SELF,
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
    ready: Boolean(SELF),
    note: "our own cache/proxy — unlimited, and the only one nobody can switch off",
  },
  {
    id: "stadia",
    // Alidade Smooth: light, low-saturation, designed to sit under overlays.
    url: `https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=${STADIA}`,
    attribution: "&copy; Stadia Maps &copy; OpenMapTiles &copy; OpenStreetMap contributors",
    maxZoom: 20,
    ready: Boolean(STADIA),
    note: "free tier ~200k tiles/month, requires the domain to be registered in advance",
  },
  {
    id: "maptiler",
    url: `https://api.maptiler.com/maps/basic-v2/{z}/{x}/{y}.png?key=${MAPTILER}`,
    attribution: "&copy; MapTiler &copy; OpenStreetMap contributors",
    maxZoom: 20,
    ready: Boolean(MAPTILER),
    note: "free tier ~100k tiles/month",
  },
  {
    id: "mapbox",
    url: `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/{z}/{x}/{y}?access_token=${MAPBOX}`,
    attribution: "&copy; Mapbox &copy; OpenStreetMap contributors",
    maxZoom: 20,
    ready: Boolean(MAPBOX),
    note: "50k free map loads/month, then billed — needs a card on file, i.e. a legal entity",
  },
  {
    id: "carto",
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 19,
    ready: true,
    note: "no key; CARTO's basemaps are free for non-commercial use, unmetered but unpromised",
  },
  {
    id: "osm",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
    ready: true,
    note: "last resort only — community servers, fair-use policy, will block a busy public map",
  },
];

/** The providers we may actually use, in priority order. */
export function tileChain(providers: TileProvider[] = PROVIDERS): TileProvider[] {
  const chain = providers.filter((p) => p.ready);
  if (chain.length && chain[0].id === "osm") {
    console.warn(
      "[tiles] the only basemap available is tile.openstreetmap.org. " +
        "Configure NEXT_PUBLIC_TILE_URL or a provider key before an activation."
    );
  }
  return chain;
}

/**
 * Failover policy.
 *
 * Tiles fail all the time for boring reasons (a phone entering a tunnel), so a
 * single error must not trigger a switch. We switch when a provider fails a
 * sustained fraction of a meaningful sample: >=25% errors over >=20 tiles.
 * Pure function so the policy is testable without a browser.
 */
export function shouldFailover(loaded: number, errored: number): boolean {
  const total = loaded + errored;
  if (total < 20) return false;
  return errored / total >= 0.25;
}

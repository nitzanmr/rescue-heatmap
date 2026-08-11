// Grid clustering for map markers.
//
// Written here rather than pulled from leaflet.markercluster, for one reason
// that matters and one that is merely convenient:
//
//   - it matters that clustering is deterministic and testable. A cluster count
//     on this map is read as "how many places can I go", and a plugin whose
//     grouping depends on render order gives a different answer on a re-render.
//   - it is convenient that it is ~60 lines and no dependency, in a repo that
//     has to install offline on a delegation laptop.
//
// The grid is in PIXEL space at the current zoom, not in metres: two markers
// cluster when they would OVERLAP on screen, which is the actual problem, and it
// makes the behaviour identical at every latitude.
export interface Clusterable {
  lat: number;
  lng: number;
}

export interface Cluster<T extends Clusterable> {
  lat: number;
  lng: number;
  items: T[];
}

const TILE = 256;

/** Web Mercator, in pixels at the given zoom. */
export function project(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const scale = TILE * Math.pow(2, zoom);
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/**
 * Group points that fall in the same `cellPx` grid cell at this zoom.
 *
 * The cluster's position is the MEAN of its members, not the cell centre: a
 * cluster drawn on an empty crossroads because that is where the grid line fell
 * is a lie about where the shelters are.
 *
 * Order in, order out — the first item of a cluster is the first in the input,
 * so a caller can rely on "verified sites first" surviving clustering.
 */
export function clusterPoints<T extends Clusterable>(points: T[], zoom: number, cellPx = 60): Cluster<T>[] {
  const buckets = new Map<string, T[]>();
  for (const p of points) {
    const { x, y } = project(p.lat, p.lng, zoom);
    const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }
  return [...buckets.values()].map((items) => ({
    lat: items.reduce((a, p) => a + p.lat, 0) / items.length,
    lng: items.reduce((a, p) => a + p.lng, 0) / items.length,
    items,
  }));
}

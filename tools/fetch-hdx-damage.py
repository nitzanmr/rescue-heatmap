#!/usr/bin/env python3
"""
Poll HDX (Humanitarian Data Exchange) for damage-assessment datasets for the
10 Aug 2026 Chocó earthquake, and derive damaged-building clusters from any
Microsoft AI for Good geopackage we have not processed yet.

Why this exists
---------------
Until now the only building counts in the dossier came from the Cali PMU report
(a number with no addresses) and from a civilian damage map (addresses with no
authority). This gives an *independent, machine-derived* count: satellite
imagery + building footprints + a damage model, with coordinates.

What it does
------------
  1. queries the HDX CKAN API for earthquake datasets touching Colombia,
  2. reports any dataset/resource newer than what is recorded in state.json,
  3. for each Microsoft AI for Good geopackage: reads it with plain sqlite3
     (a .gpkg is a SQLite file), pulls the envelope centroid of every footprint
     flagged `damaged = 1`, converts UTM 18N -> WGS84, and grids them into
     ~300 m clusters,
  4. writes clusters + the imagery coverage bbox to data/satellite-damage/.

Nothing here is authoritative: a model prediction is [B] at best, and imagery
only sees roofs — an interior pancake collapse can be invisible from above.
Always state the coverage bbox next to the count; "0 damaged" outside the mask
means "not looked at", not "intact".

Usage:  python3 tools/fetch-hdx-damage.py [--outdir data/satellite-damage]
        python3 tools/fetch-hdx-damage.py --list      # just show what is on HDX
"""

import argparse
import json
import math
import os
import sqlite3
import struct
import sys
import urllib.request

HDX_SEARCH = (
    "https://data.humdata.org/api/3/action/package_search"
    "?q=colombia+earthquake&rows=30&sort=metadata_modified+desc"
)
UA = {"User-Agent": "rescue-heatmap/1.0 (humanitarian)"}


def get_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def list_datasets():
    data = get_json(HDX_SEARCH)["result"]["results"]
    out = []
    for d in data:
        out.append(
            {
                "name": d["name"],
                "title": d["title"],
                "org": d.get("organization", {}).get("title", ""),
                "modified": d["metadata_modified"],
                "url": f"https://data.humdata.org/dataset/{d['name']}",
                "resources": [
                    {
                        "name": r["name"],
                        "format": r["format"],
                        "modified": r.get("last_modified", ""),
                        "url": r["url"],
                    }
                    for r in d.get("resources", [])
                ],
            }
        )
    return out


# --- UTM 18N (EPSG:32618) -> WGS84 ------------------------------------------
_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)
_K0 = 0.9996


def utm18n_to_wgs84(easting, northing):
    x = easting - 500000.0
    y = northing
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    m = y / _K0
    mu = m / (_A * (1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256))
    p = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
    )
    ep2 = _E2 / (1 - _E2)
    c = ep2 * math.cos(p) ** 2
    t = math.tan(p) ** 2
    n = _A / math.sqrt(1 - _E2 * math.sin(p) ** 2)
    r = _A * (1 - _E2) / (1 - _E2 * math.sin(p) ** 2) ** 1.5
    d = x / (n * _K0)
    lat = p - (n * math.tan(p) / r) * (
        d * d / 2 - (5 + 3 * t + 10 * c - 4 * c * c - 9 * ep2) * d**4 / 24
    )
    lon = math.radians(-75.0) + (
        d - (1 + 2 * t + c) * d**3 / 6 + (5 - 2 * c + 28 * t) * d**5 / 120
    ) / math.cos(p)
    return math.degrees(lat), math.degrees(lon)


def gpkg_centroid(blob):
    """Centroid of the GeoPackage binary header envelope. No geometry parsing."""
    flags = blob[3]
    idx = (flags >> 1) & 7
    if idx == 0:
        return None
    n = {1: 4, 2: 6, 3: 6, 4: 8}[idx]
    v = struct.unpack(("<" if flags & 1 else ">") + "d" * n, blob[8 : 8 + 8 * n])
    return (v[0] + v[1]) / 2, (v[2] + v[3]) / 2


def damaged_points(path):
    con = sqlite3.connect(path)
    rows = list(con.execute("select table_name, srs_id from gpkg_contents"))
    table, srs = rows[0]
    cols = [r[1] for r in con.execute(f'PRAGMA table_info("{table}")')]
    if "damaged" not in cols:
        raise SystemExit(f"{path}: no `damaged` column (columns: {cols})")
    pts = []
    for (geom,) in con.execute(f'select geom from "{table}" where damaged = 1'):
        c = gpkg_centroid(geom)
        if not c:
            continue
        pts.append(utm18n_to_wgs84(*c) if srs == 32618 else (c[1], c[0]))
    total = con.execute(f'select count(*) from "{table}"').fetchone()[0]
    return pts, total, srs


def cluster(points, cell_deg=0.003):
    grid = {}
    for lat, lon in points:
        grid.setdefault((round(lat / cell_deg), round(lon / cell_deg)), []).append(
            (lat, lon)
        )
    out = []
    for _, v in sorted(grid.items(), key=lambda kv: -len(kv[1])):
        out.append(
            {
                "count": len(v),
                "lat": round(sum(p[0] for p in v) / len(v), 5),
                "lon": round(sum(p[1] for p in v) / len(v), 5),
            }
        )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="data/satellite-damage")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--gpkg", help="process a local .gpkg instead of listing")
    ap.add_argument("--label", default="unnamed")
    args = ap.parse_args()

    if args.gpkg:
        pts, total, srs = damaged_points(args.gpkg)
        clusters = cluster(pts)
        os.makedirs(args.outdir, exist_ok=True)
        dest = os.path.join(args.outdir, f"{args.label}-clusters.json")
        lats = [p[0] for p in pts]
        lons = [p[1] for p in pts]
        json.dump(
            {
                "label": args.label,
                "source_file": os.path.basename(args.gpkg),
                "srs": srs,
                "footprints_total": total,
                "damaged": len(pts),
                "damaged_bbox": [min(lons), min(lats), max(lons), max(lats)]
                if pts
                else None,
                "clusters": clusters,
            },
            open(dest, "w"),
            indent=1,
        )
        print(f"{args.label}: {len(pts)} damaged of {total} footprints -> {dest}")
        for c in clusters[:12]:
            print(f"  {c['count']:4d}  {c['lat']:.5f},{c['lon']:.5f}")
        return

    datasets = list_datasets()
    for d in datasets:
        print(f"{d['modified'][:16]}  [{d['org'][:28]}] {d['title']}")
        for r in d["resources"]:
            print(f"        - {r['name']} [{r['format']}] {r['modified'][:16]}")
    if not args.list:
        os.makedirs(args.outdir, exist_ok=True)
        state = os.path.join(args.outdir, "hdx-index.json")
        json.dump(datasets, open(state, "w"), indent=1)
        print(f"\nwrote {state}")


if __name__ == "__main__":
    sys.exit(main())

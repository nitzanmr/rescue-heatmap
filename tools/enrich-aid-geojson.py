#!/usr/bin/env python3
"""Enrich the aid-site GeoJSON produced by services/api (aid-sites.ts) into a
field-ready export.

Why this exists: the canonical file carries a `kind` slug and a name, and
nothing else a human reads. Opened in QGIS or geojson.io the popup shows an
identifier and no location description, which is exactly the failure Nitzan
hit. This tool does NOT re-classify anything (that stays in TypeScript, one
source of truth) -- it only adds English, human-readable fields:

  name          canonical, first field so QGIS labels it by default
  kind_en       "Fuel station", not "fuel"
  description   one English sentence: type, neighbourhood, city, address, status
  neighbourhood nearest OSM place node (suburb/neighbourhood/quarter) within 2km
  address       filled from OSM addr:* tags re-fetched by id where available
  opening_hours / operator / phone / website  where OSM has them
  lat / lon     as plain attributes (QGIS attribute table, CSV export)
  verified      always "no" for source=osm -- presence is not operational status

Usage:
  python3 tools/enrich-aid-geojson.py \
      --in rescue-heatmap/data/aid-sites/cali-co.geojson:Cali \
      --in rescue-heatmap/data/aid-sites/pereira-co.geojson:Pereira \
      --out outbox/mahe-colombia-aid-layers.geojson \
      [--no-network]
"""
import argparse, json, math, sys, time, urllib.parse, urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "rescue-heatmap/0.1 (+https://github.com/nitzanmr/rescue-heatmap)"

KIND_EN = {
    "shelter": "Shelter (open)",
    "shelter_candidate": "Shelter candidate (school / community centre - not confirmed open)",
    "medical": "Medical facility",
    "pharmacy": "Pharmacy",
    "responder": "Emergency services (fire / police)",
    "supply": "Supply / distribution point",
    "water": "Drinking water point",
    "morgue": "Morgue",
    "info_point": "Information point",
    "fuel": "Fuel station",
    "market": "Supermarket / grocery",
    "other": "Other",
}
KIND_HE = {
    "shelter": "מקלט פעיל",
    "shelter_candidate": "מועמד למקלט",
    "medical": "מוסד רפואי",
    "pharmacy": "בית מרקחת",
    "responder": "כוח הצלה",
    "supply": "נקודת אספקה",
    "water": "נקודת מים",
    "morgue": "חדר מתים",
    "info_point": "נקודת מידע",
    "fuel": "תחנת דלק",
    "market": "סופר/מכולת",
    "other": "אחר",
}
COLOR = {
    "shelter": "#2b83ba", "shelter_candidate": "#c2a5cf", "medical": "#d7191c",
    "pharmacy": "#e08214", "responder": "#5e3c99", "fuel": "#fdae61",
    "market": "#1a9641", "water": "#66c2a5", "supply": "#8c510a",
    "morgue": "#404040", "info_point": "#999999", "other": "#777777",
}
SYMBOL = {
    "shelter": "lodging", "shelter_candidate": "school", "medical": "hospital",
    "pharmacy": "pharmacy", "responder": "fire-station", "fuel": "fuel",
    "market": "grocery", "water": "drinking-water", "supply": "warehouse",
    "morgue": "cemetery", "info_point": "information", "other": "circle",
}


# The TS pipeline keeps unnamed logistics points with a Spanish placeholder.
# The export is read by an international delegation, so the label has to be
# English too -- "sin nombre" reads as a real brand name to someone scanning.
NAME_EN = {
    "Estación de servicio (sin nombre)": "Fuel station (unnamed in OSM)",
    "Tienda / supermercado (sin nombre)": "Shop / grocery (unnamed in OSM)",
}


def haversine(a_lat, a_lon, b_lat, b_lon):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def overpass(query, tries=4):
    """Overpass answers 429/504 under load. Retry with backoff instead of
    silently degrading the export -- a missing barrio column is the difference
    between a usable file and the one Nitzan could not read."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                OVERPASS, data=urllib.parse.urlencode({"data": query}).encode(),
                headers={"user-agent": UA})
            return json.load(urllib.request.urlopen(req, timeout=240))
        except Exception as e:  # noqa: BLE001 - any transport failure is retryable
            last = e
            time.sleep(5 * (attempt + 1))
    raise last


def fetch_places(bboxes):
    parts = "".join(
        f'node["place"~"^(suburb|neighbourhood|quarter|village|town|city|hamlet)$"]({b});'
        for b in bboxes)
    j = overpass(f"[out:json][timeout:90];({parts});out tags center;")
    out = []
    for e in j.get("elements", []):
        t = e.get("tags", {})
        if t.get("name") and e.get("lat") is not None:
            out.append((t["name"], t.get("place"), e["lat"], e["lon"]))
    return out


def fetch_tags(refs):
    """Re-fetch OSM tags by id, so we can fill address / hours / operator."""
    by_type = {"node": [], "way": [], "relation": []}
    for r in refs:
        t, _, i = r.partition("/")
        if t in by_type and i.isdigit():
            by_type[t].append(i)
    tags = {}
    for t, ids in by_type.items():
        for i in range(0, len(ids), 250):
            chunk = ",".join(ids[i:i + 250])
            if not chunk:
                continue
            j = overpass(f"[out:json][timeout:120];{t}(id:{chunk});out tags;")
            for e in j.get("elements", []):
                tags[f'{e["type"]}/{e["id"]}'] = e.get("tags", {})
            time.sleep(1)
    return tags


def address_of(t):
    parts = [
        " ".join(x for x in (t.get("addr:street"), t.get("addr:housenumber")) if x),
        t.get("addr:suburb") or t.get("addr:neighbourhood"),
        t.get("addr:city"),
    ]
    parts = [p for p in parts if p]
    return ", ".join(parts) if parts else (t.get("addr:full") or None)


def bbox_of(feats, pad=0.03):
    lats = [f["geometry"]["coordinates"][1] for f in feats]
    lons = [f["geometry"]["coordinates"][0] for f in feats]
    return (f"{min(lats)-pad},{min(lons)-pad},{max(lats)+pad},{max(lons)+pad}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inputs", action="append", required=True,
                    help="path:CityName")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pulled", default="")
    ap.add_argument("--no-network", action="store_true")
    args = ap.parse_args()

    feats, cities, bboxes = [], [], []
    for spec in args.inputs:
        path, _, city = spec.rpartition(":")
        fc = json.load(open(path, encoding="utf8"))
        fs = fc["features"]
        for f in fs:
            f["properties"]["city"] = city
        feats += fs
        cities.append(city)
        bboxes.append(bbox_of(fs))

    places, tags = [], {}
    if not args.no_network:
        try:
            places = fetch_places(bboxes)
        except Exception as e:  # a missing barrio must not kill the export
            print(f"warn: places lookup failed: {e}", file=sys.stderr)
        try:
            tags = fetch_tags([f["properties"].get("source_ref") for f in feats
                               if f["properties"].get("source_ref")])
        except Exception as e:
            print(f"warn: tag lookup failed: {e}", file=sys.stderr)

    out = []
    for f in feats:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        t = tags.get(p.get("source_ref") or "", {})
        kind = p.get("kind", "other")

        nb, nb_dist = None, None
        for name, ptype, plat, plon in places:
            d = haversine(lat, lon, plat, plon)
            if nb_dist is None or d < nb_dist:
                nb, nb_dist = name, d
        if nb_dist is not None and nb_dist > 2000:
            nb = None

        addr = p.get("address") or address_of(t)
        kind_en = KIND_EN.get(kind, kind)
        where = addr or (f"{nb} (approx.)" if nb else "no street address in OSM")
        desc = (f"{kind_en} in {p['city']}, Colombia. "
                f"Location: {where}"
                + (f", barrio {nb}" if nb and addr else "") + ". "
                f"Coordinates {lat:.5f}, {lon:.5f}. "
                "Source: OpenStreetMap, unverified - presence does not mean open "
                "or operational after the earthquake; confirm before travel.")

        name = NAME_EN.get(p.get("name"), p.get("name"))
        props = {
            "name": name,
            "kind_en": kind_en,
            "description": desc,
            "kind": kind,
            "city": p.get("city"),
            "neighbourhood": nb,
            "address": addr,
            "phone": p.get("phone") or t.get("phone") or t.get("contact:phone"),
            "opening_hours": t.get("opening_hours"),
            "operator": t.get("operator") or t.get("brand"),
            "website": t.get("website") or t.get("contact:website"),
            "emergency_room": t.get("emergency"),
            "capacity": p.get("capacity") or t.get("capacity"),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "verified": "no",
            "source": p.get("source", "osm"),
            "source_ref": p.get("source_ref"),
            "source_url": p.get("source_url"),
            "kind_he": KIND_HE.get(kind, kind),
            "marker-color": COLOR.get(kind, "#777777"),
            "marker-symbol": SYMBOL.get(kind, "circle"),
            "title": name,
            "name_osm": p.get("name") if name != p.get("name") else None,
        }
        # QGIS shows empty strings as NULL anyway; dropping empties keeps the
        # attribute table readable instead of a wall of NULL columns.
        props = {k: v for k, v in props.items() if v not in (None, "")}
        out.append({"type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": props})

    fc = {
        "type": "FeatureCollection",
        "name": f"MAHE {' + '.join(cities)} 2026-08 - aid layers (OSM)",
        "crs": {"type": "name",
                "properties": {"name": "urn:ogc:def:crs:OGC:1.3/CRS84"}},
        "metadata": {
            "cities": cities,
            "count": len(out),
            "source": "OpenStreetMap via Overpass",
            "license": "ODbL 1.0",
            "attribution": "(c) OpenStreetMap contributors (ODbL)",
            "pulled": args.pulled,
            "note": ("OSM presence != operational status. Every point is "
                     "unverified. Confirm before travel."),
            "fields": {
                "description": "Human-readable English summary shown in popups",
                "kind_en": "Site type in English",
                "neighbourhood": "Nearest OSM place node within 2 km (approximate)",
                "verified": "no = never physically confirmed by a liaison",
            },
        },
        "features": out,
    }
    with open(args.out, "w", encoding="utf8") as fh:
        json.dump(fc, fh, ensure_ascii=False)
    print(f"wrote {args.out}: {len(out)} features")


if __name__ == "__main__":
    main()

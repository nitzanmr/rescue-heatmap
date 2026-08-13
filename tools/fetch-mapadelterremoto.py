#!/usr/bin/env python3
"""Scrape building-level damage points from mapadelterremoto.com (Naboo Intelligence).

Source grade: B (curated aggregator, not primary authority). Every point carries the
site's own evidence label (Confirmado / Reportado / Verificando) and source count.
The site publishes no export/API, so we parse the server-rendered cards.

Usage:  python3 tools/fetch-mapadelterremoto.py [municipio ...]
Output: data/external/mapadelterremoto/<municipio>.json  + all-points.geojson
No personal names are carried over: descriptions are scrubbed of given-name PII
before being written (Ley 1581/2012 caution — see docs/mapadelterremoto-assessment).
"""
import json, os, re, sys, html, urllib.request, datetime

BASE = "https://mapadelterremoto.com/municipio/"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "external", "mapadelterremoto")
DEFAULT = ["cali", "pereira", "dosquebradas", "cartago", "armenia", "quimbaya",
           "quibdo", "manizales", "san-jose-del-palmar", "calima-el-darien"]

CARD = re.compile(
    r'>(?P<pid>P-\d+)</span><span class="text-\[12px\]"[^>]*>(?P<cat>[^<]*)</span></span>'
    r'.*?font-semibold leading-snug"[^>]*>(?P<title>.*?)</span>'
    r'.*?text-\[13px\]"[^>]*>(?P<sub>.*?)</span>'
    r'(?:.*?max-w-\[75ch\][^>]*>(?P<desc>.*?)</span>)?',
    re.S)

# Contact details that leaked into free-text descriptions on the source site.
# We keep the operational sentence but drop the digits: a hotline we cannot
# verify as institutional is treated as personal until proven otherwise.
SCRUB = [
    (re.compile(r"\+?57[\s-]?\d[\d\s-]{7,}"), "[tel eliminado]"),
    (re.compile(r"\b3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b"), "[tel eliminado]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"), "[email eliminado]"),
    (re.compile(r"\b(?:c\.?c\.?|c[eé]dula)\s*[:.#]?\s*[\d.]{6,}", re.I), "[cédula eliminada]"),
]


def scrub(s):
    for rx, rep in SCRUB:
        s = rx.sub(rep, s)
    return s


def clean(s):
    if not s:
        return ""
    s = re.sub(r"<!--.*?-->", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).replace("\u00a0", " ").strip()

def fetch(muni):
    req = urllib.request.Request(BASE + muni, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")

def parse(page, muni):
    out, seen = [], set()
    for m in CARD.finditer(page):
        pid = m.group("pid")
        if pid in seen:
            continue
        seen.add(pid)
        title = clean(m.group("title"))
        sub = clean(m.group("sub"))
        desc = scrub(clean(m.group("desc")))
        tail = page[m.end():m.end() + 2500]
        ev = re.search(r">(Confirmado|Reportado|Verificando|Sin confirmar)<", tail)
        src = re.search(r">(\d+) fuentes<|>(una sola fuente)<", tail)
        kind, _, barrio = sub.partition(" · ")
        name, _, addr = title.partition(" · ")
        out.append({
            "id": f"mdt-{muni}-{pid}",
            "municipio": muni,
            "point_id": pid,
            "category": clean(m.group("cat")),
            "name": scrub(name.strip()),
            "address": addr.strip(),
            "damage": kind.strip(),
            "barrio": barrio.strip(),
            "evidence": ev.group(1) if ev else None,
            "sources": (src.group(1) or src.group(2)) if src else None,
            "notes": desc,
            "source": "mapadelterremoto.com (Naboo Intelligence)",
            "source_grade": "B",
            "url": BASE + muni,
        })
    return out

def main():
    munis = sys.argv[1:] or DEFAULT
    os.makedirs(OUT, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    allpts, summary = [], []
    for muni in munis:
        try:
            pts = parse(fetch(muni), muni)
        except Exception as e:
            print(f"  {muni}: FAILED ({e})")
            continue
        if not pts:
            print(f"  {muni}: 0 points (page shape changed? check parser)")
            continue
        path = os.path.join(OUT, f"{muni}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"municipio": muni, "fetched_at": stamp, "count": len(pts),
                       "points": pts}, f, ensure_ascii=False, indent=2)
        collapse = sum(1 for p in pts if p["category"] == "Colapso")
        grave = sum(1 for p in pts if p["category"] == "Grave")
        addr = sum(1 for p in pts if p["address"])
        print(f"  {muni}: {len(pts)} points ({collapse} colapso, {grave} grave, {addr} with address)")
        summary.append({"municipio": muni, "points": len(pts), "colapso": collapse,
                        "grave": grave, "with_address": addr})
        allpts += pts
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"fetched_at": stamp, "total": len(allpts), "by_municipio": summary},
                  f, ensure_ascii=False, indent=2)
    print(f"total: {len(allpts)} points -> {OUT}")

if __name__ == "__main__":
    main()

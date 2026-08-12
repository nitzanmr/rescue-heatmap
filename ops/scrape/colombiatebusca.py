#!/usr/bin/env python3
"""Harvest the public registry at colombiatebusca.com into a normalised NDJSON file.

WHY THIS EXISTS
  colombiatebusca.com is a citizen-run registry that already holds thousands of
  "por localizar" entries for the Choco/Valle earthquake. It is the largest
  public pool of the exact signal our heat map consumes. Reading it tells us
  (a) where reports actually cluster and (b) how our dedup engine behaves on
  real, messy, human-entered Spanish names rather than synthetic seed data.

WHAT IT DELIBERATELY DOES NOT DO
  - It does not write to the database. Output is a file. Ingestion is a separate,
    explicit step (ops/scrape/import-external.ts) so that a decision to hold
    third-party personal data is made by a person, not by a scraper.
  - It does not download photos. Faces are the highest-risk field we could hold
    and we have no use for them.
  - It does not attempt to unmask the redacted document numbers ("*******234").
    What the site hides, we keep hidden.

POLITENESS
  robots.txt allows everything outside /admin, /login.php, /core.php, /estado.php.
  The site publishes a sitemap; we use it instead of guessing URLs. Concurrency
  is small and configurable; this is a volunteer server, not a CDN.

PLACE PRECEDENCE
  The listing card carries a municipality ("Pereira, Risaralda"). The detail
  drawer carries the free-text line a relative actually typed ("Parque la
  Libertad - Pereira, Risaralda"). The second one is the only field that can
  ever become a 500 m cell, so when it exists it OVERRIDES the listing place,
  and `place_source` records which of the two won. Both raw fields survive so
  the override can be audited or undone without a second harvest.

USAGE
  python3 ops/scrape/colombiatebusca.py --out data/external/ctb.ndjson
  python3 ops/scrape/colombiatebusca.py --out ... --no-details   # listing only
  python3 ops/scrape/colombiatebusca.py --out ... --category terremoto
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

BASE = "https://colombiatebusca.com"
UA = "rescue-heatmap-research/0.1 (+humanitarian dedup research; contact via repo)"

# ---------------------------------------------------------------- fetching


def get(url: str, retries: int = 3, timeout: int = 30) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 - a scraper must survive the network
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


# ---------------------------------------------------------------- parsing

CARD_RE = re.compile(r'<article class="card"(.*?)</article>', re.S)
TAG_RE = re.compile(r"<[^>]+>")


def text_of(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", fragment))).strip()


def parse_listing(page_html: str) -> list[dict]:
    """One listing page carries 20 cards. Everything here is already public."""
    out = []
    for raw in CARD_RE.findall(page_html):
        # The href is not stable: on page 1 it is "/?person=<uuid>", on later
        # pages "/?page=N&amp;person=<uuid>". Anchoring on "?person=" silently
        # yielded zero cards the moment pagination changed, so match the
        # parameter itself and let the query string be whatever it wants.
        pid = re.search(r"[?&](?:amp;)?person=([0-9a-f-]{36})", raw)
        code = re.search(r"(CTB-[0-9A-F]+)", raw)
        name = re.search(r"<h[23][^>]*>(.*?)</h[23]>", raw, re.S)
        if not (pid and code):
            continue
        flat = text_of(raw)
        # "Sin documento publico - 58 anos - masculino"  |  "*******234 - 29 anos - femenino"
        meta = re.search(r"▣\s*(.*?)\s*-\s*(\d+)\s*a[nñ]os\s*-\s*(\w+)", flat)
        place = re.search(r"⌖\s*([^▦]+)", flat)
        when = re.search(r"▦\s*(.*?)\s*(?:Ver detalles|$)", flat)
        out.append(
            {
                "source": "colombiatebusca",
                "source_id": pid.group(1),
                "source_code": code.group(1),
                "source_url": f"{BASE}/?person={pid.group(1)}",
                "name": text_of(name.group(1)) if name else None,
                "status": "found" if "badge-found" in raw else "missing",
                "category": _category(flat),
                "document_hint": (meta.group(1).strip() if meta else None),
                "age": int(meta.group(2)) if meta else None,
                "sex": meta.group(3).lower() if meta else None,
                "place_listing": place.group(1).strip() if place else None,
                "registered_at_text": when.group(1).strip() if when else None,
            }
        )
    return out


CATEGORIES = [
    "Terremoto",
    "Inundación",
    "Deslizamiento",
    "Desastre natural",
    "Emergencia hospitalaria",
    "Persona extraviada",
    "Adulto mayor desorientado",
    "Menor de edad desaparecido",
    "Persona con discapacidad",
    "Conflicto familiar",
    "Reporte comunitario",
    "Otra",
]


def _category(flat: str) -> str | None:
    for c in CATEGORIES:
        if c in flat:
            return c
    return None


DL_RE = re.compile(r"<dt>(.*?)</dt>\s*<dd>(.*?)</dd>", re.S)


def parse_detail(page_html: str) -> dict:
    """The detail drawer is the only place the free-text 'ultimo lugar visto' lives.

    That field is what a geocoder can turn into a cell, so it is the one reason
    to pay for a second request per person.
    """
    start = page_html.find('id="detailDrawer"')
    if start < 0:
        return {}
    seg = page_html[start : page_html.find("</aside>", start)]
    fields = {text_of(k): text_of(v) for k, v in DL_RE.findall(seg)}
    return {
        "place_detail": fields.get("Último lugar visto"),
        "last_seen_text": fields.get("Último lugar visto"),
        "registered_at_text": fields.get("Registrado"),
        "document_visible": fields.get("Documento"),
        "detail_fields": fields,
    }


def apply_place(rec: dict) -> dict:
    """Decide the one place field downstream code is allowed to read.

    A municipality is tens of kilometres wide and cannot honestly be drawn on a
    500 m grid. The detail line is a landmark inside that municipality, which a
    geocoder can resolve. So the detail wins whenever we have it; the listing
    value survives untouched next to it as `place_listing`.
    """
    detail = (rec.get("place_detail") or "").strip()
    listing = (rec.get("place_listing") or "").strip()
    rec["place"] = detail or listing or None
    rec["place_source"] = "detail" if detail else ("listing" if listing else None)
    return rec


# ---------------------------------------------------------------- driver


def sitemap_person_urls() -> list[str]:
    xml = get(f"{BASE}/sitemap.php")
    return re.findall(r"<loc>(https://colombiatebusca\.com/\?person=[0-9a-f-]{36})</loc>", xml)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--pages", type=int, default=0, help="0 = until a page repeats/empties")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument(
        "--details",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="fetch each person's page; its last-seen line overrides the listing place",
    )
    ap.add_argument("--category", default=None, help="only fetch details for this category")
    args = ap.parse_args()

    print(f"[1/3] sitemap …", file=sys.stderr)
    known = sitemap_person_urls()
    print(f"      {len(known)} person URLs published", file=sys.stderr)

    print(f"[2/3] listing pages …", file=sys.stderr)
    records: dict[str, dict] = {}
    page = 1
    while True:
        rows = parse_listing(get(f"{BASE}/?page={page}"))
        new = [r for r in rows if r["source_id"] not in records]
        for r in rows:
            records.setdefault(r["source_id"], r)
        print(f"      page {page}: {len(rows)} cards, {len(new)} new, {len(records)} total",
              file=sys.stderr)
        if not rows or not new or (args.pages and page >= args.pages):
            break
        page += 1
        time.sleep(0.2)

    if args.details:
        targets = [
            r for r in records.values()
            if not args.category or (r.get("category") or "").lower() == args.category.lower()
        ]
        print(f"[3/3] details for {len(targets)} people …", file=sys.stderr)

        def enrich(rec: dict) -> None:
            try:
                rec.update(parse_detail(get(rec["source_url"])))
            except Exception as exc:  # noqa: BLE001
                rec["detail_error"] = str(exc)

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for i, _ in enumerate(pool.map(enrich, targets), 1):
                if i % 100 == 0:
                    print(f"      {i}/{len(targets)}", file=sys.stderr)

    stamp = datetime.now(timezone.utc).isoformat()
    overridden = 0
    with open(args.out, "w", encoding="utf-8") as fh:
        for rec in records.values():
            apply_place(rec)
            if rec.get("place_source") == "detail":
                overridden += 1
            rec["harvested_at"] = stamp
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(
        f"wrote {len(records)} records -> {args.out} "
        f"({overridden} places from the detail page, "
        f"{len(records) - overridden} left at listing level)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

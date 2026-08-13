#!/usr/bin/env python3
"""
Fetch the official Cali city PMU earthquake report.

Source [A]: Alcaldia de Santiago de Cali, "Terremoto de Cali - Repositorio
Oficial de Informacion".
  https://www.cali.gov.co/gobierno/publicaciones/193607/terremoto-de-cali-repositorio-oficial-de-informacion/

The repository page carries a headline balance block (dead / injured / missing /
rescued / fully collapsed buildings) plus a "Descargar ultimo reporte oficial"
link pointing at a numbered PMU PDF (report #006 = cut 12 Aug 20:00).

This script:
  1. downloads the repository page,
  2. scrapes the balance numbers and the "last updated" stamp,
  3. follows the download link, saves the PDF under data/official-cali/,
  4. extracts its text (needs pdftotext) so the numbers are diffable,
  5. writes data/official-cali/latest.json.

It NEVER overwrites a previously fetched report: files are named by the report
number found in the PDF, so each cut is kept append-only and diffs stay honest.

Usage:  python3 tools/fetch-cali-official.py [--outdir data/official-cali]
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

REPO_URL = (
    "https://www.cali.gov.co/gobierno/publicaciones/193607/"
    "terremoto-de-cali-repositorio-oficial-de-informacion/"
)
UA = "Mozilla/5.0 (rescue-heatmap official-source fetcher)"

# id -> field name in the headline balance block on the repository page
BALANCE_IDS = {
    "fallecidos": "dead",
    "lesionados": "injured",
    "colapsadas": "buildings_collapsed_total",
    "desaparecidas": "missing",
    "rescatadas": "rescued",
}


def get(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def parse_int(s: str):
    s = s.strip().replace(".", "").replace(",", "")
    return int(s) if s.isdigit() else None


def scrape_balance(html: str) -> dict:
    out = {}
    for html_id, field in BALANCE_IDS.items():
        m = re.search(
            r'id="%s"[^>]*>\s*([\d.,]+)\s*<' % re.escape(html_id), html
        )
        if m:
            out[field] = parse_int(m.group(1))
    m = re.search(r"Última actualización:\s*([^<]+)<", html)
    if m:
        out["page_updated_text"] = re.sub(r"\s+", " ", m.group(1)).strip()
    return out


def find_download(html: str):
    m = re.search(r'class="balance__download"[^>]*href="([^"]+)"', html, re.S)
    if not m:
        m = re.search(r'href="([^"]*loader\.php[^"]*descargar[^"]*)"', html)
    return m.group(1).replace("&amp;", "&") if m else None


def pdf_to_text(pdf_path: str):
    # -layout is mandatory: the PMU report is a two-column table and plain
    # extraction interleaves the columns, which silently pairs the wrong number
    # with the wrong label.
    try:
        return subprocess.run(
            ["pdftotext", "-layout", pdf_path, "-"],
            check=True, capture_output=True, text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        print("warn: pdftotext unavailable or failed (%s)" % e, file=sys.stderr)
        return None


def parse_pdf(text: str) -> dict:
    """Parse the -layout rendering of the PMU report.

    Each headline row is 'label ....... number' on one line, except
    'Edificaciones con danos estructurales', which wraps onto a second line.
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", text)

    head = {
        "report_no": r"#(\d{3})",
        "cut_date": r"con corte (\w+ \d+ de \d{4})",
        "cut_time": r"Hora:\s*([\d:]+\s*[ap]\.?\s?m\.?)",
    }
    for k, pat in head.items():
        m = re.search(pat, flat, re.I)
        if m:
            out[k] = parse_int(m.group(1)) if m.group(1).isdigit() else m.group(1).strip()
    if isinstance(out.get("report_no"), str):
        out["report_no"] = parse_int(out["report_no"])

    # label -> field, matched line by line so a number can never jump columns
    rows = [
        (r"Rescatadas", "rescued"),
        (r"Desaparecidas", "missing"),
        (r"Fallecidas", "dead"),
        (r"Heridas", "injured"),
        (r"colapso total", "buildings_collapsed_total"),
        (r"colapso parcial", "buildings_collapsed_partial"),
        (r"estructurales", "buildings_structural_damage"),
        (r"orden de evacuaci", "buildings_evacuation_order"),
        (r"escombros retirados", "debris_tons_removed"),
        (r"necesidades identi", "damage_assessments"),
        (r"Rescatistas activos", "rescuers_active"),
    ]
    # The headline block is two columns on one physical line
    # ('Rescatadas 88 * Edificaciones con colapso total 45'), so split on the
    # bullet before matching or the right column's number lands on the left
    # column's label.
    for line in flat.splitlines():
        for seg in re.split(r"[\u25cf\u2022]", line):
            for pat, field in rows:
                if field in out:
                    continue
                if re.search(pat, seg, re.I):
                    nums = re.findall(r"(\d[\d.]*)(?!\S)", seg)
                    if nums:
                        out[field] = parse_int(nums[-1])

    one = re.sub(r"\s+", " ", flat)
    m = re.search(r"(\w+) frentes de trabajo activos", one, re.I)
    if m:
        out["fronts_with_signs_of_life_text"] = m.group(1)
    m = re.search(r"En (\d+) puntos se descartaron", one, re.I)
    if m:
        out["points_signs_ruled_out"] = int(m.group(1))
    m = re.search(r"NOVEDADES(.*)$", one, re.S)
    if m:
        out["novedades"] = m.group(1).strip()[:4000]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="data/official-cali")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print("fetching repository page ...")
    html = get(REPO_URL)
    balance = scrape_balance(html)
    print("  page balance:", balance)

    link = find_download(html)
    if not link:
        print("error: no report download link found on page", file=sys.stderr)
        return 2
    print("fetching report:", link)
    pdf = get(link, binary=True)
    if not pdf.startswith(b"%PDF"):
        print("error: download is not a PDF", file=sys.stderr)
        return 2

    tmp = os.path.join(args.outdir, ".tmp.pdf")
    with open(tmp, "wb") as f:
        f.write(pdf)
    text = pdf_to_text(tmp)
    pdf_fields = parse_pdf(text) if text else {}

    no = pdf_fields.get("report_no")
    stamp = re.sub(r"[^0-9]", "", pdf_fields.get("cut_date", "") or "") or "unknown"
    base = "pmu-report-%s" % (("%03d" % no) if isinstance(no, int) else stamp)
    pdf_path = os.path.join(args.outdir, base + ".pdf")
    txt_path = os.path.join(args.outdir, base + ".txt")

    if os.path.exists(pdf_path):
        old = hashlib.sha256(open(pdf_path, "rb").read()).hexdigest()
        new = hashlib.sha256(pdf).hexdigest()
        print("  report %s already stored (%s)" % (base, "identical" if old == new else "DIFFERS - keeping stored copy"))
        os.remove(tmp)
    else:
        os.replace(tmp, pdf_path)
        if text:
            open(txt_path, "w").write(text)
        print("  saved", pdf_path)

    record = {
        "fetched_at_utc": now,
        "source_grade": "A",
        "source_name": "Alcaldía de Santiago de Cali — PMU (Puesto de Mando Unificado)",
        "repository_url": REPO_URL,
        "report_url": link,
        "report_file": os.path.basename(pdf_path),
        "page_balance": balance,
        "report": pdf_fields,
    }
    latest = os.path.join(args.outdir, "latest.json")
    with open(latest, "w") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("wrote", latest)

    # Loud warning when the headline block and the PDF disagree — this happened
    # on 13 Aug (page said 46 fully collapsed, report #006 said 45).
    for k in ("dead", "injured", "missing", "rescued", "buildings_collapsed_total"):
        a, b = balance.get(k), pdf_fields.get(k)
        if a is not None and b is not None and a != b:
            print("MISMATCH %s: page=%s report=%s" % (k, a, b), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

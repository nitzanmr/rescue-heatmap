#!/usr/bin/env sh
# How many people can this machine actually serve?
#
# Deliberately built from curl and xargs and nothing else: no autocannon, no k6,
# no image to pull. This has to run on the machine the system is deployed on,
# during a week when that machine may have no outbound network at all, and an
# ops tool that needs a download is an ops tool you do not have.
#
# It ramps concurrency and, at every step, reports for each path:
#   n, errors, HTTP 429s, p50, p95, max (seconds), and requests/second
#
# The paths are the three that decide capacity:
#   heat    the aggregate everyone loads first, and the expensive query
#   search  a per-caller query that is NOT cached, on purpose
#   intake  the write path — the one that must never be the thing that fails
#
# Read the p95 of `heat` before and after the edge cache to see what the cache
# is worth on your hardware; read `intake` to know whether a burst of reports
# from a neighbourhood is absorbed or refused.
set -eu

EDGE="${1:-http://localhost:8080}"
INCIDENT="${2:-drill-quibdo}"
DURATION="${3:-20}"          # seconds per concurrency step, per path
STEPS="${STEPS:-5 25 75 150}" # concurrent clients

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v curl >/dev/null || { echo "curl is required"; exit 1; }

echo "target:    $EDGE"
echo "incident:  $INCIDENT"
echo "steps:     $STEPS concurrent, ${DURATION}s each"
echo

# One request; prints "<seconds> <http_code>". Never fails the script: a refused
# request is data, not an error.
one_request() {
  # shellcheck disable=SC2086
  curl -s -o /dev/null -w '%{time_total} %{http_code}\n' --max-time 30 $2 "$1" 2>/dev/null \
    || echo "30.0 000"
}

# Percentile from a sorted file of numbers. awk, because sort -n + awk is the
# only statistics library guaranteed to be present.
pct() { # file, percentile
  awk -v p="$2" '{a[NR]=$1} END {if (NR==0) {print "-"; exit} i=int(p/100*NR); if(i<1)i=1; printf "%.3f", a[i]}' "$1"
}

run_path() { # label, url, curl-extra-args
  label="$1"; url="$2"; extra="${3:-}"
  for c in $STEPS; do
    out="$WORK/$label.$c"
    : > "$out"
    end=$(( $(date +%s) + DURATION ))
    i=0
    while [ "$i" -lt "$c" ]; do
      (
        while [ "$(date +%s)" -lt "$end" ]; do
          one_request "$url" "$extra" >> "$out"
        done
      ) &
      i=$(( i + 1 ))
    done
    wait

    n=$(wc -l < "$out" | tr -d ' ')
    [ "$n" -gt 0 ] || { echo "$label c=$c: no responses at all"; continue; }
    err=$(awk '$2 !~ /^2/ && $2 != "429" {c++} END {print c+0}' "$out")
    throttled=$(awk '$2 == "429" {c++} END {print c+0}' "$out")
    awk '{print $1}' "$out" | sort -n > "$out.sorted"
    p50=$(pct "$out.sorted" 50)
    p95=$(pct "$out.sorted" 95)
    max=$(tail -1 "$out.sorted")
    rps=$(awk -v n="$n" -v d="$DURATION" 'BEGIN {printf "%.1f", n/d}')
    printf '%-8s c=%-4s n=%-6s rps=%-7s p50=%-7s p95=%-7s max=%-7s 429=%-6s err=%s\n' \
      "$label" "$c" "$n" "$rps" "$p50" "$p95" "$max" "$throttled" "$err"
  done
  echo
}

# 1. The aggregate layer. Cached at the edge — a p95 that stays flat as
#    concurrency climbs means the cache is doing its job. A p95 that climbs
#    linearly means it is not, and every phone is running heat_cells().
run_path heat "$EDGE/api/v1/public/heat?incident=$INCIDENT&cell=500"

# 2. The aid-site layer. Same shape, larger body — this is where gzip shows up.
run_path aid "$EDGE/api/v1/public/aid-sites?country=CO"

# 3. Search. NOT cached and never will be: it is a per-caller name query. This
#    is the read path whose cost is real at every request, so it is the one that
#    sets the ceiling once the map layers are cached.
run_path search "$EDGE/api/v1/public/search?q=Simulacro&incident=$INCIDENT"

# 4. Intake. The write path. Rate limits will produce 429s here — that is the
#    system working, not failing, so 429 is counted separately from an error.
BODY='{"full_name":"Carga Prueba Perez","incident_slug":"'"$INCIDENT"'","last_seen_lat":5.6947,"last_seen_lng":-76.6611,"location_accuracy":"building","status":"missing"}'
echo "$BODY" > "$WORK/body.json"
run_path intake "$EDGE/api/v1/reports" \
  "-X POST -H content-type:application/json --data-binary @$WORK/body.json"

echo "Reading this:"
echo "  * heat/aid p95 flat as c grows  -> the edge cache is absorbing the load."
echo "  * search p95 is the real ceiling for browsing once the map is cached."
echo "  * intake 429s are the rate limiter, not a failure. intake err>0 is."
echo "  * anything with err>0 at low concurrency is a bug, not a capacity limit."

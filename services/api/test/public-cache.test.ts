// The public read cache, and the line it must never cross.
//
// Two facts this file exists to protect:
//
//   1. The two AGGREGATE layers (heat, aid-sites) are cached at the edge and in
//      process. Remove either half and the map recomputes the most expensive
//      query we own once per phone. That regression is invisible until the day
//      it matters, which is the day of an activation.
//
//   2. NOTHING ABOUT A NAMED PERSON MAY BE CACHED. Search results, the shared
//      card and media bytes are per-request authorisation decisions. A cache
//      entry is by definition shared between callers, so caching one of those
//      paths would serve one family's answer to a stranger. These are static
//      checks precisely because that failure would not show up in a drill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cached, clearPublicCache } from "../src/cache.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const nginx = readFileSync(path.join(ROOT, "ops/edge/nginx.conf"), "utf8");
const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const publicRoutes = readFileSync(path.join(ROOT, "services/api/src/routes/public.ts"), "utf8");

/** The body of one `location` block, by its exact match path. */
function locationBlock(match: string): string {
  const i = nginx.indexOf(`location = ${match} {`);
  assert.notEqual(i, -1, `the edge no longer has an exact location for ${match}`);
  const rest = nginx.slice(i);
  const end = rest.indexOf("\n  }");
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("the edge caches the heat layer, and serves it stale rather than blank", () => {
  const b = locationBlock("/api/v1/public/heat");
  assert.match(b, /proxy_cache rh_public;/);
  assert.match(b, /proxy_cache_valid 200 \d+s;/);
  // A cold cache under load must send ONE request upstream, not one per phone.
  assert.match(b, /proxy_cache_lock on;/);
  // The whole point: when the API is down or rate-limiting, the map keeps
  // drawing the last good answer. A blank map reads as "nobody is missing here".
  assert.match(b, /proxy_cache_use_stale[^;]*updating/);
  assert.match(b, /proxy_cache_use_stale[^;]*error/);
  assert.match(b, /proxy_cache_use_stale[^;]*http_429/);
});

test("the edge caches the aid-site layer the same way", () => {
  const b = locationBlock("/api/v1/public/aid-sites");
  assert.match(b, /proxy_cache rh_public;/);
  assert.match(b, /proxy_cache_lock on;/);
  assert.match(b, /proxy_cache_use_stale[^;]*updating/);
});

test("the cache key is the URL and never the caller", () => {
  // An IP, a token or a cookie in the key would make the cache useless (one
  // entry per visitor). Anything MORE than the URL means we are caching
  // something that varies per caller — which these two endpoints must not.
  const keys = [...nginx.matchAll(/proxy_cache_key ([^;]+);/g)].map((m) => m[1]);
  assert.ok(keys.length >= 2, "the cached locations must state their key explicitly");
  for (const k of keys) {
    assert.match(k, /\$uri/);
    assert.match(k, /\$args/);
    for (const forbidden of ["$remote_addr", "$http_authorization", "$cookie", "$http_x_forwarded_for"]) {
      assert.equal(k.includes(forbidden), false, `${forbidden} must not appear in a cache key`);
    }
  }
});

test("no endpoint about a named person is cached at the edge", () => {
  // The forbidden list is behavioural, not cosmetic: search is a name lookup,
  // the card is one person, media is bytes released by a consent check.
  for (const personal of ["/v1/public/search", "/v1/public/cases", "/v1/public/media", "/v1/panel", "/v1/reports"]) {
    const i = nginx.indexOf(personal);
    if (i === -1) continue;
    const around = nginx.slice(Math.max(0, i - 400), i + 800);
    assert.equal(
      /proxy_cache\s+rh_public;/.test(around),
      false,
      `${personal} appears next to a proxy_cache directive — a shared cache must never hold one person's answer`
    );
  }
  // And the general /api/ passthrough stays uncached: anything we did not
  // explicitly opt in must go to the API every time.
  const api = nginx.slice(nginx.indexOf("location /api/ {"));
  const apiBlock = api.slice(0, api.indexOf("\n  }"));
  assert.equal(/proxy_cache /.test(apiBlock), false, "the catch-all /api/ location must not cache");
});

test("the cache lives in RAM and does not outlive the container", () => {
  assert.match(nginx, /proxy_cache_path \/var\/cache\/nginx\/public/);
  assert.match(compose, /tmpfs:\s*\n\s*- \/var\/cache\/nginx/);
});

test("responses are compressed on the way out", () => {
  assert.match(nginx, /^gzip on;/m);
  assert.match(nginx, /gzip_types[^;]*application\/json/);
});

test("the heat endpoint no longer claims caching while sending no-store", () => {
  // noIndex() sets `Cache-Control: no-store`. For a two-case-floor aggregate
  // that is wrong AND it silently disables every cache in front of us — which
  // is exactly the state the code was in while its comment claimed otherwise.
  const heat = publicRoutes.slice(publicRoutes.indexOf('"/v1/public/heat"'));
  const body = heat.slice(0, heat.indexOf("// ----", 10) === -1 ? 4000 : heat.indexOf("// ----", 10));
  assert.match(body, /Cache-Control", "public, max-age=\d+/);
  assert.match(body, /cached\(`heat\|/, "the heat query must go through the in-process cache");
});

test("the private endpoints still send no-store", () => {
  // The other half of the invariant, in the code this time: every personal
  // endpoint calls noIndex(), which is what makes the negative test above safe.
  for (const route of ['"/v1/public/search"', '"/v1/public/cases/:ref"', '"/v1/public/media/:id"']) {
    const i = publicRoutes.indexOf(route);
    assert.notEqual(i, -1, `${route} disappeared`);
    assert.match(publicRoutes.slice(i, i + 400), /noIndex\(reply\)/, `${route} must send no-store`);
  }
});

test("in-process cache: concurrent misses run the loader once", async () => {
  clearPublicCache();
  let runs = 0;
  const load = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
    return runs;
  };
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => cached("k", 1000, 1000, load)));
  assert.equal(runs, 1, "single-flight is the point: five phones must not be five queries");
  for (const r of all) assert.equal(r.value, 1);
});

test("in-process cache: a failed refresh serves the last good answer, not an error", async () => {
  clearPublicCache();
  let mode: "ok" | "boom" = "ok";
  const load = async () => {
    if (mode === "boom") throw new Error("database is having a bad day");
    return "cells";
  };
  const first = await cached("k2", 1, 5000, load); // freshMs=1 -> expires immediately
  assert.equal(first.value, "cells");
  await new Promise((r) => setTimeout(r, 5));
  mode = "boom";
  const second = await cached("k2", 1, 5000, load);
  assert.equal(second.value, "cells", "a stale map beats a blank map");
  assert.equal(second.stale, true, "and it must announce that it is stale");
});

test("in-process cache: with nothing cached, a failure is a failure", async () => {
  clearPublicCache();
  await assert.rejects(
    () => cached("k3", 1000, 1000, async () => { throw new Error("boom"); }),
    /boom/,
    "stale-on-failure must not turn a cold failure into a silent empty answer"
  );
});

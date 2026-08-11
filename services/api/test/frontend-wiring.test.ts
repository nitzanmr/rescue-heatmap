// The front end is wired to the API, and must stay wired.
//
// These are static checks on the web source, not browser tests. They exist
// because the failure they guard against is not a crash — it is the front end
// quietly going back to talking to itself, which is exactly the state this repo
// was in for weeks while looking finished. A mock store fails no test and
// renders beautifully.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const WEB = path.resolve(import.meta.dirname, "../../../app/web/src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const sources = walk(WEB).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
const read = (f: string) => readFileSync(f, "utf8");

// Comments explain why a thing is forbidden and must be allowed to name it.
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("no browser-side mock data source survives", () => {
  for (const f of ["lib/mock.ts", "lib/store.ts", "lib/dedup.ts"]) {
    assert.equal(
      existsSync(path.join(WEB, f)),
      false,
      `${f} is back. The browser must not hold a private copy of other people's reports, ` +
        `and a second correlation implementation in the client will drift from correlate_case().`
    );
  }
});

test("every network call goes through lib/api.ts", () => {
  const offenders = sources
    .filter((f) => !f.endsWith(path.join("lib", "api.ts")))
    .filter((f) => /\bfetch\s*\(/.test(code(f)))
    // The Next server component fetches the API directly for link-preview
    // metadata: it runs on the server, where the relative /api path has no
    // origin to resolve against.
    .filter((f) => !f.endsWith(path.join("r", "[ref]", "page.tsx")));

  assert.deepEqual(
    offenders.map((f) => path.relative(WEB, f)),
    [],
    "raw fetch() outside lib/api.ts — the token, the base URL and the offline/permanent " +
      "error distinction are decided in one place on purpose"
  );
});

test("the client never mints a reference number", () => {
  // The server issues references. A client-side generator prints a different
  // number on each retry of the same report, and the family writes down the one
  // that does not exist.
  for (const f of sources) {
    const src = code(f);
    assert.equal(
      /newReferenceNumber|function\s+newReference\b/.test(src),
      false,
      `${path.relative(WEB, f)} mints a reference number`
    );
  }
});

test("the outbox writes to storage before it hits the network", () => {
  const src = read(path.join(WEB, "lib/outbox.ts"));
  const enqueue = src.slice(src.indexOf("export function enqueueReport"));
  const body = enqueue.slice(0, enqueue.indexOf("\n}"));
  assert.match(body, /write\(\[entry/, "enqueueReport must persist before returning");
  assert.equal(/apiFetch|fetch\(/.test(body), false, "enqueueReport must not perform I/O");
});

test("the outbox sends the device uuid as the idempotency key", () => {
  const src = read(path.join(WEB, "lib/outbox.ts"));
  assert.match(
    src,
    /payload:\s*\{\s*\.\.\.payload,\s*uuid/,
    "the report body must carry `uuid`, or a retry storm creates duplicate cases"
  );
});

test("a 4xx is not retried forever and a transport failure is", () => {
  const api = read(path.join(WEB, "lib/api.ts"));
  assert.match(api, /new ApiError\(0, "offline"/, "a transport failure must be distinguishable");
  assert.match(api, /get isPermanent/, "a permanent rejection must be distinguishable");
  const outbox = read(path.join(WEB, "lib/outbox.ts"));
  assert.match(outbox, /isOffline[\s\S]{0,200}state: "pending"/, "offline entries stay pending");
  assert.match(outbox, /isPermanent[\s\S]{0,120}state: "rejected"/, "4xx entries stop retrying");
});

test("the panel map consumes server-aggregated cells, not case points", () => {
  const src = read(path.join(WEB, "components/HeatMap.tsx"));
  assert.match(src, /cells:\s*HeatCell\[\]/, "HeatMap must take aggregated cells");
  assert.equal(
    /last_seen_lat|last_seen_lng/.test(src),
    false,
    "the map must never receive an individual case location"
  );
});

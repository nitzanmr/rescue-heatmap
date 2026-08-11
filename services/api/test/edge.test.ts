// One front door, and it stays one.
//
// These are static checks on the compose file and the nginx config. They exist
// because the regression they guard against is invisible at runtime: republish
// the API's port "just for debugging" and everything keeps working — while the
// request-size limit and, far worse, the X-Forwarded-For overwrite are gone for
// anyone who finds that port. The API runs with trustProxy on; a directly
// reachable API port is a client-IP spoofing hole, not a convenience.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const nginx = readFileSync(path.join(ROOT, "ops/edge/nginx.conf"), "utf8");

/** The `ports:` block of one compose service, or null when it has none. */
function publishedPorts(service: string): string[] | null {
  const start = compose.indexOf(`\n  ${service}:\n`);
  assert.notEqual(start, -1, `service ${service} is gone from docker-compose.yml`);
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n  [a-z]/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const ports = block.match(/\n    ports:\n((?:\s+- .*\n)+)/);
  if (!ports) return null;
  return ports[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

test("only the edge and the database publish a host port", () => {
  assert.equal(
    publishedPorts("api"),
    null,
    "the api republished a host port — that bypasses the edge's body limit and its " +
      "X-Forwarded-For overwrite, and the api trusts proxy headers"
  );
  assert.equal(
    publishedPorts("web"),
    null,
    "the web republished a host port — two origins means CORS in the intake path and " +
      "a second address to get right during an activation"
  );
  // The correlation test runs on the host and talks to Postgres directly.
  assert.ok(publishedPorts("db"), "the database port must stay published for `make test`");
  assert.deepEqual(publishedPorts("edge"), ['- "${EDGE_PORT:-8080}:80"']);
});

test("the edge routes /api to the api and everything else to the web", () => {
  // The trailing slash is load-bearing: it strips the /api prefix so the API
  // keeps its own route table and never learns it is mounted under one.
  assert.match(nginx, /location \/api\/ \{[\s\S]*?proxy_pass http:\/\/rh_api\/;/);
  assert.match(nginx, /location \/ \{[\s\S]*?proxy_pass http:\/\/rh_web;/);
  assert.match(nginx, /upstream rh_api \{\s*server api:8080;/);
  assert.match(nginx, /upstream rh_web \{\s*server web:3000;/);
});

test("the client address is overwritten, never appended to", () => {
  // `$proxy_add_x_forwarded_for` appends to whatever the client sent, so a
  // caller can prepend an address and shed their rate limit on a public intake
  // form. We state what nginx saw and nothing else.
  assert.equal(
    /proxy_add_x_forwarded_for/.test(nginx),
    false,
    "X-Forwarded-For must be set to $remote_addr, not appended to the client's value"
  );
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
});

test("the edge allows a photo through", () => {
  // PHOTO_MAX_BYTES is 3 MiB and the API rejects above it with a readable
  // message. If nginx cuts first, the family sees a bare 413 and reads it as
  // "the site is broken".
  const m = nginx.match(/client_max_body_size (\d+)m;/);
  assert.ok(m, "the edge must state a body limit explicitly");
  assert.ok(Number(m![1]) >= 4, "the edge limit must sit above PHOTO_MAX_BYTES, not below it");
});

test("the shared link points at the edge, not at the web container", () => {
  assert.match(
    compose,
    /NEXT_PUBLIC_BASE_URL: \$\{PUBLIC_BASE_URL:-http:\/\/localhost:\$\{EDGE_PORT:-8080\}\}/,
    "a family's card must print an address that is actually reachable"
  );
});

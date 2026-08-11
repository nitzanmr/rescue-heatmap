// Static guards on the measurement harness itself.
//
// Both of these are incidents, not hypotheticals:
//   * a DNS workaround for ONE host (`network: host`) was committed as the
//     default for every builder, including ones that reject it;
//   * seed() started queueing jobs for the worker, and the correlation test
//     calls seed() in-process — so a worker left running by the drill scored the
//     test's cases in parallel with the test, and the reported ms/case was a
//     measurement of a race.
//
// A harness that lies is worse than no harness: it produces numbers people quote.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const seedSrc = fs.readFileSync(path.join(root, "services/api/src/seed.ts"), "utf8");

const code = (s: string) =>
  s.split("\n").filter((l) => !l.trimStart().startsWith("#") && !l.trimStart().startsWith("//")).join("\n");

test("no build pins a host-specific network as the default", () => {
  const offenders = [...code(compose).matchAll(/network:\s*(\S+)/g)]
    .map((m) => m[1])
    .filter((v) => !v.startsWith("${"));
  assert.deepEqual(offenders, [],
    `build network hardcoded to ${offenders.join(", ")} — parameterise it (BUILD_NETWORK)`);
});

test("seed only queues correlation work when explicitly asked", () => {
  assert.match(code(seedSrc), /process\.env\.SEED_ENQUEUE === "1"/,
    "seed() must not enqueue by default: an in-process caller cannot control a running worker");
  const enqueueAt = seedSrc.indexOf("SEED_ENQUEUE");
  const insertAt = seedSrc.indexOf("INSERT INTO job");
  assert.ok(enqueueAt >= 0 && enqueueAt < insertAt, "the job insert must sit behind the flag");
});

test("the drill's seed service does ask for it", () => {
  assert.match(compose, /SEED_ENQUEUE:\s*"1"/,
    "the drill must exercise the asynchronous worker path");
});

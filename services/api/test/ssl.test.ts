// The drill failed once because TLS was inferred from the hostname: a local
// database reachable as "db" inside compose was treated as remote. These cases
// pin the precedence so that never regresses.
import test from "node:test";
import assert from "node:assert/strict";
import { sslFor } from "../src/config.js";

const LOCAL = "postgres://rescue:rescue@db:5432/rescue";
const MANAGED = "postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db";

test("DB_SSL=disable wins over everything, including sslmode in the URL", () => {
  assert.equal(sslFor(`${MANAGED}?sslmode=require`, "disable"), false);
  assert.equal(sslFor(LOCAL, "disable"), false);
});

test("compose hostnames are not special: without config, TLS is required", () => {
  assert.deepEqual(sslFor(LOCAL, ""), { rejectUnauthorized: false });
  assert.deepEqual(sslFor(MANAGED, ""), { rejectUnauthorized: false });
});

test("sslmode in the URL is honoured when DB_SSL is unset", () => {
  assert.equal(sslFor(`${LOCAL}?sslmode=disable`, ""), false);
  assert.deepEqual(sslFor(`${MANAGED}?sslmode=require`, ""), { rejectUnauthorized: false });
  assert.deepEqual(sslFor(`${MANAGED}?sslmode=verify-full`, ""), { rejectUnauthorized: true });
});

test("an unknown value fails loudly instead of silently choosing a mode", () => {
  assert.throws(() => sslFor(LOCAL, "yes-please"), /invalid DB_SSL/);
});

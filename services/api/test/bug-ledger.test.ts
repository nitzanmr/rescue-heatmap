// docs/bug-ledger.md is the checklist an agent reads before writing code. A
// checklist rots the moment its summary stops describing its body, so the
// counts in the class table are checked against the rows underneath, and every
// defect id must be unique and referenced from exactly one section.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const LEDGER = path.join(repo, "docs/bug-ledger.md");

test("the bug ledger exists", () => {
  assert.ok(existsSync(LEDGER), "docs/bug-ledger.md is missing");
});

const text = readFileSync(LEDGER, "utf8");

test("every defect id is unique", () => {
  const ids = [...text.matchAll(/^\| (?<id>[A-G]\d+) \|/gm)].map((m) => m.groups!.id);
  assert.ok(ids.length >= 30, `expected the ledger to carry the known defects, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, "a defect id is used twice");
});

test("the class summary counts match the rows below it", () => {
  const declared = new Map<string, number>();
  for (const m of text.matchAll(/^\| (?<cls>[A-G]) \| \*\*.*?\| (?<n>\d+) \|$/gm)) {
    declared.set(m.groups!.cls, Number(m.groups!.n));
  }
  assert.equal(declared.size, 7, "the class table must describe all seven classes");

  for (const [cls, n] of declared) {
    const rows = [...text.matchAll(new RegExp(`^\\| ${cls}\\d+ \\|`, "gm"))].length;
    assert.equal(rows, n, `class ${cls} claims ${n} defects and lists ${rows}`);
  }
});

test("AGENTS.md points at the ledger, so nobody has to find it by accident", () => {
  const agents = readFileSync(path.join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, /docs\/bug-ledger\.md/);
});

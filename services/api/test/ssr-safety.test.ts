// SSR safety: nothing a Next.js page pulls in statically may touch the browser
// at import time.
//
// Why this file exists, in one paragraph, because the failure was expensive:
// /mapa loaded the map with `dynamic(..., { ssr: false })` — correct — but the
// page ALSO did `import { KIND_STYLE } from "@/components/PublicMap"` for its
// legend. A static import of any binding pulls the whole module into the server
// bundle, so Leaflet ran during prerender and the build died on
// `ReferenceError: window is not defined`. The dynamic import was not wrong; it
// was bypassed. Nothing in the type system or the linter says a word about it,
// the dev server does not reproduce it, and it only surfaces at `next build` —
// i.e. inside the drill, where a failure blocks migrations and everything
// downstream. Hence a static test that runs in seconds.
//
// The check is a transitive one on purpose: a page importing a leaflet-free
// module that itself imports the map is the same bug wearing a hat.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const webSrc = path.join(root, "app/web/src");

// Packages that must never be evaluated on the server. Leaflet reads `window`
// in its module body; leaflet.heat augments Leaflet the same way.
const BROWSER_ONLY = ["leaflet", "leaflet.heat"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

// Static imports only. A `dynamic(() => import(...))` call is deliberately NOT
// matched: that is the escape hatch, and the whole point is to prove it is the
// only route to these modules.
function staticImports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) out.push(m[1]);
  const reExport = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;
  for (const m of src.matchAll(reExport)) out.push(m[1]);
  return out;
}

function resolve(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(webSrc, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // bare package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Returns the import chain from `entry` to a browser-only package, or null. */
function browserChain(entry: string, seen = new Set<string>()): string[] | null {
  if (seen.has(entry)) return null;
  seen.add(entry);
  for (const spec of staticImports(entry)) {
    if (BROWSER_ONLY.includes(spec)) return [path.relative(root, entry), spec];
    const next = resolve(spec, entry);
    if (!next) continue;
    const chain = browserChain(next, seen);
    if (chain) return [path.relative(root, entry), ...chain];
  }
  return null;
}

const pages = walk(path.join(webSrc, "app"));

test("every page is server-renderable: no static path to a browser-only module", () => {
  assert.ok(pages.length >= 6, "found suspiciously few pages — did the walk break?");
  for (const page of pages) {
    const chain = browserChain(page);
    assert.equal(
      chain,
      null,
      `${path.relative(root, page)} reaches a browser-only module statically:\n  ${chain?.join("\n  -> ")}\n` +
        "Load it with next/dynamic({ ssr: false }), and move any shared constants into src/lib/.",
    );
  }
});

test("the map components are only ever reached dynamically", () => {
  // The positive half of the same rule: prove the components DO import leaflet
  // (so the test above is actually testing something), and that no page names
  // them in a static import.
  for (const c of ["PublicMap.tsx", "HeatMap.tsx"]) {
    const file = path.join(webSrc, "components", c);
    assert.ok(fs.existsSync(file), `${c} moved — update this test`);
    assert.ok(staticImports(file).includes("leaflet"), `${c} no longer imports leaflet — is this test still needed?`);
  }
  for (const page of pages) {
    for (const spec of staticImports(page)) {
      assert.ok(
        !/(PublicMap|HeatMap)$/.test(spec),
        `${path.relative(root, page)} statically imports ${spec}; use next/dynamic with ssr: false`,
      );
    }
  }
});

test("shared aid-site styling lives in lib, free of browser globals", () => {
  const file = path.join(webSrc, "lib/aid-kinds.ts");
  assert.ok(fs.existsSync(file), "lib/aid-kinds.ts is where the legend table belongs");
  // Comments explain the rule and therefore name the globals; strip them.
  const src = fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const g of ["window", "document", "localStorage", "navigator"]) {
    assert.ok(!new RegExp(`\\b${g}\\b`).test(src), `aid-kinds.ts must not touch ${g}`);
  }
  assert.equal(staticImports(file).length, 0, "aid-kinds.ts should have no imports at all");
});

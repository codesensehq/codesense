// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleProblems, MARKERS } from "./verify-webdriver-absence";

// A release bundle in miniature: an entry, a lazy chunk and the page.
const clean = () =>
  new Map([
    ["index.html", '<!doctype html><script type="module" src="/assets/index-a1.js"></script>'],
    ["assets/index-a1.js", 'const e="main";window.__CODESENSE_CHANNEL__=e;'],
    ["assets/viewer-b2.js", "export function v(){return 1}"],
  ]);
// Every marker, as the webdriver build holds them.
const full = () => {
  const files = clean();
  files.set("assets/e2e-c3.js", MARKERS.map((marker) => `"${marker}"`).join(";"));
  return files;
};

describe("the release check", () => {
  it("passes a clean bundle", () => {
    expect(bundleProblems(clean())).toEqual([]);
  });

  it.each(MARKERS)("fails on %s in its own chunk", (marker) => {
    const files = clean();
    files.set("assets/e2e-x9.js", `window["${marker}"]={}`);
    expect(bundleProblems(files)).toEqual([`${marker}: in the release bundle (assets/e2e-x9.js)`]);
  });

  it.each(MARKERS)("fails on %s inlined into an unrelated chunk", (marker) => {
    const files = clean();
    files.set("assets/viewer-b2.js", `export function v(){return 1};const k="${marker}";`);
    expect(bundleProblems(files)).toEqual([
      `${marker}: in the release bundle (assets/viewer-b2.js)`,
    ]);
  });

  it("names a marker once per file that holds it", () => {
    const files = clean();
    files.set("assets/index-a1.js", "wdioTauri;wdioTauri");
    files.set("index.html", "<script>wdioTauri</script>");
    expect(bundleProblems(files)).toEqual([
      "wdioTauri: in the release bundle (index.html)",
      "wdioTauri: in the release bundle (assets/index-a1.js)",
    ]);
  });

  it("refuses an empty bundle", () => {
    expect(bundleProblems(new Map())).toHaveLength(1);
  });
});

describe("--expect-present", () => {
  it("passes a bundle that holds every marker", () => {
    expect(bundleProblems(full(), { expectPresent: true })).toEqual([]);
  });

  it.each(MARKERS)("fails when only %s is missing", (marker) => {
    const files = clean();
    files.set(
      "assets/e2e-c3.js",
      MARKERS.filter((m) => m !== marker)
        .map((m) => `"${m}"`)
        .join(";"),
    );
    // One marker can be a substring of another; this table has none, so each is checked alone.
    expect(bundleProblems(files, { expectPresent: true })).toEqual([
      `${marker}: missing from the webdriver bundle; the check cannot see it`,
    ]);
  });

  it("fails a clean bundle on every marker", () => {
    expect(bundleProblems(clean(), { expectPresent: true })).toHaveLength(MARKERS.length);
  });
});

// A new control's global joins the list, or the release check could not see it.
it("lists every E2E global the front-end sets", () => {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        for (const name of readFileSync(full, "utf8").match(/__CODESENSE_\w*E2E\w*__/g) ?? [])
          found.add(name);
    }
  };
  walk("src");
  expect(found.size).toBeGreaterThan(0);
  expect([...found].filter((name) => !MARKERS.includes(name))).toEqual([]);
});

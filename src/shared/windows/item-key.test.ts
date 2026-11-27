// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalItemKey,
  itemKeyForTab,
  parseCanonicalItemKey,
  TAB_ITEM_KIND,
  type ItemKey,
} from "./item-key";

interface Fixture {
  keys: { name: string; key: ItemKey; canonical: string }[];
  distinct: [string, string][];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../src-tauri/src/windows/fixtures/item-keys.json"),
    "utf8",
  ),
);

function row(name: string) {
  const found = fixture.keys.find((r) => r.name === name);
  if (!found) throw new Error(`no fixture row named ${name}`);
  return found;
}

describe("ItemKey (shared fixture with Rust)", () => {
  it.each(fixture.keys.map((r) => [r.name, r] as const))(
    "%s writes its canonical string",
    (_, r) => {
      expect(canonicalItemKey(r.key)).toBe(r.canonical);
    },
  );

  it.each(fixture.keys.map((r) => [r.name, r] as const))("%s round-trips", (_, r) => {
    expect(parseCanonicalItemKey(r.canonical)).toEqual(r.key);
  });

  it.each(fixture.distinct)("%s and %s are different items", (a, b) => {
    expect(canonicalItemKey(row(a).key)).not.toBe(canonicalItemKey(row(b).key));
  });

  it("every tab row is what itemKeyForTab builds from the bucket key and the path", () => {
    for (const r of fixture.keys.filter((k) => k.key.kind === TAB_ITEM_KIND)) {
      expect(itemKeyForTab(r.key.team, { path: r.key.id })).toEqual(r.key);
    }
  });

  it("parses only a three-string array", () => {
    expect(parseCanonicalItemKey("not json")).toBeNull();
    expect(parseCanonicalItemKey('["tab","t"]')).toBeNull();
    expect(parseCanonicalItemKey('["tab","t",1]')).toBeNull();
  });
});

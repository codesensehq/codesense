// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { BridgedFrameBudget } from "@/features/dashboard/lib/bridged-frame-budget";
import { VIEWER_PERF } from "@/shared/lib/viewer-perf-config";

import {
  evictHidden,
  isKeptByPredicate,
  registerKeepPredicate,
  resetKeepPredicatesForTests,
} from "./tile-keep-alive";

/** `n` hidden keys, least recently shown first. */
const hidden = (n: number, prefix = "t") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

afterEach(() => resetKeepPredicatesForTests());

describe("the tile keep-alive policy", () => {
  it("caps hidden bodies at tileKeepAliveMaxHidden (10) by default", () => {
    expect(VIEWER_PERF.tileKeepAliveMaxHidden).toBe(10);
    expect(evictHidden({ hidden: hidden(10) })).toEqual([]);
  });

  it("evicts the 2 least recently shown of 12 hidden bodies", () => {
    expect(evictHidden({ hidden: hidden(12) })).toEqual(["t0", "t1"]);
  });

  it("evicts a pin-keyed body as any hidden body when the pin set is omitted or empty", () => {
    expect(evictHidden({ hidden: hidden(11) })).toEqual(["t0"]);
    expect(evictHidden({ hidden: hidden(11), pins: new Set() })).toEqual(["t0"]);
  });

  it("never evicts a pinned key, even the least recent", () => {
    expect(evictHidden({ hidden: hidden(12), pins: new Set(["t0"]) })).toEqual(["t1", "t2"]);
  });

  it("never evicts a key a registered keep predicate names, even the least recent", () => {
    const off = registerKeepPredicate((key) => key === "t0");
    expect(isKeptByPredicate("t0")).toBe(true);
    expect(evictHidden({ hidden: hidden(12) })).toEqual(["t1", "t2"]);
    off();
    expect(isKeptByPredicate("t0")).toBe(false);
    expect(evictHidden({ hidden: hidden(12) })).toEqual(["t0", "t1"]);
  });

  it("never evicts a key the caller keeps (a cell's active tab)", () => {
    expect(evictHidden({ hidden: hidden(11), keep: (key) => key === "t0" })).toEqual(["t1"]);
  });

  it("keeps every protected body when they alone exceed the cap, evicts all others, once", () => {
    const keys = [...hidden(6, "p"), ...hidden(4, "o")];
    const asked: string[] = [];
    const off = registerKeepPredicate((key) => {
      asked.push(key);
      return key.startsWith("p");
    });
    // The halved cap (5) a lower memory budget passes: the policy takes the cap as an argument.
    const evicted = evictHidden({ hidden: keys, cap: 5 });
    expect(evicted).toEqual(["o0", "o1", "o2", "o3"]);
    // One pass: each key is asked about once.
    expect(asked).toEqual(keys);
    off();
  });

  it("leaves the frame budget to count a hidden body's frame", () => {
    const evicted: string[] = [];
    const budget = new BridgedFrameBudget(1, () => {});
    budget.register("visible", {
      visible: true,
      unsaved: false,
      privateSpace: false,
      flush: () => {},
      evict: () => evicted.push("visible"),
    });
    budget.register("hidden", {
      visible: false,
      unsaved: false,
      privateSpace: false,
      flush: () => {},
      evict: () => evicted.push("hidden"),
    });
    // The hidden tile's frame is one of the budget's frames: over the cap, it goes first.
    expect(evicted).toEqual(["hidden"]);
  });
});

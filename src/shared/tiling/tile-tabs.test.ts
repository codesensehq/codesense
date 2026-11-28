// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import type { CellTabs } from "./tile-host";
import { activateTab, closeTab, moveTab, openTab, tabsOf, type CellTabsMap } from "./tile-tabs";

const cells = (entries: Record<string, CellTabs>): CellTabsMap => new Map(Object.entries(entries));

describe("tile tabs", () => {
  it("reads a cell with no entry as one tab, its leaf id", () => {
    expect(tabsOf(new Map(), "c1")).toEqual({ keys: ["c1"], active: "c1" });
  });

  it("opens a tab after the shown one and shows it", () => {
    const start = cells({ c1: { keys: ["a", "b", "c"], active: "a" } });
    expect(openTab(start, "c1", "x").get("c1")).toEqual({
      keys: ["a", "x", "b", "c"],
      active: "x",
    });
  });

  it("opens a second tab in a one-tab cell beside its leaf id", () => {
    expect(openTab(new Map(), "c1", "x").get("c1")).toEqual({ keys: ["c1", "x"], active: "x" });
  });

  it("opens at an index in the background", () => {
    const start = cells({ c1: { keys: ["a", "b"], active: "b" } });
    expect(openTab(start, "c1", "x", { index: 0, activate: false }).get("c1")).toEqual({
      keys: ["x", "a", "b"],
      active: "b",
    });
  });

  it("only shows a key the cell already holds", () => {
    const start = cells({ c1: { keys: ["a", "b"], active: "a" } });
    expect(openTab(start, "c1", "b").get("c1")).toEqual({ keys: ["a", "b"], active: "b" });
  });

  it("closing the shown tab shows the next, else the one before", () => {
    const start = cells({ c1: { keys: ["a", "b", "c"], active: "b" } });
    expect(closeTab(start, "c1", "b").cells.get("c1")).toEqual({ keys: ["a", "c"], active: "c" });
    const last = cells({ c1: { keys: ["a", "b"], active: "b" } });
    expect(closeTab(last, "c1", "b").cells.get("c1")).toEqual({ keys: ["a"], active: "a" });
  });

  it("closing the last tab empties the cell", () => {
    const start = cells({ c1: { keys: ["a"], active: "a" } });
    const { cells: next, emptied } = closeTab(start, "c1", "a");
    expect(emptied).toBe(true);
    expect(next.has("c1")).toBe(false);
  });

  it("moves a tab, keeping the shown one", () => {
    const start = cells({ c1: { keys: ["a", "b", "c"], active: "b" } });
    expect(moveTab(start, "c1", "a", 2).get("c1")).toEqual({ keys: ["b", "c", "a"], active: "b" });
  });

  describe("identity", () => {
    const start = cells({
      c1: { keys: ["a", "b"], active: "a" },
      c2: { keys: ["d"], active: "d" },
    });

    it("returns its input when nothing changes", () => {
      expect(activateTab(start, "c1", "a")).toBe(start);
      expect(activateTab(start, "c1", "zzz")).toBe(start);
      expect(openTab(start, "c1", "a")).toBe(start);
      expect(moveTab(start, "c1", "a", 0)).toBe(start);
      expect(moveTab(start, "c1", "zzz", 1)).toBe(start);
      expect(closeTab(start, "c1", "zzz").cells).toBe(start);
    });

    it("keeps every other cell's entry by reference", () => {
      const ops = [
        openTab(start, "c1", "x"),
        activateTab(start, "c1", "b"),
        moveTab(start, "c1", "b", 0),
        closeTab(start, "c1", "b").cells,
      ];
      for (const next of ops) {
        expect(next).not.toBe(start);
        expect(next.get("c2")).toBe(start.get("c2"));
      }
    });

    it("keeps the keys array when only the shown tab changes", () => {
      expect(activateTab(start, "c1", "b").get("c1")?.keys).toBe(start.get("c1")?.keys);
    });
  });
});

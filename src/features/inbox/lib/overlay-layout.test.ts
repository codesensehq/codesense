// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { overlayLayout, overlayPlacement } from "./overlay-layout";

describe("overlayLayout", () => {
  // The design's breakpoints: the four reference pane sizes and the docked overlay.
  it.each([
    [
      250,
      250,
      { width: "XS", height: "short", head: "one-line", record: "own-line", pins: "line" },
    ],
    [300, 700, { width: "XS", height: "tall", head: "two-line", record: "own-line", pins: "rows" }],
    [900, 250, { width: "L", height: "short", head: "one-line", record: "in-head", pins: "rail" }],
    [
      640,
      480,
      { width: "M", height: "medium", head: "two-line", record: "own-line", pins: "tiles" },
    ],
    [420, 690, { width: "S", height: "tall", head: "two-line", record: "own-line", pins: "rows" }],
  ])("lays out a %i × %i pane as the design draws it", (w, h, expected) => {
    expect(overlayLayout(w, h)).toMatchObject(expected);
  });

  it("folds the head to one line under 480 wide and 600 tall, and shows the kind from 400 × 600", () => {
    expect(overlayLayout(470, 590).head).toBe("one-line");
    expect(overlayLayout(470, 600).head).toBe("two-line");
    expect(overlayLayout(399, 700).showKind).toBe(false);
    expect(overlayLayout(400, 600).showKind).toBe(true);
  });

  it("uses the line of chips when short and narrow, or medium and under 480 wide", () => {
    expect(overlayLayout(639, 300).pins).toBe("line");
    expect(overlayLayout(640, 300).pins).toBe("rail");
    expect(overlayLayout(479, 500).pins).toBe("line");
    expect(overlayLayout(480, 360).pins).toBe("tiles");
  });

  it("drops time, then files, then the model from the record line; cost and link stay", () => {
    expect(overlayLayout(500, 700).recordFields).toEqual([
      "model",
      "cost",
      "files",
      "time",
      "story",
    ]);
    expect(overlayLayout(450, 700).recordFields).toEqual(["model", "cost", "files", "story"]);
    expect(overlayLayout(350, 700).recordFields).toEqual(["model", "cost", "story"]);
    expect(overlayLayout(250, 700).recordFields).toEqual(["cost", "story"]);
  });

  it("sets text at 13 px from 400 × 480, else 12 px, and avatars go when XS or short", () => {
    expect(overlayLayout(400, 480).textPx).toBe(13);
    expect(overlayLayout(399, 480).textPx).toBe(12);
    expect(overlayLayout(300, 700).avatars).toBe(false);
    expect(overlayLayout(900, 250).avatars).toBe(false);
    expect(overlayLayout(420, 690).avatars).toBe(true);
  });
});

describe("overlayPlacement", () => {
  it("docks at 420 px when the tab is 840+ wide and 360+ tall, else covers it", () => {
    expect(overlayPlacement(840, 360)).toEqual({ mode: "dock", width: 420 });
    expect(overlayPlacement(839, 800)).toEqual({ mode: "cover" });
    expect(overlayPlacement(1200, 359)).toEqual({ mode: "cover" });
  });
});

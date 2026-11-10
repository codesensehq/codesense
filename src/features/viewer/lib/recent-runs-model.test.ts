// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { runLabel } from "./recent-runs-model";

describe("runLabel", () => {
  it("names a routine run by its routine id", () => {
    expect(runLabel("routine:acme/backend/weekly-digest@digest-run-3")).toBe("weekly-digest");
  });

  it("formats any other handle like a live agent row", () => {
    expect(runLabel("SW-DX-3#attempt-2")).toBe("SW-DX-3 · Attempt 2");
  });

  it("returns null with no handle", () => {
    expect(runLabel(null)).toBeNull();
    expect(runLabel("  ")).toBeNull();
  });
});

// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { fileChangeAffects } from "./file-change-affects";

describe("fileChangeAffects", () => {
  it("is true for a coarse refresh, an exact file and a containing directory", () => {
    expect(fileChangeAffects(null, "/a/b.md")).toBe(true);
    expect(fileChangeAffects(new Set(["/a/b.md"]), "/a/b.md")).toBe(true);
    expect(fileChangeAffects(new Set(["/a"]), "/a/b.md")).toBe(true);
    expect(fileChangeAffects(new Set(["/a/"]), "/a/b.md")).toBe(true);
  });

  it("is false for a sibling prefix and with no file", () => {
    expect(fileChangeAffects(new Set(["/a2"]), "/a/b.md")).toBe(false);
    expect(fileChangeAffects(new Set(["/a"]), null)).toBe(false);
  });

  it("matches Windows paths across separators", () => {
    expect(fileChangeAffects(new Set(["C:/a"]), "C:\\a\\b.md")).toBe(true);
    expect(fileChangeAffects(new Set(["C:\\a"]), "C:\\a2\\b")).toBe(false);
  });
});

// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { rewriteTeamContentPaths } from "./viewer-store";

const KEY = "acme:new";
const rewrite = (path: string) =>
  rewriteTeamContentPaths({ activeTab: { [KEY]: path } }, KEY, "old", "new").activeTab?.[KEY];

describe("rewriteTeamContentPaths", () => {
  it("rewrites the team segment of a POSIX content path", () => {
    expect(rewrite("/o/old/content/a.md")).toBe("/o/new/content/a.md");
  });

  it("rewrites a drive-letter path and keeps its backslashes", () => {
    expect(rewrite("C:\\o\\old\\content\\a.md")).toBe("C:\\o\\new\\content\\a.md");
  });

  it("keeps each matched separator as written", () => {
    expect(rewrite("C:/o\\old/content\\a.md")).toBe("C:/o\\new/content\\a.md");
    expect(rewrite("C:\\o\\old\\content")).toBe("C:\\o\\new\\content");
  });

  it("leaves a path whose team segment isn't followed by a layer marker", () => {
    expect(rewrite("C:\\o\\old\\notes\\a.md")).toBe("C:\\o\\old\\notes\\a.md");
  });
});

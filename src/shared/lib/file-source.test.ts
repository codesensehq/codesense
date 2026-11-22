// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";

import { useWorktreeRosterStore } from "@/features/viewer/stores/worktree-roster-store";
import type { WorktreeRow } from "@/tauri/commands";
import { resolveFileSource } from "./file-source";

function contextRow(path: string): WorktreeRow {
  return {
    kind: "context",
    id: "wt-1",
    path,
    launchCwd: `${path}\\t\\content`,
  } as unknown as WorktreeRow;
}

describe("resolveFileSource", () => {
  beforeEach(() => {
    useWorktreeRosterStore.setState({ rows: null });
  });

  it("keeps a file inside a context worktree on that worktree", () => {
    useWorktreeRosterStore.setState({ rows: [contextRow("C:\\wt\\ctx")] });
    expect(resolveFileSource("C:/wt/ctx/t/content/a.md").source).toEqual({
      kind: "worktree",
      id: "wt-1",
    });
  });

  it("does not treat the worktree root or a sibling as inside it", () => {
    useWorktreeRosterStore.setState({ rows: [contextRow("C:\\wt\\ctx")] });
    expect(resolveFileSource("C:\\wt\\ctx").source.kind).toBe("clone");
    expect(resolveFileSource("C:\\wt\\ctx2\\a.md").source.kind).toBe("clone");
  });
});

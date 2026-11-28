// SPDX-License-Identifier: MIT
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiffTileBody, diffNavigatorOf } from "./diff-tile-body";
import { DiffWorktreesContext, type DiffWorktreeRow } from "./tile-tab-faces";

const reads = vi.hoisted(() => ({
  changeset: [] as unknown[][],
  redline: [] as unknown[][],
  files: [] as { path: string; status: string }[] | null,
}));
vi.mock("../lib/use-source-diff", () => ({
  useSourceChangeset: (...args: unknown[]) => {
    reads.changeset.push(args);
    return { files: args[2] ? reads.files : null, loading: false, error: null, reload: () => {} };
  },
  useSourceFileRedline: (...args: unknown[]) => {
    reads.redline.push(args);
    return { redline: { binary: false, status: "modified", before: "a", after: "b" }, error: null };
  },
}));
const nav = vi.hoisted(() => ({ next: vi.fn(), prev: vi.fn(), currentLine: () => 1 }));
vi.mock("./source-diff-overlay", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    SourceDiffPane: (p: any) => {
      useImperativeHandle(p.navRef, () => nav);
      return <div data-testid="diff-pane">{p.filePath}</div>;
    },
  };
});

const row: DiffWorktreeRow = {
  kind: "context",
  id: "ctx-demo",
  branch: "ctx/DEMO-63",
  files: 2,
  path: "/home/me/code/ctx-demo",
  repo: { kind: "local", cwd: "/home/me/code/ctx-demo" },
  baseRef: "main",
};
const KEY = "diff:context:ctx-demo";

function body(visible = true, rows = [row], tileKey = KEY) {
  return render(
    <DiffWorktreesContext.Provider value={rows}>
      <DiffTileBody tileKey={tileKey} context={{ visible, reportLoading: vi.fn() }} />
    </DiffWorktreesContext.Provider>,
  );
}

beforeEach(() => {
  reads.changeset = [];
  reads.redline = [];
  reads.files = [
    { path: "README.md", status: "modified" },
    { path: "src/a.ts", status: "added" },
  ];
});

describe("DiffTileBody", () => {
  it("diffs its worktree against its base and shows the first changed file", () => {
    body();
    expect(reads.changeset.at(-1)).toEqual([row.repo, "main", true]);
    expect(screen.getByTestId("diff-pane")).toHaveTextContent("README.md");
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(screen.getByTestId("diff-pane")).toHaveTextContent("src/a.ts");
    expect(reads.redline.at(-1)?.slice(0, 2)).toEqual([row.repo, "src/a.ts"]);
  });

  it("reads nothing while its tile does not show it", () => {
    body(false);
    expect(reads.changeset.every((args) => args[2] === false)).toBe(true);
  });

  it("hands its bar's ‹ › the shown file's change navigator", () => {
    const { unmount } = body();
    diffNavigatorOf(KEY)?.next();
    expect(nav.next).toHaveBeenCalled();
    unmount();
    expect(diffNavigatorOf(KEY)).toBeNull();
  });

  it("says so with no changes, or for a worktree that isn't the story's", () => {
    reads.files = [];
    const { unmount } = body();
    expect(screen.getByRole("status")).toHaveTextContent("No changes yet.");
    unmount();
    body(true, [row], "diff:source:other");
    expect(screen.getByRole("status")).toHaveTextContent("This worktree isn't one of the story's.");
  });
});

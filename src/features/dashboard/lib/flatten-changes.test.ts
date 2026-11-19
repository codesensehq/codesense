// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { buildTree } from "@/shared/lib/pipeline-graph/test-fixtures/derived-tree";
import { buildPipelineGraph } from "@/shared/lib/pipeline-graph/pipeline-graph";
import type { NavChange } from "@/features/git-sync/lib/nav-changes";
import { flattenChanges } from "./flatten-changes";

function rows(root: string, changes: NavChange[], cloneRoot?: string) {
  const tree = buildTree("", { absoluteDirPath: root });
  return flattenChanges({
    tree,
    graph: buildPipelineGraph(tree),
    changes,
    cloneRoot,
    countsByAbsPath: new Map(),
    collapsed: new Set(),
  }).map((item) =>
    item.type === "generic-dir" || item.type === "generic-file"
      ? { type: item.type, name: item.entry.name, path: item.entry.path, depth: item.depth }
      : { type: item.type },
  );
}

const change = (absPath: string, relPath: string): NavChange => ({
  absPath,
  relPath,
  kind: "modified",
});

describe("flattenChanges", () => {
  it("files a change under its folders, folding a chain of plain folders", () => {
    expect(
      rows("/org/team", [change("/org/team/repos/widgets/a.txt", "team/repos/widgets/a.txt")]),
    ).toEqual([
      { type: "generic-dir", name: "repos › widgets", path: "/org/team/repos/widgets", depth: 0 },
      { type: "generic-file", name: "a.txt", path: "/org/team/repos/widgets/a.txt", depth: 1 },
    ]);
  });

  it("files a Windows change under its parent folders and names", () => {
    expect(
      rows("C:\\org\\team", [
        change("C:\\org\\team\\repos\\widgets\\a.txt", "team/repos/widgets/a.txt"),
      ]),
    ).toEqual([
      {
        type: "generic-dir",
        name: "repos › widgets",
        path: "C:\\org\\team\\repos\\widgets",
        depth: 0,
      },
      {
        type: "generic-file",
        name: "a.txt",
        path: "C:\\org\\team\\repos\\widgets\\a.txt",
        depth: 1,
      },
    ]);
  });

  it("places a change by its clone-relative path on a Windows clone", () => {
    expect(
      rows(
        "C:\\org\\team",
        [change("C:\\org\\team\\notes\\b.md", "team/notes/b.md")],
        "C:\\org",
      ).map((r) => ("name" in r ? r.name : r.type)),
    ).toEqual(["notes", "b.md"]);
  });

  it("leaves out changes outside the tree", () => {
    expect(rows("/org/team", [change("/org/other/a.txt", "other/a.txt")])).toEqual([]);
    expect(rows("C:\\org\\team", [change("C:\\org\\teammate\\a.txt", "teammate/a.txt")])).toEqual(
      [],
    );
  });
});

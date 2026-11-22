// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { planReveal, type RevealInput } from "./reveal-plan";

const at = (over: Partial<RevealInput> & Pick<RevealInput, "treeRoot" | "navigationPath">) =>
  planReveal({ currentDrill: over.treeRoot, currentScope: "", isPipelineFile: true, ...over });

describe("planReveal: POSIX (today's behaviour)", () => {
  const treeRoot = "/t/content";

  it("expands every folder between a nested file and the root, and keeps a drill that holds it", () => {
    expect(
      at({
        treeRoot,
        navigationPath: "/t/content/stories/epic/a.md",
        currentDrill: "/t/content/stories",
      }),
    ).toEqual({
      ancestors: ["/t/content/stories/epic", "/t/content/stories"],
      effectiveDrill: "/t/content/stories",
      resetScope: false,
      insideViewerRoot: true,
    });
  });

  it("expands nothing for a root-level file", () => {
    expect(at({ treeRoot, navigationPath: "/t/content/a.md" })).toEqual({
      ancestors: [],
      effectiveDrill: treeRoot,
      resetScope: false,
      insideViewerRoot: true,
    });
  });

  it("resets the drill to the root for a file outside it, and the scope with it when set", () => {
    const outside = {
      treeRoot,
      navigationPath: "/t/content/docs/r.md",
      currentDrill: "/t/content/stories",
    };
    expect(at({ ...outside, currentScope: "stories" })).toEqual({
      ancestors: ["/t/content/docs"],
      effectiveDrill: treeRoot,
      resetScope: true,
      insideViewerRoot: true,
    });
    expect(at(outside).resetScope).toBe(false);
  });

  it("keeps the scope for a non-story file inside it", () => {
    const plan = at({
      treeRoot,
      navigationPath: "/t/content/stories/epic/README.md",
      currentScope: "stories/epic",
      isPipelineFile: false,
    });
    expect(plan.resetScope).toBe(false);
    // The scope folder itself counts as inside.
    expect(
      at({
        treeRoot,
        navigationPath: "/t/content/stories/epic",
        currentScope: "stories/epic",
        isPipelineFile: false,
      }).resetScope,
    ).toBe(false);
  });

  it("clears the scope for a non-story file outside it, but not for a story file", () => {
    const outside = {
      treeRoot,
      navigationPath: "/t/content/docs/README.md",
      currentScope: "stories/epic",
    };
    expect(at({ ...outside, isPipelineFile: false }).resetScope).toBe(true);
    expect(at({ ...outside, isPipelineFile: true }).resetScope).toBe(false);
  });

  it("treats a sibling folder that shares the root's prefix as outside", () => {
    expect(at({ treeRoot, navigationPath: "/t/content-old/a.md" })).toEqual({
      ancestors: [],
      effectiveDrill: treeRoot,
      resetScope: false,
      insideViewerRoot: false,
    });
  });
});

describe("planReveal: Windows and UNC", () => {
  it("walks a C:\\ file under a C:\\ root and keeps the drill", () => {
    expect(
      at({
        treeRoot: "C:\\t\\content",
        navigationPath: "C:\\t\\content\\stories\\epic\\a.md",
        currentDrill: "C:\\t\\content\\stories",
      }),
    ).toEqual({
      ancestors: ["C:\\t\\content\\stories\\epic", "C:\\t\\content\\stories"],
      effectiveDrill: "C:\\t\\content\\stories",
      resetScope: false,
      insideViewerRoot: true,
    });
  });

  it("walks a git-for-Windows C:/ spelling in its own spelling", () => {
    expect(
      at({
        treeRoot: "C:/t/content",
        navigationPath: "C:/t/content/stories/epic/a.md",
        currentDrill: "C:/t/content/stories",
      }),
    ).toEqual({
      ancestors: ["C:/t/content/stories/epic", "C:/t/content/stories"],
      effectiveDrill: "C:/t/content/stories",
      resetScope: false,
      insideViewerRoot: true,
    });
  });

  it("builds ancestors from the navigation path's spelling when the root is spelled the other way", () => {
    const plan = at({
      treeRoot: "C:\\t\\content",
      navigationPath: "C:/t/content/stories/epic/a.md",
      currentDrill: "C:\\t\\content\\stories",
    });
    expect(plan.ancestors).toEqual(["C:/t/content/stories/epic", "C:/t/content/stories"]);
    expect(plan.effectiveDrill).toBe("C:\\t\\content\\stories");
  });

  it("walks a UNC root the same way", () => {
    expect(
      at({
        treeRoot: "\\\\srv\\share\\content",
        navigationPath: "\\\\srv\\share\\content\\stories\\epic\\a.md",
        currentDrill: "\\\\srv\\share\\content\\stories",
      }),
    ).toEqual({
      ancestors: ["\\\\srv\\share\\content\\stories\\epic", "\\\\srv\\share\\content\\stories"],
      effectiveDrill: "\\\\srv\\share\\content\\stories",
      resetScope: false,
      insideViewerRoot: true,
    });
  });

  it("gives a file on another drive no ancestors and resets the drill to the root", () => {
    expect(
      at({
        treeRoot: "C:\\t\\content",
        navigationPath: "D:\\other\\a.md",
        currentDrill: "C:\\t\\content\\stories",
      }),
    ).toEqual({
      ancestors: [],
      effectiveDrill: "C:\\t\\content",
      resetScope: false,
      insideViewerRoot: false,
    });
  });

  it("joins the /-delimited scope onto a C:\\ root", () => {
    const scoped = {
      treeRoot: "C:\\t\\content",
      currentScope: "stories/epic",
      isPipelineFile: false,
    };
    expect(
      at({ ...scoped, navigationPath: "C:\\t\\content\\stories\\epic\\README.md" }).resetScope,
    ).toBe(false);
    expect(at({ ...scoped, navigationPath: "C:\\t\\content\\docs\\README.md" }).resetScope).toBe(
      true,
    );
  });
});

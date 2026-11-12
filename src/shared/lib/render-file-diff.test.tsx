// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { stubResizeObserver } from "@/test/resize-observer-stub";

// Stub every renderer to a marker: this suite checks the dispatch, not them.
vi.mock("@/features/git-sync/components/redline-prose", () => ({
  RedlineProse: ({
    before,
    after,
    error,
  }: {
    before: string | null;
    after: string | null;
    error?: string | null;
  }) =>
    error ? (
      <div data-testid="redline-error">{error}</div>
    ) : (
      <div data-testid="redline">
        {String(before)}→{String(after)}
      </div>
    ),
}));
vi.mock("@/features/git-sync/components/rendered-markdown", () => ({
  RenderedMarkdown: ({ text }: { text: string }) => <div data-testid="rendered-md">{text}</div>,
}));
vi.mock("@/shared/components/code-editor", async (orig) => ({
  ...(await orig<typeof import("@/shared/components/code-editor")>()),
  CodeDiffReview: ({
    before,
    after,
    diffMode,
    mode,
  }: {
    before: string;
    after: string;
    diffMode?: string;
    mode?: string;
  }) => (
    <div data-testid="code-diff" data-diff-mode={diffMode ?? "line"} data-mode={mode}>
      {before}→{after}
    </div>
  ),
}));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: ({ baselineSource }: { baselineSource?: unknown }) => (
    <div data-testid="html" data-baseline={baselineSource ? "yes" : "no"} />
  ),
}));
vi.mock("@/features/dashboard/components/image-viewer", () => ({
  ImageViewer: ({ baselineSource }: { baselineSource?: unknown }) => (
    <div data-testid="image" data-baseline={baselineSource ? "yes" : "no"} />
  ),
}));
vi.mock("@/features/dashboard/components/excalidraw-viewer", () => ({
  ExcalidrawViewer: ({
    sceneText,
    readOnly,
  }: {
    sceneText?: string | null;
    readOnly?: boolean;
  }) => (
    <div
      data-testid="excalidraw"
      data-scene={sceneText ?? "DISK"}
      data-readonly={String(!!readOnly)}
    />
  ),
}));

import { LARGE_DIFF_CHARS, renderFileDiff, type FileDiffArgs } from "./render-file-diff";
import { DEFAULT_FILE_DIFF_MODES, type FileDiffModes } from "./file-diff-mode";
import { getViewerFileType } from "./viewer-file-type";

const rendered = {
  absPath: "/ctx/page.html",
  teamContentPath: "/ctx/content",
  baselineSource: { orgRoot: "/ctx", relPath: "page.html", tree: "abc" },
};

function args(
  filePath: string,
  over: Partial<Omit<FileDiffArgs, "prefs">> & { modes?: Partial<FileDiffModes> } = {},
  prefs: Partial<FileDiffArgs["prefs"]> = {},
): FileDiffArgs {
  const { modes, ...rest } = over;
  return {
    fileType: getViewerFileType(filePath),
    filePath,
    sides: { before: "old", after: "new", status: "modified" },
    state: { kind: "ready" },
    ...rest,
    prefs: { modes: { ...DEFAULT_FILE_DIFF_MODES, ...modes }, ...prefs },
  };
}

let ro: ReturnType<typeof stubResizeObserver> | null = null;
function atWidth(width: number) {
  ro = stubResizeObserver(width);
}
afterEach(() => {
  ro?.restore();
  ro = null;
});

describe("renderFileDiff — markdown (AC 1)", () => {
  it("renders the block redline by default", () => {
    render(renderFileDiff(args("/ctx/a.md")));
    expect(screen.getByTestId("redline")).toHaveTextContent("old→new");
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("side by side shows both rendered sides at 900 px", () => {
    atWidth(900);
    render(renderFileDiff(args("/ctx/a.md", { modes: { markdown: "side-by-side" } })));
    const panes = screen.getAllByTestId("rendered-md");
    expect(panes.map((p) => p.textContent)).toEqual(["old", "new"]);
    expect(screen.getByTestId("file-diff-side-by-side")).toBeInTheDocument();
  });

  it("side by side falls back to the Before | After toggle below 900 px", () => {
    atWidth(899);
    render(renderFileDiff(args("/ctx/a.md", { modes: { markdown: "side-by-side" } })));
    expect(screen.getAllByTestId("rendered-md").map((p) => p.textContent)).toEqual(["new"]);
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getAllByTestId("rendered-md").map((p) => p.textContent)).toEqual(["old"]);
  });

  it("source mode shows the text diff in the code mode", () => {
    render(
      renderFileDiff(args("/ctx/a.md", { modes: { markdown: "source", code: "structural" } })),
    );
    expect(screen.getByTestId("code-diff")).toHaveAttribute("data-diff-mode", "structural");
    expect(screen.queryByTestId("redline")).toBeNull();
  });

  it("the mode switch reports the chosen markdown mode", () => {
    const onModeChange = vi.fn();
    render(renderFileDiff(args("/ctx/a.md", {}, { onModeChange })));
    const strip = screen.getByTestId("file-diff-mode-switch");
    expect(within(strip).getByRole("button", { name: "Redline" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(strip).getByRole("button", { name: "Side by side" }));
    expect(onModeChange).toHaveBeenCalledWith("markdown", "side-by-side");
  });
});

describe("renderFileDiff — HTML, image, Excalidraw (AC 2)", () => {
  it("Files: HTML renders Before and After live side by side at 900 px", () => {
    atWidth(900);
    render(renderFileDiff(args("/ctx/page.html", { sides: { ...sides(), rendered } })));
    const frames = screen.getAllByTestId("html");
    expect(frames.map((f) => f.dataset.baseline)).toEqual(["yes", "no"]);
  });

  it("Files: HTML shows the toggle at 899 px, After first", () => {
    atWidth(899);
    render(renderFileDiff(args("/ctx/page.html", { sides: { ...sides(), rendered } })));
    expect(screen.getAllByTestId("html").map((f) => f.dataset.baseline)).toEqual(["no"]);
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getAllByTestId("html").map((f) => f.dataset.baseline)).toEqual(["yes"]);
  });

  it("Files: HTML Source mode shows the text diff", () => {
    render(
      renderFileDiff(
        args("/ctx/page.html", { sides: { ...sides(), rendered }, modes: { html: "source" } }),
      ),
    );
    expect(screen.getByTestId("code-diff")).toHaveTextContent("old→new");
    expect(screen.queryByTestId("html")).toBeNull();
  });

  it("off Files (no rendered source): HTML is the Source text diff and no rendered mode is offered", () => {
    atWidth(1200);
    render(renderFileDiff(args("/repo/page.html", {}, { onModeChange: vi.fn() })));
    expect(screen.getByTestId("code-diff")).toBeInTheDocument();
    expect(screen.queryByTestId("html")).toBeNull();
    expect(screen.queryByRole("button", { name: "Side by side" })).toBeNull();
    // It is a code diff there, so it offers the code modes.
    expect(screen.getByRole("button", { name: "Structural" })).toBeInTheDocument();
  });

  it("off Files: a binary image shows the binary affordance", () => {
    render(
      renderFileDiff(
        args("/repo/logo.png", { state: { kind: "binary" } }, { binary: <p>binary here</p> }),
      ),
    );
    expect(screen.getByText("binary here")).toBeInTheDocument();
    expect(screen.queryByTestId("image")).toBeNull();
  });

  it("Files: a binary image still renders its sides side by side", () => {
    atWidth(1000);
    render(
      renderFileDiff(
        args("/ctx/logo.png", {
          sides: { ...sides(), rendered: { ...rendered, absPath: "/ctx/logo.png" } },
          state: { kind: "binary" },
        }),
      ),
    );
    expect(screen.getAllByTestId("image")).toHaveLength(2);
  });

  it("Files: Excalidraw's before side is the baseline scene, both read-only", () => {
    atWidth(1000);
    render(
      renderFileDiff(
        args("/ctx/d.excalidraw", {
          sides: {
            ...sides(),
            before: "{scene}",
            rendered: { ...rendered, absPath: "/ctx/d.excalidraw" },
          },
        }),
      ),
    );
    const canvases = screen.getAllByTestId("excalidraw");
    expect(canvases.map((c) => c.dataset.scene)).toEqual(["{scene}", "DISK"]);
    expect(canvases.every((c) => c.dataset.readonly === "true")).toBe(true);
  });
});

describe("renderFileDiff — code (AC 3)", () => {
  it("a .ts change is a CodeDiffReview in the code mode, never a redline", () => {
    render(renderFileDiff(args("/repo/a.ts", { modes: { code: "ignoreWhitespace" } })));
    expect(screen.getByTestId("code-diff")).toHaveAttribute("data-diff-mode", "ignoreWhitespace");
    expect(screen.queryByTestId("redline")).toBeNull();
  });

  it("splits at 900 px and goes inline below unless the surface fixes the layout", () => {
    atWidth(900);
    const { unmount } = render(renderFileDiff(args("/repo/a.ts")));
    expect(screen.getByTestId("code-diff")).toHaveAttribute("data-mode", "split");
    unmount();
    ro!.setWidth(899);
    render(renderFileDiff(args("/repo/a.ts")));
    expect(screen.getByTestId("code-diff")).toHaveAttribute("data-mode", "inline");
  });

  it("the code mode switch reports the chosen mode", () => {
    const onModeChange = vi.fn();
    render(renderFileDiff(args("/repo/a.ts", {}, { onModeChange })));
    fireEvent.click(screen.getByRole("button", { name: "Structural" }));
    expect(onModeChange).toHaveBeenCalledWith("code", "structural");
  });
});

describe("renderFileDiff — edge states (AC 7)", () => {
  it("loading: the markdown redline shows its skeleton, code a quiet skeleton", () => {
    render(renderFileDiff(args("/ctx/a.md", { state: { kind: "loading" } })));
    expect(screen.getByTestId("redline")).toHaveTextContent("null→null");
    render(renderFileDiff(args("/repo/a.ts", { state: { kind: "loading" } })));
    expect(screen.getByTestId("file-diff-code-skeleton")).toBeInTheDocument();
  });

  it("error: shown in place", () => {
    render(renderFileDiff(args("/repo/a.ts", { state: { kind: "error", message: "boom" } })));
    expect(screen.getByTestId("file-diff-code-error")).toHaveTextContent("boom");
  });

  it("binary: the surface's affordance", () => {
    render(
      renderFileDiff(
        args("/repo/a.ts", { state: { kind: "binary" } }, { binary: <p>no text diff</p> }),
      ),
    );
    expect(screen.getByText("no text diff")).toBeInTheDocument();
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("added: side by side shows only the present side, labelled", () => {
    atWidth(1200);
    render(
      renderFileDiff(
        args("/ctx/a.md", {
          sides: { before: "", after: "new", status: "added" },
          modes: { markdown: "side-by-side" },
        }),
      ),
    );
    expect(screen.getAllByTestId("rendered-md").map((p) => p.textContent)).toEqual(["new"]);
    expect(screen.getByTestId("file-diff-one-side")).toHaveTextContent("After");
    expect(screen.queryByRole("button", { name: "Before" })).toBeNull();
  });

  it("deleted: side by side shows only the baseline, labelled", () => {
    atWidth(1200);
    render(
      renderFileDiff(
        args("/ctx/page.html", {
          sides: { ...sides(), after: "", status: "deleted", rendered },
        }),
      ),
    );
    expect(screen.getAllByTestId("html").map((f) => f.dataset.baseline)).toEqual(["yes"]);
    expect(screen.getByTestId("file-diff-one-side")).toHaveTextContent("Before");
  });

  it("large diff: gated, then shown in line mode", () => {
    const big = "x".repeat(LARGE_DIFF_CHARS);
    render(
      renderFileDiff(
        args("/repo/a.ts", { sides: { ...sides(), before: big }, modes: { code: "structural" } }),
      ),
    );
    expect(screen.getByTestId("file-diff-large-gate")).toBeInTheDocument();
    expect(screen.queryByTestId("code-diff")).toBeNull();
    fireEvent.click(screen.getByTestId("file-diff-show-anyway"));
    expect(screen.getByTestId("code-diff")).toHaveAttribute("data-diff-mode", "line");
  });

  it("a surface's test-id prefix carries through to the shared states", () => {
    render(
      renderFileDiff(
        args("/repo/a.ts", { state: { kind: "loading" } }, { testIdPrefix: "source-diff" }),
      ),
    );
    expect(screen.getByTestId("source-diff-code-skeleton")).toBeInTheDocument();
  });
});

function sides() {
  return { before: "old", after: "new", status: "modified" as const };
}

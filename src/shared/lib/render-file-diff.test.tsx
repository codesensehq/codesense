// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { stubResizeObserver } from "@/test/resize-observer-stub";

// Every CodeDiffReview render, by layout: a remount at a new width shows up here.
const codeDiffMounts = vi.hoisted((): string[] => []);

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
  }) => {
    codeDiffMounts.push(mode ?? "");
    return (
      <div data-testid="code-diff" data-diff-mode={diffMode ?? "line"} data-mode={mode}>
        {before}→{after}
      </div>
    );
  },
}));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: ({ baselineSource, snapshot }: { baselineSource?: unknown; snapshot?: boolean }) => (
    <div
      data-testid="html"
      data-baseline={baselineSource ? "yes" : "no"}
      data-snapshot={String(snapshot ?? true)}
    />
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

vi.mock("./side-frame", () => ({
  SideFrame: ({ html, title }: { html: string; title: string }) => (
    <div data-testid="side-frame" data-title={title}>
      {html}
    </div>
  ),
  SideImage: ({ base64, alt }: { base64: string; alt: string }) => (
    <div data-testid="side-image" data-alt={alt}>
      {base64}
    </div>
  ),
}));

import {
  FileDiffModeSwitch,
  IMAGE_UNAVAILABLE,
  LARGE_DIFF_CHARS,
  renderFileDiff,
  type FileDiffArgs,
} from "./render-file-diff";
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
    // Neither pane draws the Snapshot band, so both pages start level.
    expect(frames.map((f) => f.dataset.snapshot)).toEqual(["false", "false"]);
    // Files serves the page beside its linked files, so there is nothing to note.
    expect(screen.queryByTestId("file-diff-rendered-alone")).toBeNull();
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

  it("off Files: HTML renders Before and After from their text side by side at 900 px", () => {
    atWidth(900);
    render(renderFileDiff(args("/repo/page.html", {}, { onModeChange: vi.fn() })));
    const frames = screen.getAllByTestId("side-frame");
    expect(frames.map((f) => [f.dataset.title, f.textContent])).toEqual([
      ["Before", "old"],
      ["After", "new"],
    ]);
    expect(screen.getByTestId("file-diff-side-by-side")).toBeInTheDocument();
    expect(screen.queryByTestId("code-diff")).toBeNull();
    // It renders alone, and says so once under the diff.
    expect(screen.getByTestId("file-diff-rendered-alone")).toHaveTextContent(
      "Rendered on its own: linked files such as stylesheets and images aren't loaded here.",
    );
    expect(screen.queryByTestId("html")).toBeNull();
  });

  it("off Files: HTML shows the Before | After toggle at 899 px, After first", () => {
    atWidth(899);
    render(renderFileDiff(args("/repo/page.html")));
    expect(screen.getAllByTestId("side-frame").map((f) => f.textContent)).toEqual(["new"]);
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getAllByTestId("side-frame").map((f) => f.textContent)).toEqual(["old"]);
  });

  it("off Files: Source stays a mode away, as the text diff", () => {
    atWidth(1200);
    const onModeChange = vi.fn();
    const { rerender } = render(renderFileDiff(args("/repo/page.html", {}, { onModeChange })));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onModeChange).toHaveBeenCalledWith("html", "source");
    rerender(
      renderFileDiff(args("/repo/page.html", { modes: { html: "source" } }, { onModeChange })),
    );
    expect(screen.getByTestId("code-diff")).toHaveTextContent("old→new");
    expect(screen.queryByTestId("side-frame")).toBeNull();
    expect(screen.queryByTestId("file-diff-rendered-alone")).toBeNull();
  });

  it("off Files: an SVG renders through the sandboxed frame, never as an image", () => {
    atWidth(1200);
    render(renderFileDiff(args("/repo/icon.svg", { sides: { ...sides(), before: "<svg/>" } })));
    expect(screen.getAllByTestId("side-frame").map((f) => f.textContent)).toEqual([
      "<svg/>",
      "new",
    ]);
    expect(screen.queryByTestId("side-image")).toBeNull();
    expect(screen.getByTestId("file-diff-rendered-alone")).toBeInTheDocument();
  });

  const scene = (n: number) => JSON.stringify({ type: "excalidraw", elements: [], n });
  it("off Files: Excalidraw's sides are read-only scenes from their text", () => {
    atWidth(1200);
    render(
      renderFileDiff(args("/repo/d.excalidraw", { sides: { before: scene(1), after: scene(2) } })),
    );
    const canvases = screen.getAllByTestId("excalidraw");
    expect(canvases.map((c) => c.dataset.scene)).toEqual([scene(1), scene(2)]);
    expect(canvases.every((c) => c.dataset.readonly === "true")).toBe(true);
    expect(screen.queryByTestId("file-diff-rendered-alone")).toBeNull();
  });

  it("off Files: an Excalidraw side that won't parse says so instead of drawing a blank scene", () => {
    atWidth(1200);
    render(
      renderFileDiff(
        args("/repo/d.excalidraw", { sides: { before: scene(1), after: '{"type":"excal' } }),
      ),
    );
    expect(screen.getAllByTestId("excalidraw")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read this side's drawing");
  });

  it("off Files: a raster image renders from the bytes the surface holds", () => {
    atWidth(1200);
    render(
      renderFileDiff(
        args("/repo/logo.png", {
          sides: { before: "", after: "", status: "added", imageBytes: { after: "iVBO" } },
          state: { kind: "binary" },
        }),
      ),
    );
    expect(screen.getAllByTestId("side-image").map((i) => i.textContent)).toEqual(["iVBO"]);
    expect(screen.getByTestId("file-diff-one-side")).toHaveTextContent("After");
  });

  it("off Files: a raster image missing a side's bytes stays the binary affordance", () => {
    atWidth(1200);
    render(
      renderFileDiff(
        args(
          "/repo/logo.png",
          {
            sides: { before: "", after: "", status: "modified", imageBytes: { after: "iVBO" } },
            state: { kind: "binary" },
          },
          { binary: <p>binary here</p> },
        ),
      ),
    );
    // Source only, in the one image line: no side is drawn from half the bytes.
    expect(screen.getByTestId("file-diff-image-source")).toHaveTextContent(
      "An image has no text diff.",
    );
    expect(screen.queryByText("binary here")).toBeNull();
    expect(screen.queryByTestId("side-image")).toBeNull();
  });

  it("off Files: a binary image with no bytes says an image has no text diff", () => {
    render(
      renderFileDiff(
        args("/repo/logo.png", { state: { kind: "binary" } }, { binary: <p>binary here</p> }),
      ),
    );
    expect(screen.getByTestId("file-diff-image-source")).toBeInTheDocument();
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

describe("renderFileDiff — frame-level layout state", () => {
  it("below 900 px the Before | After toggle sits in the strip as a labelled group", () => {
    atWidth(899);
    render(
      renderFileDiff(
        args("/ctx/a.md", { modes: { markdown: "side-by-side" } }, { onModeChange: vi.fn() }),
      ),
    );
    const strip = screen.getByTestId("file-diff-strip");
    const sides = within(strip).getByRole("group", { name: "Side shown" });
    expect(within(sides).getByRole("button", { name: "After" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // No second chrome row under the strip.
    expect(screen.queryByTestId("file-diff-toggle")).toBeNull();
  });

  it("a host without a mode switch still gets the side toggle when narrow", () => {
    atWidth(899);
    render(renderFileDiff(args("/ctx/a.md", { modes: { markdown: "side-by-side" } })));
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getAllByTestId("rendered-md").map((p) => p.textContent)).toEqual(["old"]);
  });

  it("waits for the measured width instead of mounting the code diff twice", () => {
    atWidth(1200);
    codeDiffMounts.length = 0;
    render(renderFileDiff(args("/repo/a.ts")));
    expect(screen.getByTestId("code-diff")).toHaveAttribute("data-mode", "split");
    // Never first rendered inline at an unknown width.
    expect(codeDiffMounts).not.toContain("inline");
  });

  it("the large-diff opt-in survives a mode switch on the same file", () => {
    const big = "x".repeat(LARGE_DIFF_CHARS);
    const props = (markdown: "redline" | "source") =>
      args("/ctx/a.md", { sides: { ...sides(), before: big }, modes: { markdown } });
    const { rerender } = render(renderFileDiff(props("redline")));
    fireEvent.click(screen.getByTestId("file-diff-show-anyway"));
    rerender(renderFileDiff(props("source")));
    expect(screen.queryByTestId("file-diff-large-gate")).toBeNull();
    expect(screen.getByTestId("code-diff")).toBeInTheDocument();
  });
});

describe("renderFileDiff — the code mode switch only where it applies", () => {
  it("is not drawn over a binary body", () => {
    render(
      renderFileDiff(args("/repo/a.ts", { state: { kind: "binary" } }, { onModeChange: vi.fn() })),
    );
    expect(screen.queryByRole("button", { name: "Structural" })).toBeNull();
  });

  it("disables Structural for a language without a parse tree", () => {
    render(renderFileDiff(args("/repo/main.rs", {}, { onModeChange: vi.fn() })));
    expect(screen.getByRole("button", { name: "Structural" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ignore whitespace" })).toBeEnabled();
  });

  it("keeps Structural for a supported language", () => {
    render(renderFileDiff(args("/repo/a.ts", {}, { onModeChange: vi.fn() })));
    expect(screen.getByRole("button", { name: "Structural" })).toBeEnabled();
  });
});

describe("renderFileDiff — the switches and the skeleton (critique D3, D4, D9)", () => {
  it("the pressed segment uses the primary pair, and each segment draws its focus ring inside the group", () => {
    atWidth(899);
    render(
      renderFileDiff(
        args("/repo/page.html", { modes: { html: "side-by-side" } }, { onModeChange: vi.fn() }),
      ),
    );
    for (const group of [
      screen.getByTestId("file-diff-mode-switch"),
      screen.getByRole("group", { name: "Side shown" }),
    ]) {
      const buttons = within(group).getAllByRole("button");
      const pressed = buttons.find((b) => b.getAttribute("aria-pressed") === "true")!;
      expect(pressed.className).toContain("bg-primary");
      expect(pressed.className).toContain("text-primary-foreground");
      expect(pressed.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
      // Important: the unlayered global :focus-visible sets outline-offset 2px, which beats a layered
      // utility, and the group's overflow-hidden then clips the ring away.
      for (const b of buttons)
        expect(b.className).toContain("focus-visible:!outline-offset-[-2px]");
    }
  });

  it("the loading skeleton pulses only where motion is welcome, and says it is loading", () => {
    render(renderFileDiff(args("/repo/a.ts", { state: { kind: "loading" } })));
    const skeleton = screen.getByTestId("file-diff-code-skeleton");
    expect(skeleton.className).toContain("motion-safe:animate-pulse");
    expect(skeleton.className).not.toMatch(/(^|\s)animate-pulse/);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the diff");
  });
});

describe("renderFileDiff — a raster image's states (critique D5, D6, D8)", () => {
  const png = (
    sides: Partial<FileDiffArgs["sides"]>,
    mode: "side-by-side" | "source" = "side-by-side",
  ) =>
    args(
      "/repo/logo.png",
      {
        sides: { before: "", after: "", status: "modified", ...sides },
        state: { kind: "binary" },
        modes: { html: mode },
      },
      { onModeChange: vi.fn(), binary: <p>surface binary note</p> },
    );

  it("while its bytes are read it says so, never the final binary state", () => {
    render(renderFileDiff(png({ imageState: { kind: "reading" } })));
    expect(screen.getByTestId("file-diff-code-skeleton")).toBeInTheDocument();
    expect(screen.getByText("Reading the image…")).toBeInTheDocument();
    expect(screen.queryByText("surface binary note")).toBeNull();
  });

  it("when it can't be drawn, Side by side stays in the switch, disabled with the reason", () => {
    render(
      renderFileDiff(
        png({
          imageState: { kind: "unavailable", reason: "Over the 8 MB limit for drawing here" },
        }),
      ),
    );
    const sideBySide = within(screen.getByTestId("file-diff-mode-switch")).getByRole("button", {
      name: "Side by side",
    });
    expect(sideBySide).toBeDisabled();
    expect(sideBySide).toHaveAttribute("title", "Over the 8 MB limit for drawing here");
    expect(screen.getByTestId("file-diff-image-source")).toHaveTextContent(
      "An image has no text diff. Over the 8 MB limit for drawing here.",
    );
  });

  it("a Side by side preference over an image that can't draw presses Source, as the body shows", () => {
    render(
      <FileDiffModeSwitch
        kind="html"
        mode="side-by-side"
        onChange={vi.fn()}
        testId="switch"
        unavailable={{ "side-by-side": IMAGE_UNAVAILABLE.failed }}
      />,
    );
    const group = screen.getByTestId("switch");
    expect(within(group).getByRole("button", { name: "Source" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Side by side" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // and it looks it: the pressed style follows what is shown, not the preference
    expect(within(group).getByRole("button", { name: "Source" }).className).toContain("bg-primary");
    expect(within(group).getByRole("button", { name: "Side by side" }).className).not.toContain(
      "bg-primary",
    );
  });

  it("while the diff is still loading it shows the reading skeleton, not the final Source line", () => {
    render(
      renderFileDiff(
        args(
          "/repo/logo.png",
          {
            sides: { before: "", after: "", status: "modified" },
            state: { kind: "loading" },
            modes: { html: "side-by-side" },
          },
          { onModeChange: vi.fn() },
        ),
      ),
    );
    expect(screen.getByTestId("file-diff-code-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("file-diff-image-source")).toBeNull();
  });

  it("a side that failed to read keeps Side by side disabled with the reason, and offers no code modes", () => {
    render(
      renderFileDiff(
        args(
          "/repo/logo.png",
          {
            sides: { before: "", after: "", status: "modified" },
            state: { kind: "error", message: "permission denied" },
            modes: { html: "side-by-side" },
          },
          { onModeChange: vi.fn() },
        ),
      ),
    );
    const group = screen.getByTestId("file-diff-mode-switch");
    const sideBySide = within(group).getByRole("button", { name: "Side by side" });
    expect(sideBySide).toBeDisabled();
    expect(sideBySide).toHaveAttribute("title", IMAGE_UNAVAILABLE.failed);
    for (const code of ["Line", "Ignore whitespace", "Structural"])
      expect(within(group).queryByRole("button", { name: code })).toBeNull();
    expect(screen.getByTestId("file-diff-image-source")).toHaveTextContent(
      `An image has no text diff. ${IMAGE_UNAVAILABLE.failed}.`,
    );
  });

  it("its Source mode is one image-aware line on every surface", () => {
    render(renderFileDiff(png({ imageBytes: { before: "QQ==", after: "Qg==" } }, "source")));
    expect(screen.getByTestId("file-diff-image-source")).toHaveTextContent(
      "An image has no text diff. Side by side compares it.",
    );
    expect(screen.queryByText("surface binary note")).toBeNull();
  });
});

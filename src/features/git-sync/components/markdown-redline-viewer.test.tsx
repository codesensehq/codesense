// SPDX-License-Identifier: MIT
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Root as HastRoot } from "hast";

const getFileRedlineMock = vi.fn();
vi.mock("../lib/file-redline-source", async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, getFileRedline: (...a: unknown[]) => getFileRedlineMock(...a) };
});

const parseToRedlineMock = vi.fn();
vi.mock("@/shared/lib/markdown-worker/client", () => ({
  parseToRedline: (before: string, after: string) => parseToRedlineMock(before, after),
}));

vi.mock("./rendered-markdown", () => ({
  RenderedMarkdown: ({ text }: { text: string }) => <div data-testid="rendered-md">{text}</div>,
}));

vi.mock("./changed-binary-affordance", () => ({
  ChangedBinaryAffordance: ({ status }: { status: string }) => (
    <div data-testid="cba">{status}</div>
  ),
}));

// Stub the heavy viewers: assert which side and source they receive.
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
vi.mock("@/features/dashboard/components/image-viewer", () => ({
  ImageViewer: ({ baselineSource }: { baselineSource?: unknown }) => (
    <div data-testid="image" data-baseline={baselineSource ? "yes" : "no"} />
  ),
}));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: ({ baselineSource }: { baselineSource?: unknown }) => (
    <div data-testid="html" data-baseline={baselineSource ? "yes" : "no"} />
  ),
}));
vi.mock("@/shared/components/code-editor", async (orig) => ({
  ...(await orig<typeof import("@/shared/components/code-editor")>()),
  CodeDiffReview: ({
    before,
    after,
    diffMode,
  }: {
    before: string;
    after: string;
    diffMode?: string;
  }) => (
    <div data-testid="code-diff" data-diff-mode={diffMode ?? "line"}>
      {before}→{after}
    </div>
  ),
}));

import { useViewerStore } from "@/shared/stores/viewer-store";
import { stubResizeObserver } from "@/test/resize-observer-stub";
import { MarkdownRedlineViewer } from "./markdown-redline-viewer";

function pHast(text: string): HastRoot {
  return {
    type: "root",
    children: [
      { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: text }] },
    ],
  };
}

const baseProps = {
  orgRoot: "/ctx",
  absPath: "/ctx/a.md",
  teamKey: "acme:default",
  navRepoPath: "/ctx",
};

describe("MarkdownRedlineViewer (SW-GS-3)", () => {
  beforeEach(() => {
    getFileRedlineMock.mockReset();
    parseToRedlineMock.mockReset();
    resetModes();
  });

  it("renders the worker redline output for a changed markdown file", async () => {
    getFileRedlineMock.mockResolvedValue({
      status: "modified",
      binary: false,
      before: "old",
      after: "new",
    });
    parseToRedlineMock.mockReturnValue({
      promise: Promise.resolve({ hast: pHast("redline-ok"), perf: {}, receiveAt: 0 }),
      cancel: vi.fn(),
    });

    render(<MarkdownRedlineViewer {...baseProps} />);

    expect(await screen.findByText("redline-ok")).toBeInTheDocument();
    // SW-GS-19/13: trailing prNumber + commitSha are undefined for working-tree.
    expect(getFileRedlineMock).toHaveBeenCalledWith(
      "/ctx",
      "a.md",
      undefined,
      undefined,
      undefined,
    );
    expect(parseToRedlineMock).toHaveBeenCalledWith("old", "new");
  });

  it("passes the pre-rename old path to the fetch so a moved doc diffs by old path (SW-GS-14)", async () => {
    getFileRedlineMock.mockResolvedValue({
      status: "modified",
      binary: false,
      before: "old",
      after: "new",
    });
    parseToRedlineMock.mockReturnValue({
      promise: Promise.resolve({ hast: pHast("redline-ok"), perf: {}, receiveAt: 0 }),
      cancel: vi.fn(),
    });

    render(<MarkdownRedlineViewer {...baseProps} absPath="/ctx/new.md" oldPath="old.md" />);

    expect(await screen.findByText("redline-ok")).toBeInTheDocument();
    // "before" is read from the old baseline path, "after" from the new path.
    expect(getFileRedlineMock).toHaveBeenCalledWith(
      "/ctx",
      "new.md",
      "old.md",
      undefined,
      undefined,
    );
  });

  it("shows the binary affordance when the backend flags binary", async () => {
    getFileRedlineMock.mockResolvedValue({
      status: "modified",
      binary: true,
      before: "",
      after: "",
    });

    render(<MarkdownRedlineViewer {...baseProps} absPath="/ctx/weird.md" />);

    expect(await screen.findByTestId("cba")).toHaveTextContent("modified");
    expect(parseToRedlineMock).not.toHaveBeenCalled();
  });
});

function resetModes() {
  const { defaultFileDiffMode: _mode, ...settings } = useViewerStore.getState().settings;
  void _mode;
  useViewerStore.setState({ settings });
}

function redline(status: "added" | "modified" | "deleted", before = "B", after = "A") {
  return { status, binary: false, before, after };
}

const teamContentPath = "/ctx/_team/default/content";

describe("Files diff: every type through the shared dispatch", () => {
  let ro: ReturnType<typeof stubResizeObserver> | null = null;
  beforeEach(() => {
    getFileRedlineMock.mockReset();
    resetModes();
  });
  afterEach(() => {
    ro?.restore();
    ro = null;
  });

  it("a changed .ts is a CodeDiffReview, never a markdown redline", async () => {
    getFileRedlineMock.mockResolvedValue(redline("modified", "a", "b"));
    render(<MarkdownRedlineViewer {...baseProps} absPath="/ctx/x.ts" />);
    expect(await screen.findByTestId("code-diff")).toHaveTextContent("a→b");
    expect(parseToRedlineMock).not.toHaveBeenCalled();
  });

  it("a changed HTML file shows Before and After side by side at 900 px", async () => {
    ro = stubResizeObserver(900);
    getFileRedlineMock.mockResolvedValue(redline("modified"));
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        absPath="/ctx/c.html"
        teamContentPath={teamContentPath}
      />,
    );
    await screen.findAllByTestId("html");
    expect(screen.getAllByTestId("html").map((f) => f.dataset.baseline)).toEqual(["yes", "no"]);
  });

  it("a modified image below 900 px shows the toggle, After (the working tree) first", async () => {
    ro = stubResizeObserver(899);
    getFileRedlineMock.mockResolvedValue(redline("modified"));
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        absPath="/ctx/a.png"
        teamContentPath={teamContentPath}
      />,
    );
    expect(await screen.findByTestId("image")).toHaveAttribute("data-baseline", "no");
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(screen.getByTestId("image")).toHaveAttribute("data-baseline", "yes");
  });

  it("a diff that can't be read says so instead of loading forever", async () => {
    getFileRedlineMock.mockImplementation(() =>
      Promise.reject(new Error("not a path inside the repo")),
    );
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        absPath="/ctx/a.png"
        teamContentPath={teamContentPath}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("not a path inside the repo");
  });

  it("an added file has no toggle and shows only the current version", async () => {
    getFileRedlineMock.mockResolvedValue(redline("added", "", "A"));
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        absPath="/ctx/a.png"
        teamContentPath={teamContentPath}
      />,
    );
    expect(await screen.findByTestId("image")).toHaveAttribute("data-baseline", "no");
    expect(screen.queryByRole("button", { name: "Before" })).not.toBeInTheDocument();
  });

  it("a deleted file has no toggle and shows only the baseline", async () => {
    getFileRedlineMock.mockResolvedValue(redline("deleted", "B", ""));
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        absPath="/ctx/a.png"
        teamContentPath={teamContentPath}
      />,
    );
    expect(await screen.findByTestId("image")).toHaveAttribute("data-baseline", "yes");
    expect(screen.queryByRole("button", { name: "After" })).not.toBeInTheDocument();
  });

  it("Excalidraw's before side is the baseline scene JSON, both sides read-only", async () => {
    ro = stubResizeObserver(899);
    getFileRedlineMock.mockResolvedValue(redline("modified", '{"baseline":1}', '{"current":1}'));
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        absPath="/ctx/a.excalidraw"
        teamContentPath={teamContentPath}
      />,
    );
    const after = await screen.findByTestId("excalidraw");
    expect(after).toHaveAttribute("data-scene", "DISK");
    expect(after).toHaveAttribute("data-readonly", "true");
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    const before = screen.getByTestId("excalidraw");
    expect(before).toHaveAttribute("data-scene", '{"baseline":1}');
    expect(before).toHaveAttribute("data-readonly", "true");
  });

  it("the mode switch writes the shared default", async () => {
    getFileRedlineMock.mockResolvedValue(redline("modified", "old", "new"));
    parseToRedlineMock.mockReturnValue({
      promise: Promise.resolve({ hast: pHast("redline-ok"), perf: {}, receiveAt: 0 }),
      cancel: vi.fn(),
    });
    render(<MarkdownRedlineViewer {...baseProps} />);
    await screen.findByText("redline-ok");
    fireEvent.click(
      within(screen.getByTestId("file-diff-mode-switch")).getByRole("button", { name: "Source" }),
    );
    expect(useViewerStore.getState().settings.defaultFileDiffMode?.markdown).toBe("source");
    expect(screen.getByTestId("code-diff")).toHaveTextContent("old→new");
  });
});

describe("Files diff header: labels and the Private row on every type and mode", () => {
  let ro: ReturnType<typeof stubResizeObserver> | null = null;
  beforeEach(() => {
    getFileRedlineMock.mockReset();
    parseToRedlineMock.mockReset();
    parseToRedlineMock.mockReturnValue({
      promise: Promise.resolve({ hast: pHast("redline-ok"), perf: {}, receiveAt: 0 }),
      cancel: vi.fn(),
    });
    resetModes();
  });
  afterEach(() => {
    ro?.restore();
    ro = null;
  });

  const labelled = {
    ...redline("modified", "old", "new"),
    beforeLabel: "main · aaaaaaa",
    afterLabel: "PR #7 · bbbbbbb",
  };

  it("a .ts in a PR shows its base and head labels above the code diff", async () => {
    getFileRedlineMock.mockResolvedValue(labelled);
    render(<MarkdownRedlineViewer {...baseProps} absPath="/ctx/x.ts" prNumber={7} />);
    await screen.findByTestId("code-diff");
    expect(screen.getByTestId("context-redline-labels")).toHaveTextContent(
      "main · aaaaaaaPR #7 · bbbbbbb",
    );
  });

  it("markdown in Source mode keeps its labels", async () => {
    useViewerStore.getState().setFileDiffMode("markdown", "source");
    getFileRedlineMock.mockResolvedValue(labelled);
    render(<MarkdownRedlineViewer {...baseProps} commitSha="bbbbbbb" />);
    await screen.findByTestId("code-diff");
    expect(screen.getByTestId("context-redline-labels")).toBeInTheDocument();
  });

  it("a private file shows the Private row on a code diff", async () => {
    getFileRedlineMock.mockResolvedValue(redline("modified", "a", "b"));
    render(
      <MarkdownRedlineViewer
        {...baseProps}
        orgRoot="/home/users/42/scratch"
        navRepoPath="/home/users/42/scratch"
        absPath="/home/users/42/scratch/orgs/acme/plans/content/secret.ts"
      />,
    );
    await screen.findByTestId("code-diff");
    expect(screen.getAllByText(/^Private ·/)).toHaveLength(2);
  });

  it("markdown side by side draws the labels once, not once per pane", async () => {
    ro = stubResizeObserver(1200);
    useViewerStore.getState().setFileDiffMode("markdown", "side-by-side");
    getFileRedlineMock.mockResolvedValue(labelled);
    render(<MarkdownRedlineViewer {...baseProps} />);
    expect(await screen.findAllByTestId("rendered-md")).toHaveLength(2);
    expect(screen.getAllByTestId("context-redline-labels")).toHaveLength(1);
  });

  it("scroll keys bind to the visible prose pane in side by side", async () => {
    ro = stubResizeObserver(1200);
    useViewerStore.getState().setFileDiffMode("markdown", "side-by-side");
    getFileRedlineMock.mockResolvedValue(labelled);
    render(<MarkdownRedlineViewer {...baseProps} />);
    const panes = await screen.findAllByTestId("rendered-md");
    // The After pane's scroll container is the one the keys move.
    expect(panes[1].closest("[data-scroll-keys]")).not.toBeNull();
    expect(panes[0].closest("[data-scroll-keys]")).toBeNull();
  });
});

// SPDX-License-Identifier: MIT
import { createElement, forwardRef, useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Rendered | Source toggle: a story doc or dashboard in a source worktree
// renders through the same viewer dispatch Files uses, and a save in Source
// reaches Rendered through its per-file refresh, without a remount.

const readFileMock = vi.fn();
vi.mock("@/tauri/commands", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  WORKTREE_WRITE_CONFLICT_PREFIX: "conflict:",
}));

// The leaf viewers are stubbed (their own suites cover rendering, mermaid
// included); each stub records its props and counts its mounts.
const viewer = vi.hoisted(() => ({
  mounts: 0,
  props: [] as Array<Record<string, unknown>>,
}));
function stubViewer(kind: string) {
  return function StubViewer(props: Record<string, unknown>) {
    viewer.props.push({ kind, ...props });
    useEffect(() => {
      viewer.mounts++;
    }, []);
    return createElement("div", {
      "data-testid": `stub-${kind}`,
      "data-path": String(props.filePath),
      "data-root": String(props.teamContentPath),
      "data-refresh": String(props.refreshKey),
    });
  };
}
vi.mock("@/features/dashboard/components/markdown-viewer", () => ({
  MarkdownViewer: stubViewer("markdown"),
}));
vi.mock("@/features/dashboard/components/html-viewer", () => ({
  HtmlViewer: stubViewer("html"),
}));
vi.mock("@/features/dashboard/components/excalidraw-viewer", () => ({
  ExcalidrawViewer: stubViewer("excalidraw"),
}));
vi.mock("@/features/dashboard/components/image-viewer", () => ({
  ImageViewer: stubViewer("image"),
}));
vi.mock("@/features/viewer/components/code-file-viewer", () => ({
  CodeFileViewer: stubViewer("code"),
}));

// CodeMirror is stubbed: a textarea over the buffer, ⌘S as a button.
vi.mock("@/shared/components/code-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/components/code-editor")>();
  const CodeEditor = forwardRef(function CodeEditor(
    props: {
      value: string;
      onChange: (v: string) => void;
      onSave: (v: string) => void;
      path: string;
    },
    _ref,
  ) {
    return createElement(
      "div",
      { "data-testid": "stub-editor", "data-path": props.path },
      createElement("textarea", {
        "aria-label": "buffer",
        value: props.value,
        onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
      }),
      createElement("button", { type: "button", onClick: () => props.onSave(props.value) }, "⌘S"),
    );
  });
  return { ...actual, CodeEditor, CodeMergeView: () => null };
});

import { WorktreeFilePane } from "./worktree-file-pane";
import type { WorktreeEditorBackend } from "../../lib/worktree-editor-backend";

const ROOT = "/Users/me/dev/acme-wt/feat-story";
const STORY = `${ROOT}/stories/epic/SV-1-story.md`;
const DASHBOARD = `${ROOT}/stories/epic/SV-1-story.html`;
const SOURCE_MD = `${ROOT}/src/notes.md`;

const MERMAID_DOC = "# Story\n\n```mermaid\ngraph TD; A-->B\n```\n";

function backend(write = vi.fn().mockResolvedValue(undefined)): WorktreeEditorBackend {
  return {
    location: "local",
    rootPath: ROOT,
    listFiles: vi.fn(),
    readHead: vi.fn().mockResolvedValue(null),
    write,
  };
}

function pane(path: string, b: WorktreeEditorBackend, changedNonce = 0) {
  const rel = path.slice(ROOT.length + 1);
  return createElement(WorktreeFilePane, {
    id: rel,
    file: { path, size: 64 },
    active: true,
    backend: b,
    changedNonce,
    restore: null,
    onPersistDraft: () => {},
    onStatus: () => {},
    registerApi: () => {},
    wrapOverride: null,
  });
}

beforeEach(() => {
  localStorage.clear();
  readFileMock.mockReset();
  viewer.mounts = 0;
  viewer.props = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WorktreeFilePane Rendered | Source", () => {
  it("shows a hydrated story doc rendered (mermaid included), and Source shows the editor on the same file", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    render(pane(STORY, backend()));

    const rendered = await screen.findByTestId("stub-markdown");
    expect(rendered.dataset.path).toBe(STORY);
    expect(rendered.dataset.root).toBe(ROOT);
    expect(screen.getByRole("radio", { name: "Rendered" })).toHaveAttribute("aria-checked", "true");
    // The editor isn't what the reader sees in Rendered.
    expect(screen.queryByTestId("stub-editor")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    const editor = await screen.findByTestId("stub-editor");
    expect(editor.dataset.path).toBe(STORY);
    expect(screen.getByLabelText("buffer")).toHaveValue(MERMAID_DOC);
    expect(screen.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
  });

  it("mounts a hydrated html dashboard in HtmlViewer with the worktree as the content root", async () => {
    readFileMock.mockResolvedValue("<!doctype html><p>board</p>");
    render(pane(DASHBOARD, backend()));

    const html = await screen.findByTestId("stub-html");
    expect(html.dataset.path).toBe(DASHBOARD);
    expect(html.dataset.root).toBe(ROOT);
    const props = viewer.props.find((p) => p.kind === "html");
    expect(props?.changedPaths).toBeInstanceOf(Set);
    expect((props?.changedPaths as Set<string>).has(DASHBOARD)).toBe(true);
  });

  it("opens markdown outside the hydrated paths in Source, and remembers the choice per file type and folder group", async () => {
    readFileMock.mockResolvedValue("# notes\n");
    const first = render(pane(SOURCE_MD, backend()));
    expect(await screen.findByTestId("stub-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-markdown")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
    expect(await screen.findByTestId("stub-markdown")).toBeInTheDocument();
    first.unmount();

    // The next markdown file outside the team context opens the way the last one was left.
    const second = render(pane(`${ROOT}/docs/other.md`, backend()));
    expect(await screen.findByTestId("stub-markdown")).toBeInTheDocument();
    second.unmount();

    // Flipping a story doc to Source doesn't carry to markdown outside the team context.
    const story = render(pane(STORY, backend()));
    await screen.findByTestId("stub-markdown");
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(await screen.findByTestId("stub-editor")).toBeInTheDocument();
    story.unmount();

    render(pane(`${ROOT}/docs/third.md`, backend()));
    expect(await screen.findByTestId("stub-markdown")).toBeInTheDocument();
  });

  it("a choice outside the team context doesn't carry to story docs", async () => {
    readFileMock.mockResolvedValue("# notes\n");
    const first = render(pane(`${ROOT}/docs/guide.md`, backend()));
    fireEvent.click(await screen.findByRole("radio", { name: "Rendered" }));
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    first.unmount();

    render(pane(STORY, backend()));
    expect(await screen.findByTestId("stub-markdown")).toBeInTheDocument();
  });

  it("opens an image anywhere in the worktree Rendered", async () => {
    readFileMock.mockResolvedValue("\u0089PNG\u0000\u0000");
    render(pane(`${ROOT}/src/assets/logo.png`, backend()));
    const image = await screen.findByTestId("stub-image");
    expect(image.dataset.path).toBe(`${ROOT}/src/assets/logo.png`);
    expect(screen.getByRole("radio", { name: "Rendered" })).toHaveAttribute("aria-checked", "true");
  });

  it("opens a canvas Rendered as its editor, and Source shows the version the canvas saved", async () => {
    const CANVAS = `${ROOT}/docs/flow.excalidraw`;
    const v1 = '{"type":"excalidraw","elements":[]}';
    const v2 = '{"type":"excalidraw","elements":[{"id":"a"}]}';
    readFileMock.mockResolvedValue(v1);
    const b = backend();
    const view = render(pane(CANVAS, b));

    const canvas = await screen.findByTestId("stub-excalidraw");
    expect(canvas.dataset.path).toBe(CANVAS);
    // Rendered is the canvas editor: not read-only, so its saves write the file.
    const props = viewer.props.find((p) => p.kind === "excalidraw");
    expect(props?.readOnly).toBeFalsy();

    // The canvas saves; the watcher reports the change.
    readFileMock.mockResolvedValue(v2);
    view.rerender(pane(CANVAS, b, 1));

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    await waitFor(() => expect(screen.getByLabelText("buffer")).toHaveValue(v2));
  });

  it("says Rendered shows the saved version while the buffer has unsaved edits", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    render(pane(STORY, backend()));
    await screen.findByTestId("stub-markdown");
    expect(screen.queryByText(/Showing the saved version/)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    fireEvent.change(await screen.findByLabelText("buffer"), {
      target: { value: `${MERMAID_DOC}\nUnsaved.\n` },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
    expect(screen.getByText(/Showing the saved version/)).toBeInTheDocument();
  });

  it("has no toggle for a code file", async () => {
    readFileMock.mockResolvedValue("fn main() {}\n");
    render(pane(`${ROOT}/src/main.rs`, backend()));
    expect(await screen.findByTestId("stub-editor")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("a save in Source updates Rendered through its changedPaths refresh, without a remount", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    const write = vi.fn().mockResolvedValue(undefined);
    render(pane(STORY, backend(write)));

    const before = await screen.findByTestId("stub-markdown");
    const keyBefore = Number(before.dataset.refresh);
    expect(viewer.mounts).toBe(1);

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    fireEvent.change(await screen.findByLabelText("buffer"), {
      target: { value: `${MERMAID_DOC}\nEdited.\n` },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "⌘S" }));
    });
    await waitFor(() => expect(write).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
    await waitFor(() =>
      expect(Number(screen.getByTestId("stub-markdown").dataset.refresh)).toBeGreaterThan(
        keyBefore,
      ),
    );
    const last = viewer.props.filter((p) => p.kind === "markdown").at(-1);
    expect((last?.changedPaths as Set<string>).has(STORY)).toBe(true);
    // The same viewer instance took the refresh.
    expect(viewer.mounts).toBe(1);
  });
});

// SPDX-License-Identifier: MIT
import { createElement, forwardRef, useEffect, useImperativeHandle } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Rendered | Source toggle: a story doc or dashboard in a source worktree
// renders through the same viewer dispatch Files uses, and a save in Source
// reaches Rendered through its per-file refresh, without a remount.

const readFileMock = vi.fn();
const writeBinaryWorktreeFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/tauri/commands", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeBinaryWorktreeFile: (...args: unknown[]) => writeBinaryWorktreeFileMock(...args),
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

// CodeMirror is stubbed: a textarea over the buffer, ⌘S as a button. Its
// handle records whether the editor was on screen when each call landed.
const editorCalls = vi.hoisted(() => [] as Array<{ call: string; visible: boolean }>);
vi.mock("@/shared/components/code-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/components/code-editor")>();
  const CodeEditor = forwardRef(function CodeEditor(
    props: {
      value: string;
      onChange: (v: string) => void;
      onSave: (v: string) => void;
      path: string;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => {
      const el = () =>
        document.querySelector(`[data-testid="stub-editor"][data-path="${props.path}"]`);
      const record = (call: string) => () =>
        editorCalls.push({ call, visible: el()?.closest("[hidden]") == null });
      return { revealLine: record("revealLine"), openSearch: record("openSearch"), focus() {} };
    });
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

import { WorktreeFilePane, type PaneApi, type PaneStatus } from "./worktree-file-pane";
import type { WorktreeEditorBackend } from "../../lib/worktree-editor-backend";
import { LOCAL_ABSENT_TOKEN, sha256Hex } from "../../lib/use-file-editor";
import type { CanvasWriter } from "@/features/dashboard/components/excalidraw-canvas";

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

/** The pane's latest status and handle, as the workbench chrome sees them. */
const chrome = vi.hoisted(() => ({
  status: null as PaneStatus | null,
  api: null as PaneApi | null,
}));

function pane(path: string, b: WorktreeEditorBackend, changedNonce = 0, size = 64) {
  const rel = path.slice(ROOT.length + 1);
  return createElement(WorktreeFilePane, {
    id: rel,
    file: { path, size },
    active: true,
    backend: b,
    changedNonce,
    restore: null,
    onPersistDraft: () => {},
    onStatus: (_id, status) => {
      chrome.status = status;
    },
    registerApi: (_id, api) => {
      chrome.api = api;
    },
    wrapOverride: null,
  });
}

/** The file has been read into the editor. */
async function settled() {
  await waitFor(() => expect(chrome.status?.kind).toBe("editable"));
}

function remoteBackend(text: string): WorktreeEditorBackend {
  return {
    ...backend(),
    location: "remote",
    remote: {
      readWithHash: vi.fn().mockResolvedValue({ content: text, hash: "h1" }),
      inspectHash: vi.fn().mockResolvedValue("h1"),
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  readFileMock.mockReset();
  writeBinaryWorktreeFileMock.mockClear();
  viewer.mounts = 0;
  viewer.props = [];
  editorCalls.length = 0;
  chrome.status = null;
  chrome.api = null;
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

  it("doesn't carry Source to the next image, which Source can't show", async () => {
    readFileMock.mockResolvedValue("\u0089PNG\u0000\u0000");
    const first = render(pane(`${ROOT}/src/assets/logo.png`, backend()));
    await screen.findByTestId("stub-image");
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    first.unmount();

    render(pane(`${ROOT}/src/assets/icon.png`, backend()));
    expect(await screen.findByTestId("stub-image")).toBeInTheDocument();
  });

  it("on a canvas, says to save or undo unsaved Source edits before drawing", async () => {
    const CANVAS = `${ROOT}/docs/flow.excalidraw`;
    readFileMock.mockResolvedValue('{"type":"excalidraw","elements":[]}');
    render(pane(CANVAS, backend()));
    await screen.findByTestId("stub-excalidraw");

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    fireEvent.change(await screen.findByLabelText("buffer"), {
      target: { value: '{"type":"excalidraw","elements":[{"id":"x"}]}' },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
    const note = screen.getByText(/save or undo them there before drawing/);
    // The bar truncates in a narrow pane; the full instruction stays on hover.
    expect(note).toHaveAttribute("title", note.textContent);
    expect(screen.queryByText(/⌘S to update/)).toBeNull();
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
  it("doesn't refresh Rendered when the first read lands", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    render(pane(STORY, backend()));
    await screen.findByTestId("stub-markdown");
    await settled();
    const keys = viewer.props.filter((p) => p.kind === "markdown").map((p) => p.refreshKey);
    expect(new Set(keys)).toEqual(new Set([0]));
  });

  it("shows only the chosen layer, and Source again when Rendered is picked back", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    render(pane(STORY, backend()));
    expect(await screen.findByTestId("stub-markdown")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(await screen.findByTestId("stub-editor")).toBeVisible();
    expect(screen.getByTestId("stub-markdown")).not.toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));
    expect(screen.getByTestId("stub-markdown")).toBeVisible();
    expect(screen.getByTestId("stub-editor")).not.toBeVisible();
  });

  it("locks the view to Source while a conflict is merged, even from Rendered", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    const b = backend();
    const view = render(pane(STORY, b));
    await screen.findByTestId("stub-markdown");
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    fireEvent.change(await screen.findByLabelText("buffer"), {
      target: { value: `${MERMAID_DOC}\nMine.\n` },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));

    // An agent rewrites the file under the unsaved edit; the user opens the merge.
    readFileMock.mockResolvedValue(`${MERMAID_DOC}\nTheirs.\n`);
    view.rerender(pane(STORY, b, 1));
    fireEvent.click(await screen.findByTestId("worktree-stale-resolve"));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByRole("radio", { name: "Rendered" })).toBeDisabled();
    expect(screen.getByTestId("stub-markdown")).not.toBeVisible();
  });

  it("has no toggle on a remote worktree, and says rendering needs a local one", async () => {
    render(pane(STORY, remoteBackend(MERMAID_DOC)));
    await settled();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByTestId("stub-markdown")).toBeNull();
    expect(screen.getByText(/needs a local worktree/)).toBeInTheDocument();
  });

  it("says nothing about rendering on a remote file it couldn't render anyway", async () => {
    render(pane(`${ROOT}/src/main.rs`, remoteBackend("fn main() {}\n")));
    await settled();
    expect(screen.queryByText(/needs a local worktree/)).toBeNull();
  });

  it("a search asked for from Rendered opens once Source is on screen", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    render(pane(STORY, backend()));
    await screen.findByTestId("stub-markdown");
    await settled();

    act(() => chrome.api?.openSearch());
    await waitFor(() => expect(editorCalls).toEqual([{ call: "openSearch", visible: true }]));
    expect(screen.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
  });

  it("a line jump from Rendered lands after Source is shown, not on the hidden editor", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    render(pane(STORY, backend()));
    await screen.findByTestId("stub-markdown");
    // The editor already exists, hidden under Rendered.
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    await screen.findByTestId("stub-editor");
    fireEvent.click(screen.getByRole("radio", { name: "Rendered" }));

    act(() => chrome.api?.revealLine(3));
    await waitFor(() => expect(editorCalls).toEqual([{ call: "revealLine", visible: true }]));
  });

  it("switches Rendered and Source from the keyboard shortcut, and names it on the toggle", async () => {
    readFileMock.mockResolvedValue(MERMAID_DOC);
    const first = render(pane(STORY, backend()));
    await screen.findByTestId("stub-markdown");
    expect(screen.getByRole("radiogroup", { name: "File view" })).toHaveAttribute(
      "title",
      expect.stringContaining("⇧⌘V"),
    );

    act(() => chrome.api?.toggleView());
    expect(await screen.findByTestId("stub-editor")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
    first.unmount();

    // Remembered like a click.
    render(pane(`${ROOT}/stories/epic/SV-2-story.md`, backend()));
    expect(await screen.findByTestId("stub-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-markdown")).toBeNull();
  });

  describe("⇧⌘V inside a rendered html frame", () => {
    const VIEW_CHORD = {
      key: "V",
      code: "KeyV",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    };
    type FrameShortcut = (
      key: typeof VIEW_CHORD,
      editorTarget: boolean,
      textFieldTarget: boolean,
    ) => boolean;
    const frameShortcutFor = (path: string) =>
      viewer.props.filter((p) => p.kind === "html" && p.filePath === path).at(-1)
        ?.onFrameShortcut as FrameShortcut | undefined;

    it("the frame's forwarded chord switches its pane to Source", async () => {
      readFileMock.mockResolvedValue("<!doctype html><p>board</p>");
      render(pane(DASHBOARD, backend()));
      await screen.findByTestId("stub-html");

      let claimed = false;
      act(() => {
        claimed = frameShortcutFor(DASHBOARD)!(VIEW_CHORD, false, false);
      });
      expect(claimed).toBe(true);
      expect(await screen.findByTestId("stub-editor")).toBeVisible();
      expect(screen.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
    });

    it("leaves the chord to a text field in the page, and to any other chord", async () => {
      readFileMock.mockResolvedValue("<!doctype html><p>board</p>");
      render(pane(DASHBOARD, backend()));
      await screen.findByTestId("stub-html");
      const onFrameShortcut = frameShortcutFor(DASHBOARD)!;

      expect(onFrameShortcut(VIEW_CHORD, false, true)).toBe(false);
      expect(onFrameShortcut(VIEW_CHORD, true, false)).toBe(false);
      expect(onFrameShortcut({ ...VIEW_CHORD, shiftKey: false }, false, false)).toBe(false);
      expect(screen.getByRole("radio", { name: "Rendered" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    it("with two panes, only the pane that owns the frame flips", async () => {
      const OTHER = `${ROOT}/stories/epic/SV-2-story.html`;
      readFileMock.mockResolvedValue("<!doctype html><p>board</p>");
      render(
        createElement(
          "div",
          null,
          createElement("section", { "data-testid": "a" }, pane(DASHBOARD, backend())),
          createElement("section", { "data-testid": "b" }, pane(OTHER, backend())),
        ),
      );
      await waitFor(() => expect(screen.getAllByTestId("stub-html")).toHaveLength(2));

      act(() => {
        frameShortcutFor(OTHER)!(VIEW_CHORD, false, false);
      });
      const a = within(screen.getByTestId("a"));
      const b = within(screen.getByTestId("b"));
      expect(await b.findByTestId("stub-editor")).toBeVisible();
      expect(b.getByRole("radio", { name: "Source" })).toHaveAttribute("aria-checked", "true");
      expect(a.getByRole("radio", { name: "Rendered" })).toHaveAttribute("aria-checked", "true");
      expect(a.queryByTestId("stub-editor")).toBeNull();
    });
  });

  it("a canvas drawn in Rendered saves through the worktree writer, locked to the base it names, PNG included", async () => {
    const CANVAS = `${ROOT}/docs/flow.excalidraw`;
    const v1 = '{"type":"excalidraw","elements":[]}';
    const v2 = '{"type":"excalidraw","elements":[{"id":"a"}]}';
    readFileMock.mockResolvedValue(v1);
    const write = vi.fn().mockResolvedValue(undefined);
    render(pane(CANVAS, backend(write)));
    await screen.findByTestId("stub-excalidraw");
    await settled();

    const writer = viewer.props.filter((p) => p.kind === "excalidraw").at(-1)?.writer as
      | CanvasWriter
      | undefined;
    expect(writer).toBeDefined();
    await writer!.writeText(CANVAS, v2, v1);
    expect(write).toHaveBeenLastCalledWith(CANVAS, v2, await sha256Hex(v1));
    // No base: the canvas drew over a file that wasn't there.
    await writer!.writeText(CANVAS, v2, null);
    expect(write).toHaveBeenLastCalledWith(CANVAS, v2, LOCAL_ABSENT_TOKEN);

    await writer!.writeBinary(`${CANVAS}.png`, "AQID");
    expect(writeBinaryWorktreeFileMock).toHaveBeenCalledWith(`${CANVAS}.png`, "AQID");
  });
  it("a canvas too large for the editor saves from Rendered, locked to the base the canvas names", async () => {
    const CANVAS = `${ROOT}/docs/screenshots.excalidraw`;
    const v1 = '{"type":"excalidraw","elements":[],"files":{"big":"..."}}';
    const v2 = '{"type":"excalidraw","elements":[{"id":"a"}],"files":{"big":"..."}}';
    const write = vi.fn().mockResolvedValue(undefined);
    render(pane(CANVAS, backend(write), 0, 2_000_000));
    await screen.findByTestId("stub-excalidraw");
    // The editor holds no text for it: Source is a placeholder.
    await waitFor(() => expect(chrome.status?.kind).toBe("placeholder"));

    const writer = viewer.props.filter((p) => p.kind === "excalidraw").at(-1)?.writer as
      | CanvasWriter
      | undefined;
    await writer!.writeText(CANVAS, v2, v1);
    expect(write).toHaveBeenLastCalledWith(CANVAS, v2, await sha256Hex(v1));
  });
});

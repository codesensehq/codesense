// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

import { fileContentCache } from "@/shared/lib/file-content-cache";
import { fileViewKey } from "@/shared/lib/view-snapshot";
import { useViewerStore } from "@/shared/stores/viewer-store";

// Stub the CM6 editor to a controlled textarea so the wrapper's read / guard /
// read-only wiring is the subject under test. CM internals live in the
// code-editor suites. The handle exposes `scrollEl`, standing in for CM's scroller.
// `withhold` holds the handle back until `release()` runs, like CM's lazy chunk
// landing after the file read.
const scroll = vi.hoisted(() => ({
  el: null as HTMLElement | null,
  withhold: false,
  release: null as (() => void) | null,
}));
vi.mock("@/shared/components/code-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/components/code-editor")>();
  return {
    ...actual,
    CodeEditor: forwardRef(function MockCodeEditor(
      {
        value,
        path,
        readOnly,
        ariaLabel,
        language,
      }: {
        value: string;
        path?: string;
        readOnly?: boolean;
        ariaLabel?: string;
        language?: string;
      },
      ref: React.Ref<{ getScrollElement: () => HTMLElement | null }>,
    ) {
      const [handleReady, setHandleReady] = useState(!scroll.withhold);
      useEffect(() => {
        scroll.release = () => setHandleReady(true);
        return () => {
          scroll.release = null;
        };
      }, []);
      useImperativeHandle(
        ref,
        () => (handleReady ? { getScrollElement: () => scroll.el } : null) as never,
        [handleReady],
      );
      return (
        <div
          data-testid="mock-code-editor"
          data-path={path}
          data-readonly={String(readOnly)}
          data-aria={ariaLabel}
          data-language={language}
        >
          <textarea data-testid="editor-value" readOnly value={value} />
        </div>
      );
    }),
  };
});

const readFileMock = vi.fn<(p: string) => Promise<string>>();
vi.mock("@/tauri/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tauri/commands")>()),
  readFile: (p: string) => readFileMock(p),
}));

import { CodeFileViewer } from "./code-file-viewer";

const TEAM = "/team/content";

beforeEach(() => {
  readFileMock.mockReset();
  fileContentCache.clear();
  scroll.el = document.createElement("div");
  scroll.withhold = false;
  scroll.release = null;
  useViewerStore.setState({ viewStateByKey: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CodeFileViewer (SW-VE-2)", () => {
  it("AC-1/AC-4: renders content read-only in the CM6 editor with the file path", async () => {
    readFileMock.mockResolvedValue("key: value\n");
    render(<CodeFileViewer filePath="/team/content/config.yaml" teamContentPath={TEAM} />);

    await waitFor(() =>
      expect((screen.getByTestId("editor-value") as HTMLTextAreaElement).value).toBe(
        "key: value\n",
      ),
    );
    const editor = screen.getByTestId("mock-code-editor");
    expect(editor.getAttribute("data-path")).toBe("/team/content/config.yaml");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(editor.getAttribute("data-language")).toBe("yaml");
    expect(readFileMock).toHaveBeenCalledWith("/team/content/config.yaml");
  });

  it("AC-3: an extensionless shebang script highlights as shell once content lands", async () => {
    readFileMock.mockResolvedValue("#!/bin/bash\necho hi\n");
    render(<CodeFileViewer filePath="/team/content/deploy" teamContentPath={TEAM} />);

    // Language resolves from the shebang (path has no extension) after the read,
    // not "plain" — proves the wrapper passes a content-derived language.
    await waitFor(() =>
      expect(screen.getByTestId("mock-code-editor").getAttribute("data-language")).toBe("shell"),
    );
  });

  it("AC-5: gates a binary file (NUL byte) to the no-preview placeholder — never CM6", async () => {
    readFileMock.mockResolvedValue("PK\x03\x04\0\0binary");
    render(<CodeFileViewer filePath="/team/content/archive.bin" teamContentPath={TEAM} />);

    await waitFor(() => expect(screen.getByTestId("code-view-binary")).toBeInTheDocument());
    expect(screen.getByText("Binary file — no preview")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("AC-5: gates an oversized file to the too-large placeholder", async () => {
    readFileMock.mockResolvedValue("x".repeat(1_500_001));
    render(<CodeFileViewer filePath="/team/content/huge.json" teamContentPath={TEAM} />);

    await waitFor(() => expect(screen.getByTestId("code-view-too-large")).toBeInTheDocument());
    expect(screen.getByText("File too large to view")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("surfaces a read error as a placeholder, not a crash", async () => {
    readFileMock.mockRejectedValue(new Error("EACCES"));
    render(<CodeFileViewer filePath="/team/content/secret.env" teamContentPath={TEAM} />);

    await waitFor(() => expect(screen.getByTestId("code-view-error")).toBeInTheDocument());
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("SW-VE-4: a deleted file (ENOENT) self-heals to the 'was removed' state, not a generic error", async () => {
    readFileMock.mockRejectedValue(new Error("No such file or directory (os error 2)"));
    render(<CodeFileViewer filePath="/team/content/gone.yaml" teamContentPath={TEAM} />);

    await waitFor(() =>
      expect(screen.getByText("This file was removed from disk")).toBeInTheDocument(),
    );
    // The generic "Couldn't read file" error is NOT used for a deletion.
    expect(screen.queryByTestId("code-view-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-code-editor")).not.toBeInTheDocument();
  });

  it("serves fresh-refreshKey cached content without a re-read", async () => {
    fileContentCache.set("/team/content/a.ts", "cached body", 3);
    render(<CodeFileViewer filePath="/team/content/a.ts" teamContentPath={TEAM} refreshKey={3} />);

    await waitFor(() =>
      expect((screen.getByTestId("editor-value") as HTMLTextAreaElement).value).toBe("cached body"),
    );
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

it.each(["/team/content/a.ts", "/team/content", null])(
  "refreshes a code file after a relevant change at %s",
  async (changed) => {
    const path = "/team/content/a.ts";
    readFileMock.mockResolvedValue("first version");
    const { rerender } = render(
      <CodeFileViewer filePath={path} teamContentPath={TEAM} refreshKey={1} changedPaths={null} />,
    );
    await waitFor(() => expect(screen.getByTestId("editor-value")).toHaveValue("first version"));
    readFileMock.mockResolvedValue("second version");
    await act(async () => {
      rerender(
        <CodeFileViewer
          filePath={path}
          teamContentPath={TEAM}
          refreshKey={2}
          changedPaths={changed === null ? null : new Set([changed])}
        />,
      );
    });
    await waitFor(() => expect(screen.getByTestId("editor-value")).toHaveValue("second version"));
    expect(readFileMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      rerender(
        <CodeFileViewer
          filePath={path}
          teamContentPath={TEAM}
          refreshKey={3}
          changedPaths={new Set(["/team/content/other.ts", "/team/conten"])}
        />,
      );
    });
    expect(readFileMock).toHaveBeenCalledTimes(2);
  },
);

describe("CodeFileViewer scroll position across tab switches", () => {
  const path = "/team/content/a.ts";
  const KEY = fileViewKey("acme:default", path);
  type Observer = { cb: ResizeObserverCallback; target: Element | null };
  let observers: Observer[];

  beforeEach(() => {
    observers = [];
    class StubResizeObserver {
      private readonly record: Observer;
      constructor(cb: ResizeObserverCallback) {
        this.record = { cb, target: null };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.target = target;
      }
      unobserve() {}
      disconnect() {
        observers = observers.filter((o) => o !== this.record);
      }
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    readFileMock.mockResolvedValue("line\n".repeat(500));
  });

  function resize(width: number, height: number) {
    act(() => {
      for (const { cb, target } of observers) {
        cb(
          [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
    });
  }

  function scrollTo(top: number) {
    scroll.el!.scrollTop = top;
    scroll.el!.dispatchEvent(new Event("scroll"));
  }

  async function renderReady(viewStateKey?: string) {
    const utils = render(
      <CodeFileViewer filePath={path} teamContentPath={TEAM} viewStateKey={viewStateKey} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("editor-value")).toHaveValue("line\n".repeat(500)),
    );
    return utils;
  }

  it("puts the scroll position back when the tab is shown again", async () => {
    await renderReady(KEY);
    resize(400, 100);
    scrollTo(480);
    resize(0, 0);
    // A hidden box loses its scroll offset in the engine.
    scrollTo(0);
    resize(400, 100);
    expect(scroll.el!.scrollTop).toBe(480);
  });

  it("tracks the scroll when the editor handle arrives after the content", async () => {
    scroll.withhold = true;
    await renderReady(KEY);
    await act(async () => {
      scroll.release!();
    });
    resize(400, 100);
    scrollTo(480);
    resize(0, 0);
    scrollTo(0);
    resize(400, 100);
    expect(scroll.el!.scrollTop).toBe(480);
  });

  it("keeps the position across a second hide and show", async () => {
    await renderReady(KEY);
    resize(400, 100);
    scrollTo(480);
    for (let i = 0; i < 2; i += 1) {
      resize(0, 0);
      scrollTo(0);
      resize(400, 100);
      expect(scroll.el!.scrollTop).toBe(480);
    }
  });

  it("writes the tracked offset under the key on unmount", async () => {
    const { unmount } = await renderReady(KEY);
    scrollTo(480);
    unmount();
    expect(useViewerStore.getState().readViewState(KEY)).toEqual({ scrollTop: 480 });
  });

  it("stays inert without a viewStateKey", async () => {
    const { unmount } = await renderReady();
    scrollTo(480);
    resize(0, 0);
    scrollTo(0);
    resize(400, 100);
    expect(scroll.el!.scrollTop).toBe(0);
    unmount();
    expect(useViewerStore.getState().viewStateByKey).toEqual({});
  });
});

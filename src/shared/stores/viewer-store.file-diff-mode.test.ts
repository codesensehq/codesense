// SPDX-License-Identifier: MIT
/**
 * One `defaultFileDiffMode` setting per type: a mode switch on any diff surface
 * writes it, so the next diff on every surface opens in that mode. The source
 * diff's per-session code mode starts from it and writes back to it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useFileDiffModes } from "@/shared/hooks/use-file-diff-modes";
import { DEFAULT_FILE_DIFF_MODES, resolveFileDiffModes } from "@/shared/lib/file-diff-mode";
import { sourceDiffModeFor, useViewerStore } from "./viewer-store";

function resetSetting() {
  const { defaultFileDiffMode: _drop, ...rest } = useViewerStore.getState().settings;
  void _drop;
  useViewerStore.setState({ settings: rest, sourceDiffMode: {} });
}

describe("resolveFileDiffModes", () => {
  it("fills missing types with the defaults", () => {
    expect(resolveFileDiffModes(undefined)).toEqual(DEFAULT_FILE_DIFF_MODES);
    expect(resolveFileDiffModes({ markdown: "source" })).toEqual({
      ...DEFAULT_FILE_DIFF_MODES,
      markdown: "source",
    });
  });

  it("fails safe on unknown or corrupted values", () => {
    expect(
      resolveFileDiffModes({ markdown: "toggle", html: 3, code: "semantic" } as never),
    ).toEqual({ markdown: "redline", html: "side-by-side", code: "line" });
    expect(resolveFileDiffModes("nonsense" as never)).toEqual(DEFAULT_FILE_DIFF_MODES);
  });
});

describe("defaultFileDiffMode setting", () => {
  beforeEach(resetSetting);

  it("a switch on one surface changes the default every surface reads", () => {
    const files = renderHook(() => useFileDiffModes());
    const openDiff = renderHook(() => useFileDiffModes());
    expect(openDiff.result.current.modes.markdown).toBe("redline");

    act(() => files.result.current.setMode("markdown", "side-by-side"));

    expect(openDiff.result.current.modes.markdown).toBe("side-by-side");
    expect(useViewerStore.getState().settings.defaultFileDiffMode).toEqual({
      ...DEFAULT_FILE_DIFF_MODES,
      markdown: "side-by-side",
    });
  });

  it("a code mode chosen elsewhere seeds a source diff session with no choice of its own", () => {
    renderHook(() => useFileDiffModes()).result.current.setMode("code", "structural");
    expect(sourceDiffModeFor(useViewerStore.getState(), "tab-1")).toBe("structural");
  });

  it("a code mode change in the source diff writes the session and the default", () => {
    act(() => useViewerStore.getState().setSourceDiffMode("tab-1", "ignoreWhitespace"));
    const s = useViewerStore.getState();
    expect(s.sourceDiffMode["tab-1"]).toBe("ignoreWhitespace");
    expect(resolveFileDiffModes(s.settings.defaultFileDiffMode).code).toBe("ignoreWhitespace");
    // Another surface now opens code diffs in that mode.
    expect(renderHook(() => useFileDiffModes()).result.current.modes.code).toBe("ignoreWhitespace");
  });

  it("a session's own choice still wins over a later default", () => {
    act(() => useViewerStore.getState().setSourceDiffMode("tab-1", "structural"));
    act(() => useViewerStore.getState().setFileDiffMode("code", "line"));
    expect(sourceDiffModeFor(useViewerStore.getState(), "tab-1")).toBe("structural");
    expect(sourceDiffModeFor(useViewerStore.getState(), "tab-2")).toBe("line");
  });

  it("opening a session snapshots the default; a later default leaves it alone", () => {
    act(() => useViewerStore.getState().setFileDiffMode("code", "structural"));
    act(() => useViewerStore.getState().seedSourceDiffMode("tab-1"));
    expect(useViewerStore.getState().sourceDiffMode["tab-1"]).toBe("structural");
    act(() => useViewerStore.getState().setFileDiffMode("code", "line"));
    expect(sourceDiffModeFor(useViewerStore.getState(), "tab-1")).toBe("structural");
    // Seeding again never overwrites the session's own mode.
    act(() => useViewerStore.getState().seedSourceDiffMode("tab-1"));
    expect(useViewerStore.getState().sourceDiffMode["tab-1"]).toBe("structural");
  });
});

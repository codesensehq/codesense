// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";

import {
  initialViewMode,
  isViewToggleChord,
  rememberViewMode,
  renderable,
  renderableType,
} from "./worktree-view-mode";

beforeEach(() => {
  localStorage.clear();
});

describe("worktree view mode", () => {
  // [path, hydrated, renders, opens in]
  it.each([
    ["stories/epic/SV-1.md", true, true, "rendered"],
    ["src/notes.md", false, true, "source"],
    ["stories/epic/SV-1.html", true, true, "rendered"],
    // Repo html never renders, wherever it sits: an unhydrated page under
    // stories/ is the repo's (or an agent's), not the team's.
    ["stories/x.html", false, false, "source"],
    ["design/page.html", false, false, "source"],
    ["design/shot.png", false, true, "rendered"],
    ["design/shot.png", true, true, "rendered"],
    ["docs/flow.excalidraw", false, true, "rendered"],
    ["design/board.excalidraw", true, true, "rendered"],
    ["src/main.ts", false, false, "source"],
    ["stories/epic/notes.ts", true, false, "source"],
  ] as const)("%s (hydrated: %s) renders: %s, opens in %s", (path, hydrated, renders, mode) => {
    const type = renderableType(path);
    expect(type != null && renderable(type, hydrated)).toBe(renders);
    expect(initialViewMode(path, hydrated)).toBe(mode);
  });

  it("remembers a choice per file type and per hydrated or repo group", () => {
    rememberViewMode("stories/a.md", true, "source");
    expect(initialViewMode("stories/b.md", true)).toBe("source");
    // A README in the source tree keeps its own default.
    rememberViewMode("README.md", false, "rendered");
    expect(initialViewMode("src/notes.md", false)).toBe("rendered");
    expect(initialViewMode("design/c.md", true)).toBe("source");
  });

  it("never opens repo html Rendered, even after Rendered was remembered for html", () => {
    rememberViewMode("stories/a.html", true, "rendered");
    rememberViewMode("stories/b.html", false, "rendered");
    expect(initialViewMode("stories/x.html", false)).toBe("source");
  });

  it("matches ⇧⌘V and ⇧⌃V only", () => {
    const v = { code: "KeyV", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
    expect(isViewToggleChord(v)).toBe(true);
    expect(isViewToggleChord({ ...v, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isViewToggleChord({ ...v, shiftKey: false })).toBe(false);
    expect(isViewToggleChord({ ...v, altKey: true })).toBe(false);
    expect(isViewToggleChord({ ...v, code: "KeyC" })).toBe(false);
  });
});

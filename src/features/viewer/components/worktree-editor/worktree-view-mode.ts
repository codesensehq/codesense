// SPDX-License-Identifier: MIT
import { getViewerFileType, type ViewerFileType } from "@/shared/lib/viewer-file-type";

/** How a renderable worktree file is shown: through the viewer, or as text. */
export type WorktreeViewMode = "rendered" | "source";

/** The file types the viewer renders; everything else is source only. */
const RENDERABLE: ReadonlySet<ViewerFileType> = new Set([
  "markdown",
  "html",
  "image",
  "excalidraw",
]);

/** Top-level folders that hydrated team context lands in inside a worktree:
 *  story docs and dashboards, design review artifacts, the team's README. */
const TEAM_CONTEXT_DIRS = ["stories/", "design/", "team-context/"];

const STORAGE_KEY = "codesense.worktree-editor.view-mode";

/** The viewer type of `path` when the viewer can render it, else `null`. */
export function renderableType(path: string): ViewerFileType | null {
  const type = getViewerFileType(path);
  return RENDERABLE.has(type) ? type : null;
}

function remembered(): Partial<Record<ViewerFileType, WorktreeViewMode>> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

/** The mode a file opens in: the last choice made for its type, else Rendered
 *  for markdown and html under the team context folders and Source otherwise. */
export function initialViewMode(path: string, rootPath: string): WorktreeViewMode {
  const type = renderableType(path);
  if (!type) return "source";
  const saved = remembered()[type];
  if (saved === "rendered" || saved === "source") return saved;
  if (type !== "markdown" && type !== "html") return "source";
  const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  const rel = path.startsWith(root) ? path.slice(root.length) : path;
  return TEAM_CONTEXT_DIRS.some((dir) => rel.startsWith(dir)) ? "rendered" : "source";
}

/** Remember `mode` as the one files of `path`'s type open in. */
export function rememberViewMode(path: string, mode: WorktreeViewMode): void {
  const type = renderableType(path);
  if (!type) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...remembered(), [type]: mode }));
  } catch {
    // Storage full or unavailable: the choice holds for this pane only.
  }
}

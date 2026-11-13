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

/** ⇧⌘V (⇧⌃V off the Mac): Rendered ⇄ Source, as VS Code's preview toggle. */
export function isViewToggleChord(key: {
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  return !!(key.metaKey || key.ctrlKey) && !!key.shiftKey && !key.altKey && key.code === "KeyV";
}

/** The viewer type of `path` when the viewer can render it, else `null`. */
export function renderableType(path: string): ViewerFileType | null {
  const type = getViewerFileType(path);
  return RENDERABLE.has(type) ? type : null;
}

/** Where a file sits: in the hydrated team context, or anywhere else. A choice
 *  made on a story doc doesn't carry to a README in the source tree. */
type FolderGroup = "team" | "other";

function folderGroup(path: string, rootPath: string): FolderGroup {
  const root = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  const rel = path.startsWith(root) ? path.slice(root.length) : path;
  return TEAM_CONTEXT_DIRS.some((dir) => rel.startsWith(dir)) ? "team" : "other";
}

/** The remembered-mode key: file type plus folder group. */
function memoryKey(type: ViewerFileType, path: string, rootPath: string): string {
  return `${type}:${folderGroup(path, rootPath)}`;
}

function remembered(): Record<string, WorktreeViewMode> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, WorktreeViewMode>) : {};
  } catch {
    return {};
  }
}

/** The mode a file opens in: the last choice made for its type in its folder
 *  group, else Rendered for images and canvases, and for markdown and html
 *  under the team context folders; Source otherwise. */
export function initialViewMode(path: string, rootPath: string): WorktreeViewMode {
  const type = renderableType(path);
  if (!type) return "source";
  const saved = remembered()[memoryKey(type, path, rootPath)];
  if (saved === "rendered" || saved === "source") return saved;
  if (type === "image" || type === "excalidraw") return "rendered";
  return folderGroup(path, rootPath) === "team" ? "rendered" : "source";
}

/** Remember `mode` as the one files of `path`'s type in its folder group open in. */
export function rememberViewMode(path: string, rootPath: string, mode: WorktreeViewMode): void {
  const type = renderableType(path);
  // Source can't show an image, so it's never what the next image opens in.
  if (!type || (type === "image" && mode === "source")) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...remembered(), [memoryKey(type, path, rootPath)]: mode }),
    );
  } catch {
    // Storage full or unavailable: the choice holds for this pane only.
  }
}

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

/** Whether the viewer renders a file of `type` here. Html runs as a page, so
 *  only a story file hydrated from the team's context renders; the repo's own
 *  pages (or one an agent wrote) stay source only. */
export function renderable(type: ViewerFileType, hydrated: boolean): boolean {
  return RENDERABLE.has(type) && (type !== "html" || hydrated);
}

/** Where a file comes from: the team's hydrated context, or the repo. A choice
 *  made on a story doc doesn't carry to a README in the source tree. */
type FolderGroup = "team" | "other";

function folderGroup(hydrated: boolean): FolderGroup {
  return hydrated ? "team" : "other";
}

/** The remembered-mode key: file type plus folder group. */
function memoryKey(type: ViewerFileType, hydrated: boolean): string {
  return `${type}:${folderGroup(hydrated)}`;
}

function remembered(): Record<string, WorktreeViewMode> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, WorktreeViewMode>) : {};
  } catch {
    return {};
  }
}

/** The mode a file opens in: Source when it doesn't render here; else the
 *  last choice made for its type in its folder group; else Rendered for images
 *  and canvases, and for hydrated markdown and html; Source otherwise. */
export function initialViewMode(path: string, hydrated: boolean): WorktreeViewMode {
  const type = renderableType(path);
  if (!type || !renderable(type, hydrated)) return "source";
  const saved = remembered()[memoryKey(type, hydrated)];
  if (saved === "rendered" || saved === "source") return saved;
  if (type === "image" || type === "excalidraw") return "rendered";
  return hydrated ? "rendered" : "source";
}

/** Remember `mode` as the one files of `path`'s type in its folder group open in. */
export function rememberViewMode(path: string, hydrated: boolean, mode: WorktreeViewMode): void {
  const type = renderableType(path);
  // Source can't show an image, so it's never what the next image opens in.
  if (!type || (type === "image" && mode === "source")) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...remembered(), [memoryKey(type, hydrated)]: mode }),
    );
  } catch {
    // Storage full or unavailable: the choice holds for this pane only.
  }
}

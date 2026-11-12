// SPDX-License-Identifier: MIT
/**
 * The per-type diff modes every file-diff surface shares. Markdown
 * reads as a redline, rendered side by side, or as source; HTML, image and
 * Excalidraw render side by side (on Files) or show source; code picks the
 * `CodeDiffReview` mode. The narrow-pane Before | After toggle is a layout
 * fallback for `side-by-side`, never a stored mode.
 */
export type MarkdownDiffMode = "redline" | "side-by-side" | "source";
export type RenderedDiffMode = "side-by-side" | "source";
export type CodeDiffMode = "line" | "ignoreWhitespace" | "structural";

export interface FileDiffModes {
  markdown: MarkdownDiffMode;
  /** HTML, image and Excalidraw. */
  html: RenderedDiffMode;
  code: CodeDiffMode;
}

export type FileDiffKind = keyof FileDiffModes;

export const DEFAULT_FILE_DIFF_MODES: Readonly<FileDiffModes> = {
  markdown: "redline",
  html: "side-by-side",
  code: "line",
};

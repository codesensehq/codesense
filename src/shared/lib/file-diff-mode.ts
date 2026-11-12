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

const ALLOWED: { [K in FileDiffKind]: readonly FileDiffModes[K][] } = {
  markdown: ["redline", "side-by-side", "source"],
  html: ["side-by-side", "source"],
  code: ["line", "ignoreWhitespace", "structural"],
};

function pick<K extends FileDiffKind>(raw: unknown, kind: K): FileDiffModes[K] {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[kind] : undefined;
  return (ALLOWED[kind] as readonly unknown[]).includes(value)
    ? (value as FileDiffModes[K])
    : DEFAULT_FILE_DIFF_MODES[kind];
}

/**
 * The effective modes from the persisted setting. Fail-safe like
 * `defaultSourceDiffInline`: a missing, unknown or corrupted value falls back to
 * that type's default, so a bad blob never opens every diff in an odd mode.
 */
export function resolveFileDiffModes(raw: Partial<FileDiffModes> | undefined): FileDiffModes {
  return { markdown: pick(raw, "markdown"), html: pick(raw, "html"), code: pick(raw, "code") };
}

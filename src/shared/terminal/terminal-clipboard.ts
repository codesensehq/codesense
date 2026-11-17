// SPDX-License-Identifier: MIT
import { logger } from "@/shared/lib/logger";

/**
 * Read the clipboard and paste into the terminal. `term.paste()` frames
 * bracketed paste per the terminal's own mode and routes through the gated
 * `onData` input seam — so an input-locked terminal (agent driving) drops the
 * paste like any other input, and we never write to the PTY directly. We pass
 * the raw text. Async read only (never the synchronous Electron clipboard,
 * which would block the renderer); `?.` tolerates an environment without the
 * Clipboard API.
 */
export async function pasteFromClipboard(target: { paste(data: string): void }): Promise<void> {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) target.paste(text);
  } catch (e) {
    // readText rejects when the document isn't focused or permission is denied;
    // a failed paste is a no-op, not a crash.
    logger.warn("terminal", `paste failed: ${e}`);
  }
}

/**
 * Write the terminal's selection to the clipboard. Nothing is written for an empty selection,
 * so a repaint that dropped it cannot clobber the clipboard. A missing Clipboard API is a
 * silent no-op; a refused write is logged.
 */
export async function copySelectionToClipboard(target: { getSelection(): string }): Promise<void> {
  const selection = target.getSelection();
  if (!selection) return;
  try {
    await navigator.clipboard?.writeText(selection);
  } catch (e) {
    logger.warn("terminal", `copy failed: ${e}`);
  }
}

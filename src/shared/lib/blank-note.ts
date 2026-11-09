// SPDX-License-Identifier: MIT
/** The title a note made without asking for one gets (Rust's `DEFAULT_SCRATCH_TITLE`). */
export const DEFAULT_NOTE_TITLE = "Note";
/** The title New note gives a note, and what the title field shows when it is empty. */
export const UNTITLED_NOTE_TITLE = "Untitled";

/** The titles a note has before anyone names it. */
export const BLANK_NOTE_TITLES = new Set(["", DEFAULT_NOTE_TITLE, UNTITLED_NOTE_TITLE]);

/** Unpinned, with a whitespace-only body and a title nobody chose: New note reuses
 *  such a note instead of making another. */
export function isBlankNote(note: { title: string; pinned: boolean }, content: string): boolean {
  return !note.pinned && content.trim() === "" && BLANK_NOTE_TITLES.has(note.title);
}

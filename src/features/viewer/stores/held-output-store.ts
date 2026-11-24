// SPDX-License-Identifier: MIT
import { useCallback, useEffect } from "react";
import { create } from "zustand";

/**
 * Lines of output each terminal tab's display took while it was parked (a chat covering the
 * tab), by tab `sessionId`. The tab's pane reports it from the terminal manager; the caption
 * reads it. Not persisted.
 */
export const useHeldOutputStore = create<{ bySession: Record<string, number | undefined> }>(() => ({
  bySession: {},
}));

function setHeld(sessionId: string, lines: number): void {
  useHeldOutputStore.setState((s) => {
    if ((s.bySession[sessionId] ?? 0) === lines) return s;
    return { bySession: { ...s.bySession, [sessionId]: lines > 0 ? lines : undefined } };
  });
}

/** Lines held back for `sessionId`'s display, 0 when none. */
export function useHeldLines(sessionId: string): number {
  return useHeldOutputStore((s) => s.bySession[sessionId] ?? 0);
}

/**
 * The callback a tab's terminal slot reports its held-line count to. It clears the tab's count
 * when the pane goes, so a closed tab leaves nothing behind.
 */
export function useHeldLinesReporter(sessionId: string): (lines: number) => void {
  useEffect(() => () => setHeld(sessionId, 0), [sessionId]);
  return useCallback((lines: number) => setHeld(sessionId, lines), [sessionId]);
}

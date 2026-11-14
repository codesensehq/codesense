// SPDX-License-Identifier: MIT
import { isRunningAgent } from "@/features/viewer/lib/hand-agents";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { create } from "zustand";

/** How a tab's inbox is drawn: conversations, a dense log, or a sequence diagram. */
export type InboxLens = "threads" | "spool" | "wire";

/** One session's rail state. Present → the rail is open on that session. */
export interface AgentInboxRailTarget {
  /** Bumped each time someone asks to write: the rail's composer takes focus. */
  composeRequest: number;
  groupRequest?: number;
  groupHandled?: number;
  /**
   * The last request the rail acted on. Kept here, not in the rail, so a remount (the tab
   * moved to another pane) never acts on an old request again.
   */
  composeHandled?: number;
}

interface AgentInboxRailState {
  /** Keyed by terminal `sessionId`. Kept for the app's lifetime only. */
  bySession: Record<string, AgentInboxRailTarget | undefined>;
  open: (sessionId: string, opts?: { compose?: boolean }) => void;
  close: (sessionId: string) => void;
  openGroup: (sessionId: string) => void;
  markGroupHandled: (sessionId: string, n: number) => void;
  /** Record that the rail on `sessionId` acted on compose request `n`. */
  markComposeHandled: (sessionId: string, n: number) => void;
}

let watchingEligibility = false;

/** Rails follow lifecycle even when their tab is hidden or its workspace is minimized. */
function watchEligibility(): void {
  if (watchingEligibility) return;
  watchingEligibility = true;
  useAgentStateStore.subscribe((agent) => {
    const { bySession } = useAgentInboxRailStore.getState();
    const ended = Object.keys(bySession).filter((id) => {
      if (!bySession[id] || isRunningAgent(agent, id)) return false;
      // A layout refresh or reconnect temporarily hides live controls. Remember
      // the open rail until current lifecycle evidence confirms the agent ended.
      const activity = agent.activityBySession[id];
      return !activity || activity.freshness === "current" || !!agent.exitBySession[id];
    });
    if (ended.length === 0) return;
    const next = { ...bySession };
    for (const id of ended) next[id] = undefined;
    useAgentInboxRailStore.setState({ bySession: next });
  });
}

/**
 * The per-terminal-tab agent inbox rail's state: which tabs are showing it, and
 * whether the composer was asked for. Not persisted — every tile boots with the
 * rail closed, same as the HUD and source-diff overlays.
 */
export const useAgentInboxRailStore = create<AgentInboxRailState>((set) => ({
  bySession: {},
  open: (sessionId, opts) =>
    set((s) => {
      if (!isRunningAgent(useAgentStateStore.getState(), sessionId)) return s;
      watchEligibility();
      const compose = opts?.compose === true;
      const cur = s.bySession[sessionId];
      const composeRequest = compose ? (cur?.composeRequest ?? 0) + 1 : (cur?.composeRequest ?? 0);
      if (cur && cur.composeRequest === composeRequest) return s;
      return { bySession: { ...s.bySession, [sessionId]: { ...cur, composeRequest } } };
    }),
  openGroup: (sessionId) =>
    set((s) => {
      if (!isRunningAgent(useAgentStateStore.getState(), sessionId)) return s;
      watchEligibility();
      const cur = s.bySession[sessionId];
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: { composeRequest: 0, ...cur, groupRequest: (cur?.groupRequest ?? 0) + 1 },
        },
      };
    }),
  markGroupHandled: (sessionId, n) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      return cur ? { bySession: { ...s.bySession, [sessionId]: { ...cur, groupHandled: n } } } : s;
    }),
  markComposeHandled: (sessionId, n) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur || (cur.composeHandled ?? 0) >= n) return s;
      return { bySession: { ...s.bySession, [sessionId]: { ...cur, composeHandled: n } } };
    }),
  close: (sessionId) =>
    set((s) =>
      s.bySession[sessionId] ? { bySession: { ...s.bySession, [sessionId]: undefined } } : s,
    ),
}));

/** Open the per-tab rail on `sessionId`, optionally with the composer focused. */
export function openAgentInboxRail(sessionId: string, opts?: { compose?: boolean }) {
  useAgentInboxRailStore.getState().open(sessionId, opts);
}

/** The last compose request the rail on `sessionId` acted on (0 when none). */
export function useAgentInboxRailComposeHandled(sessionId: string): number {
  return useAgentInboxRailStore((s) => s.bySession[sessionId]?.composeHandled ?? 0);
}

export function markAgentInboxRailComposeHandled(sessionId: string, n: number): void {
  useAgentInboxRailStore.getState().markComposeHandled(sessionId, n);
}

/** Close the per-tab rail on `sessionId`. */
export function closeAgentInboxRail(sessionId: string) {
  useAgentInboxRailStore.getState().close(sessionId);
}

/**
 * Close the chat on `sessionId`, then focus the terminal in `pane` (the tab's pane, if known).
 * A terminal the chat covered is inert until the chat is gone, so focus waits for the next frame.
 */
export function closeAgentInboxRailToTerminal(sessionId: string, pane: Element | null) {
  closeAgentInboxRail(sessionId);
  if (pane)
    requestAnimationFrame(() =>
      pane.querySelector<HTMLTextAreaElement>(".xterm textarea")?.focus(),
    );
}

// SPDX-License-Identifier: MIT
import { isRunningAgent, useRunningAgent } from "@/features/viewer/lib/hand-agents";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { create } from "zustand";

/** How a tab's inbox is drawn: conversations, a dense log, or a sequence diagram. */
export type InboxLens = "threads" | "spool" | "wire";

/**
 * One session's chat state. Present → the tab has a chat, mounted while its pane shows; `shown`
 * says whether it covers the tab or sits hidden behind the CLI.
 */
export interface AgentInboxRailTarget {
  /** The chat covers the tab. False: the person flipped to the CLI, and the chat waits hidden. */
  shown: boolean;
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
  /**
   * Tabs launched as an agent whose chat opens once the agent is eligible (a running agent
   * CLI). A one-shot mark: set by a first launch, never by a relaunch or a CLI started by hand.
   */
  pending: Record<string, true | undefined>;
  /** Mark a tab as launched as an agent: its chat covers it as soon as the agent runs. */
  markOpenedAsAgent: (sessionId: string) => void;
  /** Drop a pending mark (a failed launch). An open chat is left alone. */
  clearOpenedAsAgent: (sessionId: string) => void;
  /** Forget everything about a session: its open chat and its pending mark. */
  forget: (sessionId: string) => void;
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
    const { bySession, pending } = useAgentInboxRailStore.getState();
    const opened: string[] = [];
    const dropped: string[] = [];
    for (const id of Object.keys(pending)) {
      if (!pending[id]) continue;
      if (isRunningAgent(agent, id)) opened.push(id);
      // The process ended before the agent was ever eligible: the mark is spent.
      else if (agent.exitBySession[id]) dropped.push(id);
    }
    const ended = Object.keys(bySession).filter((id) => {
      if (!bySession[id] || isRunningAgent(agent, id)) return false;
      // A layout refresh or reconnect temporarily hides live controls. Remember
      // the open rail until current lifecycle evidence confirms the agent ended.
      const activity = agent.activityBySession[id];
      return !activity || activity.freshness === "current" || !!agent.exitBySession[id];
    });
    if (opened.length === 0 && dropped.length === 0 && ended.length === 0) return;
    const next = { ...bySession };
    const nextPending = { ...pending };
    for (const id of opened) {
      next[id] = { composeRequest: 0, shown: true };
      nextPending[id] = undefined;
    }
    for (const id of dropped) nextPending[id] = undefined;
    for (const id of ended) next[id] = undefined;
    useAgentInboxRailStore.setState({ bySession: next, pending: nextPending });
  });
}

/**
 * The per-terminal-tab agent inbox rail's state: which tabs are showing it, and
 * whether the composer was asked for. Not persisted — every tile boots with the
 * rail closed, same as the HUD and source-diff overlays.
 */
export const useAgentInboxRailStore = create<AgentInboxRailState>((set) => ({
  bySession: {},
  pending: {},
  markOpenedAsAgent: (sessionId) => {
    watchEligibility();
    set((s) => {
      if (isRunningAgent(useAgentStateStore.getState(), sessionId))
        return s.bySession[sessionId]
          ? s
          : { bySession: { ...s.bySession, [sessionId]: { composeRequest: 0, shown: true } } };
      return { pending: { ...s.pending, [sessionId]: true } };
    });
  },
  clearOpenedAsAgent: (sessionId) =>
    set((s) => (s.pending[sessionId] ? { pending: { ...s.pending, [sessionId]: undefined } } : s)),
  forget: (sessionId) =>
    set((s) =>
      s.bySession[sessionId] || s.pending[sessionId]
        ? {
            bySession: { ...s.bySession, [sessionId]: undefined },
            pending: { ...s.pending, [sessionId]: undefined },
          }
        : s,
    ),
  open: (sessionId, opts) =>
    set((s) => {
      if (!isRunningAgent(useAgentStateStore.getState(), sessionId)) return s;
      watchEligibility();
      const compose = opts?.compose === true;
      const cur = s.bySession[sessionId];
      const composeRequest = compose ? (cur?.composeRequest ?? 0) + 1 : (cur?.composeRequest ?? 0);
      if (cur?.shown && cur.composeRequest === composeRequest) return s;
      return {
        bySession: { ...s.bySession, [sessionId]: { ...cur, composeRequest, shown: true } },
      };
    }),
  openGroup: (sessionId) =>
    set((s) => {
      if (!isRunningAgent(useAgentStateStore.getState(), sessionId)) return s;
      watchEligibility();
      const cur = s.bySession[sessionId];
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            composeRequest: 0,
            ...cur,
            shown: true,
            groupRequest: (cur?.groupRequest ?? 0) + 1,
          },
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
  // The person's choice: a closed chat stays closed, so a mark still pending is spent too. The
  // entry stays, hidden, so the chat keeps its thread, scroll and draft for when it shows again.
  close: (sessionId) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      if (!cur?.shown && !s.pending[sessionId]) return s;
      return {
        bySession: cur ? { ...s.bySession, [sessionId]: { ...cur, shown: false } } : s.bySession,
        pending: { ...s.pending, [sessionId]: undefined },
      };
    }),
}));

/** A tab was launched as an agent: its chat covers it once the agent runs. */
export function markOpenedAsAgent(sessionId: string) {
  useAgentInboxRailStore.getState().markOpenedAsAgent(sessionId);
}

/** A launch failed before the agent was eligible: drop the mark. */
export function clearOpenedAsAgent(sessionId: string) {
  useAgentInboxRailStore.getState().clearOpenedAsAgent(sessionId);
}

/** A tab was removed: forget its chat state. */
export function forgetAgentInboxRail(sessionId: string) {
  useAgentInboxRailStore.getState().forget(sessionId);
}

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

/** Hide the chat on `sessionId`: its tab shows the CLI, and the chat waits, still mounted. */
export function closeAgentInboxRail(sessionId: string) {
  useAgentInboxRailStore.getState().close(sessionId);
}

/**
 * Hide the chat on `sessionId`, then focus the terminal in `pane` (the tab's pane, if known).
 * A terminal the chat covered is inert until the chat is hidden, so focus waits for the next frame.
 */
export function closeAgentInboxRailToTerminal(sessionId: string, pane: Element | null) {
  closeAgentInboxRail(sessionId);
  if (pane)
    requestAnimationFrame(() =>
      pane.querySelector<HTMLTextAreaElement>(".xterm textarea")?.focus(),
    );
}

/** Whether `sessionId`'s chat is shown (it covers the tab), not hidden behind the CLI or absent. */
export function useAgentChatShown(sessionId: string): boolean {
  return useAgentInboxRailStore((s) => s.bySession[sessionId]?.shown === true);
}

/** Whether the chat covers `sessionId`'s tab: it is shown and the agent still runs. */
export function useChatCovers(sessionId: string): boolean {
  const shown = useAgentChatShown(sessionId);
  const running = useRunningAgent(sessionId);
  return shown && running;
}

const CHAT_PANE = "[data-focus-pane], [data-pane-id], [data-pane-active]";

/** The pane (caption and body) of the tab whose chat is mounted for `sessionId`. */
function paneOfChat(sessionId: string): Element | null {
  if (typeof document === "undefined") return null;
  return (
    document
      .querySelector(`[data-testid="chat-overlay"][data-session-id="${CSS.escape(sessionId)}"]`)
      ?.closest(CHAT_PANE) ?? null
  );
}

/**
 * Show `sessionId`'s chat over its terminal. `focus`: the composer takes the keyboard (a click or
 * the shortcut); `keep`: it stays where it is (an arrow key on the Chat | CLI switch).
 */
export function showAgentChat(sessionId: string, how: "focus" | "keep") {
  useAgentInboxRailStore.getState().open(sessionId, { compose: how === "focus" });
}

/** Show `sessionId`'s CLI, handing it the keyboard on `focus` and leaving it on `keep`. */
export function showAgentCli(sessionId: string, how: "focus" | "keep") {
  if (how === "focus") closeAgentInboxRailToTerminal(sessionId, paneOfChat(sessionId));
  else closeAgentInboxRail(sessionId);
}

/** Flip a tab between its chat and its CLI, with the keyboard following (the shortcut). */
export function flipAgentView(sessionId: string) {
  if (useAgentInboxRailStore.getState().bySession[sessionId]?.shown)
    showAgentCli(sessionId, "focus");
  else showAgentChat(sessionId, "focus");
}

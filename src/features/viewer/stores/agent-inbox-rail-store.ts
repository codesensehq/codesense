// SPDX-License-Identifier: MIT
import {
  detectSessionAgent,
  isRunningAgent,
  useRunningAgent,
} from "@/features/viewer/lib/hand-agents";
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
   * The latest group request came while the chat was hidden or absent: it shows the room. Asked
   * while the chat covers the tab, it flips between the room and the agent's own thread.
   */
  groupOpens?: boolean;
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

type AgentState = ReturnType<typeof useAgentStateStore.getState>;

/**
 * Where a CLI started by hand stands on its chat cover (Q1: it covers once the CLI is first
 * Ready). `pending`: it runs, with hooks or an observed host, but is not yet idle; `ready`: its
 * first idle. Null for a launched tab, a tab with a chat entry (shown, or hidden by the person's
 * choice) or a pending launch mark, a plain shell, and a CLI only the process tree knows of,
 * which never reports Ready and so stays on the CLI.
 */
export function handCoverOf(
  agent: AgentState,
  rail: Pick<AgentInboxRailState, "bySession" | "pending">,
  sessionId: string,
): "pending" | "ready" | null {
  if (rail.bySession[sessionId] || rail.pending[sessionId] || agent.launchBySession[sessionId])
    return null;
  const detected = detectSessionAgent(agent, sessionId);
  if (!detected || detected.processOnly || !isRunningAgent(agent, sessionId)) return null;
  const snapshot = agent.activityBySession[sessionId]?.snapshot;
  const idle = snapshot?.observed
    ? snapshot.state === "idle"
    : agent.bySession[sessionId]?.state === "idle";
  return idle ? "ready" : "pending";
}

/** Whether `sessionId` runs a CLI started by hand whose chat covers it once the CLI is Ready. */
export function useHandCoverPending(sessionId: string): boolean {
  const claimed = useAgentInboxRailStore((s) => !!s.bySession[sessionId] || !!s.pending[sessionId]);
  const pending = useAgentStateStore(
    (agent) => handCoverOf(agent, { bySession: {}, pending: {} }, sessionId) === "pending",
  );
  return !claimed && pending;
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
    // A CLI started by hand: covered at its first idle, never asking for the composer, so the
    // cover takes no focus.
    const sessions = new Set([
      ...Object.keys(agent.bySession),
      ...Object.keys(agent.activityBySession),
    ]);
    const covered = [...sessions].filter(
      (id) => handCoverOf(agent, { bySession, pending }, id) === "ready",
    );
    // Only a shown chat goes with its agent. A hidden one is the person's choice for the tab,
    // held through the exit and any later CLI there until the tab closes (`forget`).
    const ended = Object.keys(bySession).filter((id) => {
      if (!bySession[id]?.shown || isRunningAgent(agent, id)) return false;
      // A layout refresh or reconnect temporarily hides live controls. Remember
      // the open rail until current lifecycle evidence confirms the agent ended.
      const activity = agent.activityBySession[id];
      return !activity || activity.freshness === "current" || !!agent.exitBySession[id];
    });
    if (!opened.length && !dropped.length && !ended.length && !covered.length) return;
    const next = { ...bySession };
    const nextPending = { ...pending };
    for (const id of [...opened, ...covered]) {
      next[id] = { composeRequest: 0, shown: true };
      nextPending[id] = undefined;
    }
    for (const id of dropped) nextPending[id] = undefined;
    for (const id of ended) next[id] = undefined;
    useAgentInboxRailStore.setState({ bySession: next, pending: nextPending });
  });
}

/**
 * The per-terminal-tab agent chat's state: which tabs have a chat, whether it covers the tab or
 * waits hidden behind the CLI, and whether the composer was asked for. Not persisted — every
 * tile boots with no chat, same as the HUD and source-diff overlays.
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
            groupOpens: cur?.shown !== true,
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
  // A close before any chat (a launch still pending, a CLI started by hand not yet Ready) records
  // the choice as a hidden entry; a plain shell records nothing.
  close: (sessionId) =>
    set((s) => {
      const cur = s.bySession[sessionId];
      if (cur && !cur.shown && !s.pending[sessionId]) return s;
      if (
        !cur &&
        !s.pending[sessionId] &&
        !isRunningAgent(useAgentStateStore.getState(), sessionId)
      )
        return s;
      return {
        bySession: { ...s.bySession, [sessionId]: { composeRequest: 0, ...cur, shown: false } },
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

// A CLI started by hand has no launch to start the watch, so it runs from the start. This store
// and the agent-state store import each other through the viewer store, so the other may not
// exist yet while this one loads: wait for it (a module loader that loads asynchronously, as
// vitest's does, can take a few turns).
function startWatching(tries = 0): void {
  if ((useAgentStateStore as typeof useAgentStateStore | undefined) !== undefined)
    watchEligibility();
  else if (tries < 100) setTimeout(() => startWatching(tries + 1), 0);
}
queueMicrotask(startWatching);

// SPDX-License-Identifier: MIT
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAgentsStore } from "@/features/agents/stores/agents-store";
import { agentKeyOfRevision } from "@/features/viewer/lib/agent-rows";
import { agentRowLabel, isHeadlessSession } from "@/features/viewer/lib/agent-row-presentation";
import { isAgentSession, type ListedAgentRow } from "@/features/viewer/lib/hand-agents";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { runtimeOf, STARTER_PREFIX } from "@/shared/lib/agent-runtimes";
import type { AgentRuntime, AgentSessionRow } from "@/tauri/commands";

/** The agent a tab runs, as its timers need it (SW-AGR-6). */
export interface TabTimerAgent {
  /** What to call it ("Remind Barb"). */
  name: string;
  /** The agent it was launched as (`<org>/<team>/<id>`, `builtin/claude`), or null. */
  agentKey: string | null;
  /** A saved agent: not a built-in starter and not a hand-started CLI. */
  saved: boolean;
  runtime: AgentRuntime;
}

/** The timer agent a roster row runs, or null for a plain shell or a headless run. */
function timerAgentOf(
  r: AgentSessionRow,
  agents: ReturnType<typeof useAgentsStore.getState>["rows"],
): TabTimerAgent | null {
  const row = r as ListedAgentRow;
  if (!row.sessionId || !isAgentSession(row) || isHeadlessSession(row)) return null;
  const agentKey = agentKeyOfRevision(row.agentRevision);
  const saved = agentKey !== null && !agentKey.startsWith(STARTER_PREFIX);
  const definition = saved ? agents?.find((a) => a.key === agentKey) : undefined;
  return {
    name: definition?.name ?? agentRowLabel(row),
    agentKey,
    saved,
    runtime: definition?.runtime ?? runtimeOf(agentKey, row.detected?.cli),
  };
}

/**
 * Every interactive agent session, saved or unnamed, local or remote, by
 * session id — the tabs that get timers, "Remind this agent…" and "Keep
 * this…". Plain shells and headless runs are not in it.
 */
export function useTabTimerAgents(): ReadonlyMap<string, TabTimerAgent> {
  const sessions = useAgentListProjectionStore((s) => s.sessions);
  const agents = useAgentsStore((s) => s.rows);
  return useMemo(() => {
    const out = new Map<string, TabTimerAgent>();
    for (const row of sessions ?? []) {
      const agent = timerAgentOf(row, agents);
      if (agent && row.sessionId) out.set(row.sessionId, agent);
    }
    return out;
  }, [sessions, agents]);
}

/** The interactive agent `sessionId` runs, or null (a plain shell, a headless run). Read for this
 *  session alone and compared shallowly, so another session's change does not redraw its tab. */
export function useTabTimerAgent(sessionId: string | undefined): TabTimerAgent | null {
  const agents = useAgentsStore((s) => s.rows);
  return useAgentListProjectionStore(
    useShallow((s) => {
      if (!sessionId) return null;
      // The last row for the session wins, as in the map.
      let agent: TabTimerAgent | null = null;
      for (const row of s.sessions ?? []) {
        if (row.sessionId === sessionId) agent = timerAgentOf(row, agents) ?? agent;
      }
      return agent;
    }),
  );
}

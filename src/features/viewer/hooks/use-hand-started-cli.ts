// SPDX-License-Identifier: MIT
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import {
  detectSessionAgent,
  useRunningAgent,
  type ListedAgentRow,
} from "@/features/viewer/lib/hand-agents";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";

/**
 * The CLI a person started by hand in `sessionId`'s tab (`claude`), or null. Such a session has
 * no launch record, and the loaded roster lists it only as what it detected (or not at all), with
 * no saved agent; a launched agent reattached after a restart keeps its saved agent there.
 */
export function useHandStartedCli(sessionId: string): string | null {
  const running = useRunningAgent(sessionId);
  // Before the roster has loaded, nothing says the session was not launched.
  const notLaunched = useAgentListProjectionStore((s) => {
    if (!s.sessions) return false;
    const row = s.sessions.find((r) => r.sessionId === sessionId) as ListedAgentRow | undefined;
    return !row || (!!row.detected && !row.agentRevision);
  });
  const cli = useAgentStateStore((s) =>
    s.launchBySession[sessionId] ? null : (detectSessionAgent(s, sessionId)?.cli ?? null),
  );
  return running && notLaunched ? cli : null;
}

// SPDX-License-Identifier: MIT
import { showAgent } from "./show-agent";
import { isRunningAgent, useRunningAgent } from "./hand-agents";
import { isHeadlessSession } from "./agent-row-presentation";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { openAgentInboxRail } from "../stores/agent-inbox-rail-store";
import type { AgentSessionRow } from "@/tauri/commands";

/** Whether a row offers its agent's chat (the inbox rail, its menu items and M): a running
 *  agent CLI in a tab. A headless run has no tab, so it has none. */
export function useAgentChatEligible(row: Pick<AgentSessionRow, "sessionId" | "kind">): boolean {
  return useRunningAgent(row.sessionId ?? "") && !isHeadlessSession(row);
}

export async function openAgentInboxForRow(
  row: AgentSessionRow,
  reveal: (row: AgentSessionRow) => unknown = showAgent,
  opts?: { compose?: boolean },
): Promise<boolean> {
  // A headless run has no tab to hold the chat, whatever its signals say.
  if (
    !row.alive ||
    !row.sessionId ||
    isHeadlessSession(row) ||
    !isRunningAgent(useAgentStateStore.getState(), row.sessionId)
  )
    return false;
  await reveal(row);
  openAgentInboxRail(row.sessionId, opts);
  return true;
}

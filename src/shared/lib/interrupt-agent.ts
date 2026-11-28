// SPDX-License-Identifier: MIT
import { isHeadlessSession } from "@/features/viewer/lib/agent-row-presentation";
import { toast } from "sonner";
import {
  LOCAL_MACHINE_ID,
  writePty,
  type AgentRuntime,
  type AgentSessionRow,
} from "@/tauri/commands";

/** The key each runtime's CLI takes to interrupt its running turn. Runtimes with no entry have none. */
const INTERRUPT_KEYS: Partial<Record<AgentRuntime, string>> = {
  claude: "\x1b",
  codex: "\x1b",
};

type InterruptRow = Pick<
  AgentSessionRow,
  "kind" | "sessionId" | "alive" | "hasAgent" | "machineId"
>;

/** Whether the row is a live agent session on This Mac with a PTY whose runtime has an interrupt
 *  key. A remote row is left out: the bare session id only resolves to a local session. */
export function hasInterrupt(row: InterruptRow, runtime: AgentRuntime): boolean {
  return (
    row.hasAgent === true &&
    row.alive &&
    (!row.machineId || row.machineId === LOCAL_MACHINE_ID) &&
    !!row.sessionId &&
    !isHeadlessSession(row) &&
    INTERRUPT_KEYS[runtime] !== undefined
  );
}

/** Interrupts the agent's running turn, as its CLI's key does. Never ends the session; the one interrupt path. */
export function interruptAgent(row: InterruptRow, runtime: AgentRuntime): void {
  const key = INTERRUPT_KEYS[runtime];
  if (!hasInterrupt(row, runtime) || key === undefined) return;
  writePty(row.sessionId!, key).catch(() => {
    toast.error("Couldn't interrupt the agent");
  });
}

// SPDX-License-Identifier: MIT
import type { ConversationMessage } from "../api";
import { HUMAN, sameTeam } from "../model";
import type { InboxTeam } from "@/tauri/commands";

/** A message between the human and `handle`, either way (role mail and other agents' are not). */
export const between = (m: ConversationMessage, handle: string) =>
  !m.toRole && ((m.from === handle && m.to === HUMAN) || (m.from === HUMAN && m.to === handle));

/** The team an agent works in, by its mail: the pane's team when the agent wrote there, else
 *  where it last wrote, else the pane's team (null when there is none). */
export function agentTeam(
  messages: readonly ConversationMessage[],
  handle: string,
  home: InboxTeam | null,
): InboxTeam | null {
  const own = messages.filter((m) => m.from === handle);
  if (home && own.some((m) => sameTeam(m.team, home))) return home;
  // The latest by when it was written: a read lists teams one after another, not by time.
  let last: ConversationMessage | null = null;
  for (const m of own) if (!last || m.createdAtMs > last.createdAtMs) last = m;
  return last ? last.team : home;
}

// SPDX-License-Identifier: MIT
import { useShallow } from "zustand/react/shallow";

import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";

import { useInboxProjectionStore, useWatchInboxProjection } from "./use-inbox-projection";
import { useInboxSessionsStore, useWatchInboxSessions } from "./use-inbox-sessions";

/** No session row for the handle: nothing to join and nothing unread. */
const NO_ROW = [undefined, undefined, 0, 0] as const;
const NO_COUNTS = [false, undefined, false, undefined] as const;

/**
 * Messages to a tab's session it has not read yet (0 when unknown): the handle's own row of
 * {@link joinInboxSessions}, read as four primitives from each store, so another handle's mail
 * does not redraw this tab.
 */
export function useTabInboxCounts(sessionId: string): { direct: number; group: number } {
  useWatchInboxSessions();
  useWatchInboxProjection();
  const handle = useAgentListProjectionStore(
    (s) => s.sessions?.find((r) => r.sessionId === sessionId)?.handle ?? sessionId,
  );
  const [org, team, unread, groupUnread] = useInboxSessionsStore(
    useShallow((s) => {
      const row = s.sessions?.find((r) => r.handle === handle);
      return row ? [row.team?.org, row.team?.team, row.unread, row.groupUnread] : NO_ROW;
    }),
  );
  // The projection's fields win over the list's, as the join spreads them: one it sets
  // (even to undefined) replaces the list's.
  const [hasUnread, ownUnread, hasGroup, ownGroup] = useInboxProjectionStore(
    useShallow((s) => {
      if (org === undefined) return NO_COUNTS;
      const own = s.counts.find((c) => c.team.org === org && c.team.team === team)?.sessions[
        handle
      ];
      return own ? ["unread" in own, own.unread, "groupUnread" in own, own.groupUnread] : NO_COUNTS;
    }),
  );
  return {
    direct: (hasUnread ? ownUnread : unread) ?? 0,
    group: (hasGroup ? ownGroup : groupUnread) ?? 0,
  };
}

export function useTabInboxUnread(sessionId: string): number {
  const { direct, group } = useTabInboxCounts(sessionId);
  return direct + group;
}

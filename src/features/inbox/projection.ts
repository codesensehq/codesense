// SPDX-License-Identifier: MIT
import type { HubRow } from "@/features/dashboard/lib/live-hub";
import type { InboxTeam, SessionListRow } from "@/tauri/commands";

export type InboxCounts = HubRow & {
  rowType: "counts";
  team: InboxTeam;
  humanUnread: number;
  recipients: Record<string, number>;
  needsYouBySender: Record<string, number>;
  sessions: Record<string, Partial<SessionListRow>>;
};
export const countRows = (rows: HubRow[]): InboxCounts[] =>
  rows.filter((row) => row.rowType === "counts") as InboxCounts[];
export const inboxCount = (
  rows: readonly InboxCounts[],
  recipient: string,
  team?: InboxTeam | null,
): number =>
  rows
    .filter((row) => !team || (row.team.org === team.org && row.team.team === team.team))
    .reduce(
      (sum, row) =>
        sum + (recipient === "human" ? row.humanUnread : (row.recipients[recipient] ?? 0)),
      0,
    );
export const inboxNeedsYou = (rows: readonly InboxCounts[], handles: readonly string[]): number =>
  rows.reduce(
    (sum, row) => sum + handles.reduce((n, handle) => n + (row.needsYouBySender[handle] ?? 0), 0),
    0,
  );
/** The projection's own fields for the session `handle` of `team`, or undefined: the one match
 *  and lookup behind {@link joinInboxSessions} and the per-tab counts. */
export function inboxCountsRowFor(
  counts: readonly InboxCounts[],
  team: InboxTeam | null | undefined,
  handle: string,
): Partial<SessionListRow> | undefined {
  return counts.find((row) => row.team.org === team?.org && row.team.team === team?.team)?.sessions[
    handle
  ];
}
export function joinInboxSessions(
  sessions: SessionListRow[],
  counts: readonly InboxCounts[],
): SessionListRow[] {
  return sessions.map((session) => {
    const row = inboxCountsRowFor(counts, session.team, session.handle);
    return row ? { ...session, ...row } : session;
  });
}

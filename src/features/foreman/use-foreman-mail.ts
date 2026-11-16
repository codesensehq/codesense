// SPDX-License-Identifier: MIT
import { useInboxSessions } from "@/features/inbox/hooks/use-inbox-sessions";
import { useRoleQueues } from "@/shared/hooks/use-role-queues";
import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import type { InboxTeam, RoleQueue, SessionListRow } from "@/tauri/commands";

import { FOREMAN_ROLE, isForemanAgent } from "./open-foreman";

/** Mail waits for the Foreman and nobody holds its role to read it. */
export function foremanMailWaiting(queue: RoleQueue | undefined): boolean {
  if (!queue || queue.role !== FOREMAN_ROLE) return false;
  return (queue.counts.pending ?? 0) > 0 && !queue.registrations.some((r) => r.live);
}

/**
 * The team the Foreman runs in, where the setup guide hands back: a live Foreman row's team, else
 * the newest row's by start time, as the page's home rule reads it (a Foreman that re-homed holds
 * its role in a user team), else the docs team it starts in.
 */
export function foremanTeamOf(rows: readonly SessionListRow[] | null): InboxTeam {
  const startOf = (r: SessionListRow) => (r as { startedAtMs?: number }).startedAtMs ?? 0;
  const own = (rows ?? [])
    .filter((r) => isForemanAgent(r.agent) && r.team?.org && r.team.team)
    .sort((a, b) => startOf(b) - startOf(a));
  const row = own.find((r) => r.state !== "exited") ?? own[0];
  return row?.team ?? { org: CODESENSE_DOCS_SLUG, team: CODESENSE_DOCS_TEAM };
}

/**
 * Whether Foreman mail waits with no Foreman live, in the Foreman's team or the active team,
 * re-read while `enabled`. Read only.
 */
export function useForemanMailWaiting(enabled: boolean): boolean {
  const activeOrg = useOrgStore((s) => s.activeOrgSlug);
  const activeTeam = useOrgStore((s) => s.activeTeamName);
  const home = foremanTeamOf(useInboxSessions());
  const homeKey = buildTeamKey(home.org, home.team);
  const activeKey = activeOrg && activeTeam ? buildTeamKey(activeOrg, activeTeam) : "";
  // An empty key reads nothing.
  const foreman = useRoleQueues(enabled ? homeKey : "");
  const active = useRoleQueues(
    enabled && activeKey && activeKey !== homeKey && activeOrg !== CODESENSE_DOCS_SLUG
      ? activeKey
      : "",
  );
  return [...foreman.queues, ...active.queues].some(foremanMailWaiting);
}

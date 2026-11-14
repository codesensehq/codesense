// SPDX-License-Identifier: MIT
import { useRoleQueues } from "@/shared/hooks/use-role-queues";
import { CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM } from "@/shared/lib/codesense-docs";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import type { RoleQueue } from "@/tauri/commands";

import { FOREMAN_ROLE } from "./open-foreman";

/** Mail waits for the Foreman and nobody holds its role to read it. */
export function foremanMailWaiting(queue: RoleQueue | undefined): boolean {
  if (!queue || queue.role !== FOREMAN_ROLE) return false;
  return (queue.counts.pending ?? 0) > 0 && !queue.registrations.some((r) => r.live);
}

/**
 * Whether Foreman mail waits with no Foreman live, in the active team or the docs team (the
 * page's own home), re-read while `enabled`. Read only.
 */
export function useForemanMailWaiting(enabled: boolean): boolean {
  const activeOrg = useOrgStore((s) => s.activeOrgSlug);
  const activeTeam = useOrgStore((s) => s.activeTeamName);
  // An empty key reads nothing.
  const docs = useRoleQueues(enabled ? buildTeamKey(CODESENSE_DOCS_SLUG, CODESENSE_DOCS_TEAM) : "");
  const active = useRoleQueues(
    enabled && activeOrg && activeTeam && activeOrg !== CODESENSE_DOCS_SLUG
      ? buildTeamKey(activeOrg, activeTeam)
      : "",
  );
  return [...docs.queues, ...active.queues].some(foremanMailWaiting);
}

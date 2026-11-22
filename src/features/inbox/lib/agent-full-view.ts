// SPDX-License-Identifier: MIT
import { teamContentRoot } from "@/features/viewer/lib/team-landing-page";
import { openFileInTeam } from "@/shared/lib/open-file-in-team";
import { join } from "@/shared/lib/path";
import { teamContentPage } from "@/shared/lib/team-content-page";
import type { Org } from "@/shared/types/domain";

/** The page's route: it names the session in the fragment, which the viewer replays to the page. */
export const agentPageHash = (handle: string) => `#session=${encodeURIComponent(handle)}`;

/**
 * The absolute path of the agent page a team declares in `teams.yml` (`agent_page:`, relative to the
 * team's content), or `null` when it declares none or the org has no root. The app names no page of
 * its own: a team without the setting has no Full view.
 */
export function teamAgentPage(orgs: readonly Org[], org: string, team: string): string | null {
  const declared = teamContentPage(orgs, org, team, "agent_page");
  const orgRoot = orgs.find((o) => o.slug === org)?.org_root;
  return declared && orgRoot ? join(teamContentRoot(orgRoot, team), declared) : null;
}

/** Open the agent's page (`page`, its absolute path) for the session `handle`, as a pinned tab. */
export function openAgentFullView(
  { org, team, handle, page }: { org: string; team: string; handle: string; page: string },
  open: typeof openFileInTeam = openFileInTeam,
): void {
  open({ org, team, path: page }, { newTab: true, hash: agentPageHash(handle) });
}

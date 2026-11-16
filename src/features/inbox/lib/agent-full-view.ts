// SPDX-License-Identifier: MIT
import { openFileInTeam } from "@/shared/lib/open-file-in-team";
import { teamContentPage } from "@/shared/lib/team-content-page";
import type { Org } from "@/shared/types/domain";

/** The page's route: it names the session in the fragment, which the viewer replays to the page. */
export const agentPageHash = (handle: string) => `#session=${encodeURIComponent(handle)}`;

/**
 * The agent page a team declares in `teams.yml` (`agent_page:`, relative to the team's content),
 * or `null` when it declares none. The app names no page of its own: a team without the setting
 * has no Full view.
 */
export const teamAgentPage = (orgs: readonly Org[], org: string, team: string) =>
  teamContentPage(orgs, org, team, "agent_page");

/** Open the agent's page (`page`, a path in `team`'s content) for the session `handle`, as a pinned tab. */
export function openAgentFullView(
  { org, team, handle, page }: { org: string; team: string; handle: string; page: string },
  open: typeof openFileInTeam = openFileInTeam,
): void {
  open({ org, team, path: page }, { newTab: true, hash: agentPageHash(handle) });
}

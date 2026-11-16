// SPDX-License-Identifier: MIT
import type { Org } from "@/shared/types/domain";

/**
 * The page a team declares in `teams.yml` under `setting` (relative to the team's content), or
 * `null` when it declares none. The app names no page of its own for these settings.
 */
export function teamContentPage(
  orgs: readonly Org[],
  org: string,
  team: string,
  setting: "agent_page" | "story_page",
): string | null {
  const declared = orgs.find((o) => o.slug === org)?.teams.find((t) => t.name === team)?.[setting];
  return declared?.trim() || null;
}

// SPDX-License-Identifier: MIT
/**
 * What a dashboard tile shows and for which team, as pure reads over a ref and a pane listing.
 *
 * - The page team: the story's when the tile sits in a story workspace, else its file's team. A
 *   private or built-in page has no file team and follows the team on screen, as the right pane
 *   does. The tile's other tabs (agents from two teams) never change it.
 * - The pane: the listed one with the ref's key. A team or private pane with a built-in's id
 *   replaces the built-in, as `list_panes` already hides it.
 */
import type { DashboardRef, FrameTeam, PaneEntry, PaneListing } from "@/tauri/commands";

import { dashboardRefKey } from "./dashboard-ref";

/** Where a dashboard tile sits. */
export interface DashboardTilePlace {
  /** The team of the story workspace the tile sits in; absent in any other group. */
  storyTeam?: FrameTeam | null;
  /** The tile's other tabs. Read by no rule: listed so the table can say so. */
  tabs?: readonly string[];
}

/** The team the tile's page belongs to; null when it follows the team on screen. */
export function dashboardPageTeam(ref: DashboardRef, place: DashboardTilePlace): FrameTeam | null {
  if (place.storyTeam) return place.storyTeam;
  return ref.scope === "team" && ref.team ? { org: ref.org, team: ref.team } : null;
}

/** The listed pane a dashboard tile opens for `ref`, if the listing has it. */
export function resolveDashboardTileEntry(
  listing: Pick<PaneListing, "panes">,
  ref: DashboardRef,
): PaneEntry | undefined {
  if (ref.scope === "built-in") {
    // The listing is nearest first: the team's own copy, then its chain's, then the private one.
    const replacement = listing.panes.find(
      (pane) => pane.id === ref.id && pane.dashboardRef && pane.dashboardRef.scope !== "built-in",
    );
    if (replacement) return replacement;
  }
  const key = dashboardRefKey(ref);
  return listing.panes.find(
    (pane) => pane.dashboardRef && dashboardRefKey(pane.dashboardRef) === key,
  );
}

// SPDX-License-Identifier: MIT
/**
 * A dashboard as a tile's body: today's slot host, framed under the `right-pane` slot with its
 * grants, CSP, theme and bridge unchanged, for the tile's page team rather than the team on
 * screen. The tile host mounts it once per tile key; it is never mounted with the tiles flag off,
 * so the right pane keeps serving `right-pane` as today.
 *
 * Its panel id is the tile's own, so the right pane's panel sweep, reveal and focus never take it
 * for one of theirs.
 */
import { useCallback, useEffect, useState } from "react";

import { dashboardRefOfKey } from "@/features/dashboard/lib/dashboard-ref";
import {
  dashboardPageTeam,
  resolveDashboardTileEntry,
} from "@/features/dashboard/lib/dashboard-tile";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import type { TileBodyContext } from "@/shared/tiling/tile-host";
import {
  listPanes,
  type DashboardRef,
  type FrameTeam,
  type PaneEntry,
  type PaneListing,
} from "@/tauri/commands";

import { paneListingCache, usePaneStore } from "../right-pane/panes/pane-store";
import { inboxOfListing } from "./reveal-slot";
import { SlotDashboardHost } from "./slot-dashboard-host";

const INBOX_KEY = /^inbox:(.+)$/;

/** The panel id a dashboard tile's frame registers under. */
const dashboardTilePanelId = (tileKey: string) => `tile:${tileKey}`;

/** The team's pane listing: the warm cache or the hub's current one, else read once. */
function useTeamListing(teamKey: string | null, org: string | null, team: string | null) {
  const cached = paneListingCache.useValue(teamKey ?? "")?.listing;
  const current = usePaneStore((s) => (teamKey && s.teamKey === teamKey ? s.listing : null));
  const [read, setRead] = useState<{ teamKey: string; listing: PaneListing | null }>();
  const known = cached ?? current;
  useEffect(() => {
    if (known || !teamKey || !org || !team) return;
    let live = true;
    void listPanes(org, team)
      .then((listing) => live && setRead({ teamKey, listing }))
      .catch(() => live && setRead({ teamKey, listing: null }));
    return () => {
      live = false;
    };
  }, [known, teamKey, org, team]);
  return known ?? (read?.teamKey === teamKey ? read.listing : undefined);
}

export function DashboardTileBody({
  tileKey,
  context,
  storyTeam,
  dashboard,
  pick = resolveDashboardTileEntry,
}: {
  tileKey: string;
  context: TileBodyContext;
  /** The team of the story workspace the tile sits in. */
  storyTeam?: FrameTeam | null;
  /** The dashboard, for a tile whose key does not name one. Default the key's. */
  dashboard?: DashboardRef;
  /** The listed pane that shows it. Default the ref's own, or what replaces a built-in. */
  pick?: (listing: PaneListing, ref: DashboardRef) => PaneEntry | undefined;
}) {
  const ref = dashboard ?? dashboardRefOfKey(tileKey);
  const activeOrg = useOrgStore((s) => s.activeOrgSlug);
  const activeTeam = useOrgStore((s) => s.activeTeamName);
  const pageTeam = ref ? dashboardPageTeam(ref, { storyTeam }) : null;
  const org = pageTeam?.org ?? activeOrg;
  const team = pageTeam?.team ?? activeTeam;
  const teamKey = org && team ? buildTeamKey(org, team) : null;
  const listing = useTeamListing(teamKey, org, team);
  const entry = ref && listing ? pick(listing, ref) : undefined;

  const panelId = dashboardTilePanelId(tileKey);
  const intent = usePaneStore((s) => s.pendingIntents[panelId]);
  const onIntentDelivered = useCallback(() => {
    if (intent) usePaneStore.getState().clearIntent(panelId, intent);
  }, [panelId, intent]);

  const { reportLoading } = context;
  const waiting = !!ref && listing === undefined;
  useEffect(() => reportLoading(waiting), [waiting, reportLoading]);

  if (!ref || !teamKey || listing === undefined) return null;
  if (!entry || !listing)
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        This dashboard isn't listed for {team}.
      </div>
    );
  return (
    <SlotDashboardHost
      slotId="right-pane"
      panelId={panelId}
      entry={entry}
      contentRoot={listing.contentRoot}
      teamKey={teamKey}
      keepTeam={!!pageTeam}
      visible={context.visible}
      intent={intent}
      onIntentDelivered={onIntentDelivered}
      headerless
    />
  );
}

/** The org's Inbox as a tile's body: the inbox dashboard the team on screen resolves, as the
 *  right pane's Inbox does, framed as a dashboard tile. */
export function InboxTileBody({ tileKey, context }: { tileKey: string; context: TileBodyContext }) {
  const org = INBOX_KEY.exec(tileKey)?.[1];
  if (!org) return null;
  return (
    <DashboardTileBody
      tileKey={tileKey}
      context={context}
      dashboard={{ scope: "built-in", org, id: "inbox" }}
      pick={(listing) => inboxOfListing(org, listing.panes)}
    />
  );
}

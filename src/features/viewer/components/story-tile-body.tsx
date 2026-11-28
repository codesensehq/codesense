// SPDX-License-Identifier: MIT
/**
 * A story page as a tile's body: the story's file through `StoryAwareMarkdown`, which opens the
 * owning team's story page for it. The team is the story workspace's, else the team on screen;
 * the file comes from that team's pipeline tree.
 */
import { useEffect } from "react";

import { StoryAwareMarkdown } from "@/features/dashboard/components/story-aware-markdown";
import { storyFilePathFromTree } from "@/shared/lib/pipeline-graph/resolve-story-file-path";
import { pathToTeamContentDirSync } from "@/shared/lib/team-content-path";
import { buildTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import type { TileBodyContext } from "@/shared/tiling/tile-host";
import type { FrameTeam } from "@/tauri/commands";

import { useTeamTree } from "../lib/team-surface-store";

const STORY_PAGE = /^story-page:(.+)$/;

export function StoryTileBody({
  tileKey,
  context,
  orgRoot,
  storyTeam,
}: {
  tileKey: string;
  context: TileBodyContext;
  orgRoot: string;
  /** The team of the story workspace the tile sits in. */
  storyTeam?: FrameTeam | null;
}) {
  const storyId = STORY_PAGE.exec(tileKey)?.[1] ?? null;
  const activeOrg = useOrgStore((s) => s.activeOrgSlug);
  const activeTeam = useOrgStore((s) => s.activeTeamName);
  const org = storyTeam?.org ?? activeOrg;
  const team = storyTeam?.team ?? activeTeam;
  const teamKey = org && team ? buildTeamKey(org, team) : null;
  const tree = useTeamTree(teamKey);
  const filePath = tree && storyId ? storyFilePathFromTree(tree, storyId) : null;

  const { reportLoading } = context;
  const waiting = !!teamKey && !tree;
  useEffect(() => reportLoading(waiting), [waiting, reportLoading]);

  if (!storyId || !team || !teamKey || !tree) return null;
  if (!filePath)
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        {storyId} isn't in {team}'s stories.
      </div>
    );
  return (
    <StoryAwareMarkdown
      hostTeamKey={teamKey}
      filePath={filePath}
      teamContentPath={pathToTeamContentDirSync(orgRoot, team)}
    />
  );
}

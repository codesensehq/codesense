// SPDX-License-Identifier: MIT
import { toast } from "sonner";

import { getActiveWorkspaceContext } from "@/shared/hooks/use-active-workspace-context";
import { parseTeamKey } from "@/shared/lib/team-key";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import type { Org } from "@/shared/types/domain";
import { readFile } from "@/tauri/commands";

import { storyTypeOfHtml, storyTypeOfMarkdown, teamStoryPage } from "./story-page";

export const NO_STORY_IN_FOCUS =
  "No story in focus: open a story's workspace or its file to see its dashboard.";
export const NO_STORY_PAGE_TOAST =
  "This team has no story page (story_page in teams.yml), so its story opens as markdown.";

export interface StoryDashboardDeps {
  teamKey: string;
  orgs: readonly Org[];
  /** The focused workspace's story file, when the focused workspace is a story's. */
  workspaceStory: string | null;
  /** The active tab's file path, if any. */
  activeTab: string | null;
  read: (path: string) => Promise<string>;
  /** Open `path` as a pinned tab (a story's file draws its page). */
  open: (path: string) => void;
  /** Tell the person why nothing, or not the page, opened. */
  tell: (message: string) => void;
}

/**
 * The story in focus: the focused story workspace's file, else the active tab when it is a story
 * file (an `.md` with `type: story|bug|spike`, or a shell with the `cs:type` meta). `null` when
 * neither is.
 */
export async function focusedStoryFile(deps: StoryDashboardDeps): Promise<string | null> {
  if (deps.workspaceStory) return deps.workspaceStory;
  const tab = deps.activeTab;
  if (!tab) return null;
  const ext = tab.split(".").pop()?.toLowerCase();
  if (ext !== "md" && ext !== "html" && ext !== "htm") return null;
  const text = await deps.read(tab).catch(() => null);
  if (text === null) return null;
  return (ext === "md" ? storyTypeOfMarkdown(text) : storyTypeOfHtml(text)) ? tab : null;
}

/** View → Dashboard: open the focused story's dashboard, or say why there is none. */
export async function openStoryDashboard(deps: StoryDashboardDeps): Promise<void> {
  const file = await focusedStoryFile(deps);
  if (!file) {
    deps.tell(NO_STORY_IN_FOCUS);
    return;
  }
  deps.open(file);
  // A shell is its own page; an md draws the team's story page, or says it has none.
  const team = parseTeamKey(deps.teamKey);
  const page = team.teamName ? teamStoryPage(deps.orgs, team.orgSlug, team.teamName) : null;
  if (file.toLowerCase().endsWith(".md") && !page) deps.tell(NO_STORY_PAGE_TOAST);
}

/** The app's dependencies for {@link openStoryDashboard}: the active team's focus and the viewer store. */
export function liveStoryDashboardDeps(): StoryDashboardDeps {
  const { teamKey, workspace } = getActiveWorkspaceContext();
  const store = useViewerStore.getState();
  return {
    teamKey,
    orgs: useOrgStore.getState().orgs,
    workspaceStory: workspace?.kind === "story" ? (workspace.storyFilePath ?? null) : null,
    activeTab: store.activeTab[teamKey] ?? null,
    read: readFile,
    open: (path) => store.openStoryDocForTeam(teamKey, path),
    tell: (message) => void toast.info(message),
  };
}

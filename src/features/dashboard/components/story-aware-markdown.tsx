// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

import { fileContentCache } from "@/shared/lib/file-content-cache";
import { parseTeamKey } from "@/shared/lib/team-key";
import type { CommonViewerProps } from "@/shared/lib/viewer-file-type";
import { useOrgStore } from "@/shared/stores/org-store";
import { readFile } from "@/tauri/commands";

import {
  storyPageHash,
  storyPagePath,
  storyTypeOfMarkdown,
  teamStoryPage,
} from "../lib/story-page";
import { HtmlViewer, type FrameShortcutHandler } from "./html-viewer";
import { MarkdownViewer, type MarkdownExtras } from "./markdown-viewer";

/** A story file with no page set for its team: it opens as markdown, and says why. */
export const NO_STORY_PAGE_NOTE =
  "This is a story file, but its team has no story page (story_page in teams.yml), so it opens as markdown.";

/**
 * The story type of the `.md` at `filePath`, read from its front matter: `undefined` until it is
 * read, then the type or `null`. The text comes from the viewer's file cache when it holds a
 * current read, else from one read that fills the cache for the markdown viewer behind it.
 */
function useStoryType(filePath: string, refreshKey: number | undefined) {
  const [read, setRead] = useState<{
    path: string;
    type: ReturnType<typeof storyTypeOfMarkdown>;
  }>();
  useEffect(() => {
    let cancelled = false;
    const done = (text: string) => {
      if (!cancelled) setRead({ path: filePath, type: storyTypeOfMarkdown(text) });
    };
    const cached = fileContentCache.get(filePath);
    if (cached && cached.refreshKey === (refreshKey ?? 0)) done(cached.content);
    else
      readFile(filePath).then(
        (text) => {
          fileContentCache.set(filePath, text, refreshKey ?? 0);
          done(text);
        },
        // A file that can't be read is the markdown viewer's to report.
        () => done(""),
      );
    return () => {
      cancelled = true;
    };
  }, [filePath, refreshKey]);
  return read?.path === filePath ? read.type : undefined;
}

/**
 * The viewer for an `.md` tab. A file whose front matter says `type: story|bug|spike` opens its
 * team's story page (`story_page:` in teams.yml) in this same tab, with the file named in the page's
 * URL fragment, so every way of opening the file lands here and opening it again focuses the tab. Any
 * other markdown file, and a story file whose team has no page, is the markdown viewer as before; the
 * latter says why.
 */
export function StoryAwareMarkdown({
  onFrameShortcut,
  ...props
}: CommonViewerProps & { filePath: string } & MarkdownExtras & {
    onFrameShortcut?: FrameShortcutHandler;
  }) {
  const team = props.hostTeamKey ? parseTeamKey(props.hostTeamKey) : null;
  const page = useOrgStore((state) =>
    team?.teamName ? teamStoryPage(state.orgs, team.orgSlug, team.teamName) : null,
  );
  const type = useStoryType(props.filePath, props.refreshKey);

  if (page && type === undefined) return <div data-testid="story-detect" className="flex-1" />;
  if (page && type) {
    return (
      <HtmlViewer
        hostTeamKey={props.hostTeamKey}
        filePath={storyPagePath(props.teamContentPath, page)}
        teamContentPath={props.teamContentPath}
        refreshKey={props.refreshKey}
        onNavigate={props.onNavigate}
        changedPaths={props.changedPaths}
        viewStateKey={props.viewStateKey}
        pendingHash={storyPageHash(props.filePath)}
        onFrameShortcut={onFrameShortcut}
      />
    );
  }
  if (type) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p
          role="note"
          data-testid="story-no-page"
          className="border-b px-4 py-2 text-xs text-muted-foreground"
        >
          {NO_STORY_PAGE_NOTE}
        </p>
        <div className="flex min-h-0 flex-1 flex-col">
          <MarkdownViewer {...props} />
        </div>
      </div>
    );
  }
  return <MarkdownViewer {...props} />;
}

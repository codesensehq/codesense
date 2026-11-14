// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";

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
 * read, then the type or `null`. A current entry in the viewer's file cache answers on the first
 * render, so a warm open paints its viewer at once; otherwise one read fills the cache for the
 * markdown viewer behind it.
 */
function useStoryType(filePath: string, refreshKey: number | undefined) {
  const version = refreshKey ?? 0;
  const cached = fileContentCache.get(filePath);
  const cachedText = cached?.refreshKey === version ? cached.content : undefined;
  const warm = useMemo(
    () => (cachedText === undefined ? undefined : storyTypeOfMarkdown(cachedText)),
    [cachedText],
  );
  const [read, setRead] = useState<{
    path: string;
    type: ReturnType<typeof storyTypeOfMarkdown>;
  }>();
  const cold = warm === undefined;
  useEffect(() => {
    if (!cold) return;
    let cancelled = false;
    const done = (text: string) => {
      if (!cancelled) setRead({ path: filePath, type: storyTypeOfMarkdown(text) });
    };
    readFile(filePath).then(
      (text) => {
        fileContentCache.set(filePath, text, version);
        done(text);
      },
      // A file that can't be read is the markdown viewer's to report.
      () => done(""),
    );
    return () => {
      cancelled = true;
    };
  }, [filePath, version, cold]);
  if (!cold) return warm;
  return read?.path === filePath ? read.type : undefined;
}

/**
 * The page's fragment for `filePath`. A link's anchor (the host's pending hash) rides along; once the
 * host has consumed it, the page keeps the anchor it was opened at, so its route doesn't change.
 */
function useStoryPageHash(filePath: string, pendingHash: string | null | undefined) {
  const [route, setRoute] = useState(() => ({
    path: filePath,
    hash: storyPageHash(filePath, pendingHash),
  }));
  if (
    route.path !== filePath ||
    (pendingHash && route.hash !== storyPageHash(filePath, pendingHash))
  ) {
    const next = { path: filePath, hash: storyPageHash(filePath, pendingHash) };
    setRoute(next);
    return next.hash;
  }
  return route.hash;
}

/**
 * The viewer for an `.md` tab. A file whose front matter says `type: story|bug|spike` opens its
 * team's story page (`story_page:` in teams.yml) in this same tab, with the file named in the page's
 * URL fragment, so every way of opening the file lands here and opening it again focuses the tab. Any
 * other markdown file, and a story file whose team has no page, is the markdown viewer as before; the
 * latter says why. A host that names no team (the worktree editor) has no story page to choose, so it
 * is the markdown viewer, with no read and no note.
 */
type Props = CommonViewerProps & { filePath: string } & MarkdownExtras & {
    onFrameShortcut?: FrameShortcutHandler;
  };

export function StoryAwareMarkdown(props: Props) {
  const team = props.hostTeamKey ? parseTeamKey(props.hostTeamKey) : null;
  if (!team?.teamName) {
    const { onFrameShortcut: _unused, ...md } = props;
    return <MarkdownViewer {...md} />;
  }
  return <TeamMarkdown {...props} org={team.orgSlug} team={team.teamName} />;
}

function TeamMarkdown({
  onFrameShortcut,
  org,
  team,
  ...props
}: Props & { org: string; team: string }) {
  const page = useOrgStore((state) => teamStoryPage(state.orgs, org, team));
  const type = useStoryType(props.filePath, props.refreshKey);
  const hash = useStoryPageHash(props.filePath, props.pendingHash);
  const opensPage = Boolean(page && type);
  const { pendingHash, onPendingHashConsumed } = props;
  useEffect(() => {
    // The page carries the anchor now; the host's request for this file is done.
    if (opensPage && pendingHash) onPendingHashConsumed?.();
  }, [opensPage, pendingHash, onPendingHashConsumed]);

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
        pendingHash={hash}
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

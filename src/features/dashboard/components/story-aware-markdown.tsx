// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";

import { useEffectiveRefreshKey } from "@/shared/hooks/use-effective-refresh-key";
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

/** A story file whose team's story page can't be found (a page missing from this checkout, or a
 *  mistyped story_page): it opens as markdown, and says which page it looked for. */
export const missingStoryPageNote = (page: string) =>
  `This is a story file, but its team's story page (${page}, the story_page in teams.yml) isn't there, so it opens as markdown.`;

/**
 * The story type of the `.md` at `filePath`, read from its front matter: `undefined` until it is
 * first read, then the type or `null`. A current entry in the viewer's file cache answers on the first
 * render, so a warm open paints its viewer at once; otherwise one read fills the cache for the
 * markdown viewer behind it. It re-reads only when this file changes (not on every write in the team),
 * and the last answer for the path stands while that read is pending, so an open story page is never
 * unmounted by a write.
 */
function useStoryType(
  filePath: string,
  refreshKey: number | undefined,
  changedPaths: Set<string> | null | undefined,
) {
  const version = useEffectiveRefreshKey(refreshKey, changedPaths, filePath) ?? 0;
  const cached = fileContentCache.get(filePath);
  const cachedText = cached?.refreshKey === version ? cached.content : undefined;
  const warm = useMemo(
    () => (cachedText === undefined ? undefined : storyTypeOfMarkdown(cachedText)),
    [cachedText],
  );
  const [last, setLast] = useState<{
    path: string;
    type: ReturnType<typeof storyTypeOfMarkdown>;
  }>();
  // A warm answer is kept too, so it still stands once the cache moves past it.
  if (warm !== undefined && (last?.path !== filePath || last.type !== warm))
    setLast({ path: filePath, type: warm });
  const cold = warm === undefined;
  useEffect(() => {
    if (!cold) return;
    let cancelled = false;
    const done = (text: string) => {
      if (!cancelled) setLast({ path: filePath, type: storyTypeOfMarkdown(text) });
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
  return last?.path === filePath ? last.type : undefined;
}

/**
 * The page's fragment for `filePath`, and the link's anchor it carries (the host's pending hash).
 * Once the host has consumed it, both keep what the page was opened at, so its route doesn't
 * change, and an md shown in place of a missing page still opens at the anchor.
 */
function useStoryPageHash(filePath: string, pendingHash: string | null | undefined) {
  const [route, setRoute] = useState(() => ({
    path: filePath,
    hash: storyPageHash(filePath, pendingHash),
    anchor: pendingHash ?? null,
  }));
  if (
    route.path !== filePath ||
    (pendingHash && route.hash !== storyPageHash(filePath, pendingHash))
  ) {
    const next = {
      path: filePath,
      hash: storyPageHash(filePath, pendingHash),
      anchor: pendingHash ?? null,
    };
    setRoute(next);
    return next;
  }
  return route;
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
  const type = useStoryType(props.filePath, props.refreshKey, props.changedPaths);
  const { hash, anchor } = useStoryPageHash(props.filePath, props.pendingHash);
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
        // The page isn't there: this tab is the md's, so it shows the md and says why, rather
        // than a deleted-file placeholder for a page the tab never opened.
        renderMissing={() => (
          <NotedMarkdown
            note={missingStoryPageNote(page)}
            testId="story-page-missing"
            {...props}
            // The host's request was consumed for the page: the md opens at the anchor it kept.
            pendingHash={anchor}
            onPendingHashConsumed={undefined}
          />
        )}
      />
    );
  }
  if (type) return <NotedMarkdown note={NO_STORY_PAGE_NOTE} testId="story-no-page" {...props} />;
  return <MarkdownViewer {...props} />;
}

/** The markdown viewer under a one-line note that says why the file opens as markdown. */
function NotedMarkdown({ note, testId, ...props }: Props & { note: string; testId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p
        role="note"
        data-testid={testId}
        className="border-b px-4 py-2 text-xs text-muted-foreground"
      >
        {note}
      </p>
      <div className="flex min-h-0 flex-1 flex-col">
        <MarkdownViewer {...props} />
      </div>
    </div>
  );
}

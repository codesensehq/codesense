// SPDX-License-Identifier: MIT
/**
 * A diff as a tile's body: one worktree of the story against its base, its changed files down
 * the side and the picked one in today's `SourceDiffPane`. The tab bar holds the rest: the
 * worktree picker, ‹ › (through `diffNavigatorOf`) and ⋯.
 *
 * It reads only while its tile shows it.
 */
import { useCallback, useEffect, useState } from "react";

import type { DiffNavigator } from "@/shared/components/code-editor/CodeDiffReview";
import type { TileBodyContext } from "@/shared/tiling/tile-host";

import { useSourceChangeset, useSourceFileRedline } from "../lib/use-source-diff";
import { SourceDiffPane } from "./source-diff-overlay";
import { diffKeyOfRow, useDiffWorktrees } from "./tile-tab-faces";

/** Each shown diff's change navigator, by tile key, for its bar's ‹ ›. */
const navigators = new Map<string, DiffNavigator>();

/** The change navigator of the diff `tileKey` shows, or null while it shows no file. */
export function diffNavigatorOf(tileKey: string): DiffNavigator | null {
  return navigators.get(tileKey) ?? null;
}

const STATUS_NOTE = "flex h-full items-center justify-center p-6 text-sm text-muted-foreground";

export function DiffTileBody({ tileKey, context }: { tileKey: string; context: TileBodyContext }) {
  const row = useDiffWorktrees().find((r) => diffKeyOfRow(r) === tileKey);
  const repo = row?.repo ?? "";
  const { files, loading, error } = useSourceChangeset(repo, row?.baseRef, context.visible);
  const [picked, setPicked] = useState<string | null>(null);
  const file = files?.find((f) => f.path === picked) ?? files?.[0];
  const { redline, error: redlineError } = useSourceFileRedline(
    repo,
    file?.path ?? null,
    file?.renamedFrom,
    row?.baseRef,
  );

  const { reportLoading } = context;
  useEffect(() => reportLoading(loading), [loading, reportLoading]);
  const navRef = useCallback(
    (nav: DiffNavigator | null) => {
      if (nav) navigators.set(tileKey, nav);
      else navigators.delete(tileKey);
    },
    [tileKey],
  );

  if (!row)
    return (
      <div role="status" className={STATUS_NOTE}>
        This worktree isn't one of the story's.
      </div>
    );
  if (error)
    return (
      <div role="alert" className={STATUS_NOTE}>
        {error}
      </div>
    );
  if (!files) return null;
  if (!file)
    return (
      <div role="status" className={STATUS_NOTE}>
        No changes yet.
      </div>
    );
  return (
    <div className="flex h-full min-h-0">
      <ul aria-label="Changed files" className="w-56 flex-shrink-0 overflow-auto border-r py-1">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              title={f.path}
              aria-current={f === file ? "true" : undefined}
              onClick={() => setPicked(f.path)}
              className={`w-full truncate px-2 py-0.5 text-left text-xs ${
                f === file
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5"
              }`}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1">
        <SourceDiffPane
          filePath={file.path}
          binary={redline?.binary ?? false}
          status={file.status}
          badges={file.badges}
          before={redline?.before ?? null}
          after={redline?.after ?? null}
          error={redlineError}
          inline={false}
          wordWrap={false}
          expandAll={false}
          navRef={navRef}
        />
      </div>
    </div>
  );
}

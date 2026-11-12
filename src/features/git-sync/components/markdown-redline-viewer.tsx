// SPDX-License-Identifier: MIT
import { privateFile } from "@/shared/lib/private-file";
import { useRef } from "react";

import { useHighlightTheme } from "@/features/dashboard/components/markdown-viewer";
import {
  useViewerChrome,
  useViewerScrollKeys,
} from "@/features/dashboard/components/viewer-chrome";
import { useWorktreeRosterStore } from "@/features/viewer/stores/worktree-roster-store";
import { useFileDiffModes } from "@/shared/hooks/use-file-diff-modes";
import { renderFileDiff, type FileDiffState } from "@/shared/lib/render-file-diff";
import { getViewerFileType } from "@/shared/lib/viewer-file-type";
import { useFileRefreshStore } from "@/shared/stores/file-refresh-store";

import { useFileRedline } from "../lib/use-file-redline";
import { ChangedBinaryAffordance } from "./changed-binary-affordance";

/**
 * The Files Changes / History diff for one changed file, of any type.
 * Named for its first job (the rendered-markdown redline); it now hands every
 * type to the shared `renderFileDiff` render tail.
 *
 * This wrapper owns the FETCH (`get_file_redline`, off-thread), which carries
 * what only Files has: live follow on this file's own writes (debounced, only
 * while the tab and window are on screen), PR and landed-commit sides, the
 * pre-rename path, and URL sources for the rendered HTML/image/Excalidraw sides.
 * It reuses the markdown viewer's chrome (scroll keys, width, theme, font, hljs
 * theme) so the redline reads like the normal viewer.
 */
export interface MarkdownRedlineViewerProps {
  /** Context-repo root (`org_root`). */
  orgRoot: string;
  /** Absolute working-tree path of the selected changed file. */
  absPath: string;
  /** Active team + nav repo path (the reload signal is keyed on navRepoPath,
   *  NOT identity repoPath — SW-FX-29). */
  teamKey: string;
  navRepoPath: string;
  /** The team content root the rendered HTML/image/Excalidraw sides are served
   *  under. Without it those types show their source diff. */
  teamContentPath?: string;
  /** SW-GS-14: pre-rename org-root-relative path; set only when the active file
   *  is a rename, so "before" is read from the old baseline path (the moved
   *  doc's content lives there) instead of reading as all-added. */
  oldPath?: string;
  /** When set, diff the file across THIS PR (merge-base blob vs
   *  PR-head blob) instead of baseline-vs-working-tree. NOTE: a rendered image
   *  or HTML before side is still served from the working-tree baseline. */
  prNumber?: number;
  /** When set (and no `prNumber`), diff the file across THIS landed
   *  commit (first-parent blob vs commit blob). Same rendered-side note. */
  commitSha?: string;
  /** Whether this tab is the one on screen (default true). */
  active?: boolean;
}

export function MarkdownRedlineViewer({
  orgRoot,
  absPath,
  teamKey,
  navRepoPath,
  teamContentPath,
  oldPath,
  prNumber,
  commitSha,
  active,
}: MarkdownRedlineViewerProps) {
  const { relPath, read } = useFileRedline({
    orgRoot,
    absPath,
    navRepoPath,
    oldPath,
    prNumber,
    commitSha,
    active,
  });
  // The rendered viewers reload their own file on its writes.
  const refreshKey = useFileRefreshStore((s) => s.fileRefreshKeys[navRepoPath] ?? 0);
  const changedPaths = useFileRefreshStore(
    (s): Set<string> | null => s.lastChangedContextFile[navRepoPath] ?? null,
  );
  const contextWorktree = useWorktreeRosterStore((s) =>
    s.rows?.find((row) => row.kind === "context" && absPath.startsWith(`${row.path}/`)),
  );
  const { modes, setMode } = useFileDiffModes();
  const scrollRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);

  const { widthClass, hasTheme, fontSize } = useViewerChrome();
  useHighlightTheme();
  useViewerScrollKeys(scrollRef, proseRef);

  if (relPath == null) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-sm text-muted-foreground">
        This file is outside the context repo.
      </div>
    );
  }

  const redline = read && "redline" in read ? read.redline : null;
  const state: FileDiffState = !read
    ? { kind: "loading" }
    : "error" in read
      ? { kind: "error", message: read.error }
      : read.redline.binary
        ? { kind: "binary" }
        : { kind: "ready" };

  const header = (
    <>
      {privateFile(absPath) && (
        <div className="mb-4 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>Private · {redline?.baselineSha ?? "last commit"}</span>
          <span>Private · {commitSha ? commitSha.slice(0, 7) : "uncommitted"}</span>
        </div>
      )}
      {redline?.beforeLabel && (
        <div
          className="mb-4 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground"
          data-testid="context-redline-labels"
        >
          <span>{redline.beforeLabel}</span>
          <span>{redline.afterLabel}</span>
        </div>
      )}
    </>
  );

  return (
    <div
      className={`h-full ${hasTheme ? "rounded-none" : ""}`}
      data-testid="markdown-redline-viewer"
    >
      {renderFileDiff({
        fileType: getViewerFileType(absPath),
        filePath: absPath,
        sides: {
          before: redline?.before ?? null,
          after: redline?.after ?? null,
          status: redline?.status,
          beforeLabel: redline?.beforeLabel,
          afterLabel: redline?.afterLabel,
          rendered: teamContentPath
            ? {
                absPath,
                teamContentPath,
                baselineSource: {
                  orgRoot: contextWorktree?.path ?? orgRoot,
                  relPath,
                  tree: redline?.baselineSha,
                },
                refreshKey,
                changedPaths,
              }
            : undefined,
        },
        state,
        prefs: {
          modes,
          onModeChange: setMode,
          prose: {
            ref: proseRef,
            scrollRef,
            frameClassName: `mx-auto px-8 py-6 ${widthClass}`,
            className: "md-viewer-prose cs-redline-prose prose prose-sm max-w-none",
            style: { fontSize },
            header,
          },
          binary: redline ? (
            <ChangedBinaryAffordance
              absPath={absPath}
              status={redline.status}
              teamKey={teamKey}
              navRepoPath={navRepoPath}
            />
          ) : undefined,
        },
      })}
    </div>
  );
}

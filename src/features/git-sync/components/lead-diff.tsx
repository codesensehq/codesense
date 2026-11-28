// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";

import { SourceDiffPane } from "@/features/viewer/components/source-diff-overlay";
import { LineStat } from "@/features/viewer/components/source-diff-rail";
import { useWorktreeRosterStore } from "@/features/viewer/stores/worktree-roster-store";
import { cn } from "@/lib/utils";
import { useOrgStore } from "@/shared/stores/org-store";
import type { ContextWorktreeInfo, WorktreeRow } from "@/tauri/commands";

import { getFileRedline } from "../lib/file-redline-source";
import { getLeadDiff } from "../lib/publish-set-source";
import { useHeadMoves, useShownRead } from "../lib/shown-read";
import type { FileRedline, LeadBranch, LeadDiff as LeadDiffData, LeadDiffFile } from "../lib/types";

const NO_CHANGES = "Diff, no changes yet";

function files(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** The header: "Diff for ‹lead› · ‹N› worktrees, ‹M› files · read-only", where ‹M› is
 *  the sum of each branch's own count. */
function leadDiffHeader(lead: string, diff: LeadDiffData): string {
  const n = diff.branches.length;
  const m = diff.branches.reduce((sum, b) => sum + b.files.length, 0);
  return `Diff for ${lead} · ${n} ${n === 1 ? "worktree" : "worktrees"}, ${files(m)} · read-only`;
}

/** Each of the lead's worktrees as `id\tpath\torg` lines, so a change to another
 *  worktree never re-renders the diff. */
function pathsKey(rows: WorktreeRow[] | null, ids: string): string {
  if (!ids) return "";
  const wanted = new Set(ids.split("\n"));
  return (rows ?? [])
    .filter((r): r is ContextWorktreeInfo => r.kind === "context" && wanted.has(r.id))
    .map((r) => `${r.id}\t${r.path}\t${r.orgSlug}`)
    .join("\n");
}

/** The org roots of `slugs` (newline-joined), as one newline-joined string. */
function rootsKey(orgs: readonly { slug: string; org_root: string }[], slugs: string): string {
  if (!slugs) return "";
  const wanted = new Set(slugs.split("\n"));
  return orgs
    .filter((o) => wanted.has(o.slug) && o.org_root)
    .map((o) => o.org_root)
    .join("\n");
}

/** The open file, by its branch's worktree id and its path, so a new read re-points it. */
interface OpenedKey {
  worktree: string;
  path: string;
}

interface Opened {
  branch: LeadBranch;
  file: LeadDiffFile;
}

function find(diff: LeadDiffData, key: OpenedKey | null): Opened | null {
  if (!key) return null;
  const branch = diff.branches.find((b) => b.worktree === key.worktree);
  const file = branch?.files.find((f) => f.path === key.path);
  return branch && file ? { branch, file } : null;
}

/**
 * A lead's combined, read-only diff: its stories' branches, then its own, each with its
 * files and their + and − counts, and a "‹N› stories" mark on a path several branches
 * change. Opening a file shows its diff on that branch. It reads nothing while hidden.
 * A branch head or ref move under its worktrees' org roots (the only path the app's git
 * watch reports) reads it again while shown, and marks it stale while hidden; an open
 * file reads again with it, and closes when the new diff no longer lists it.
 * Each story merges by its own PR, so there is no merge action here.
 */
export function LeadDiff({
  workItem,
  lead,
  shown,
}: {
  /** The lead's work item id. */
  workItem: string;
  /** The lead's display name ("Sprint 3 lead"). */
  lead: string;
  shown: boolean;
}) {
  const [ids, setIds] = useState("");
  const paths = useWorktreeRosterStore((s) => pathsKey(s.rows, ids));
  const lines = useMemo(
    () =>
      paths
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t") as [string, string, string]),
    [paths],
  );
  const pathOf = useMemo(() => new Map(lines.map(([id, path]) => [id, path])), [lines]);
  const slugs = [...new Set(lines.map(([, , slug]) => slug))].join("\n");
  const roots = useOrgStore((s) => rootsKey(s.orgs, slugs));
  const moves = useHeadMoves(roots);
  const {
    value: diff,
    error,
    stale,
  } = useShownRead(shown, `${workItem}\n${moves}`, () => getLeadDiff(workItem));
  const nextIds = diff?.branches.map((b) => b.worktree).join("\n") ?? "";
  if (nextIds !== ids) setIds(nextIds);

  const [openedKey, setOpenedKey] = useState<OpenedKey | null>(null);
  const opened = diff ? find(diff, openedKey) : null;
  if (diff && openedKey && !opened) setOpenedKey(null);

  if (!shown) return null;
  if (!diff) {
    return (
      <section data-testid="lead-diff" className="p-3 text-[12px] text-muted-foreground">
        {error ?? "Loading the diff…"}
      </section>
    );
  }
  const total = diff.branches.reduce((sum, b) => sum + b.files.length, 0);
  return (
    <section
      data-testid="lead-diff"
      data-stale={stale || undefined}
      className="flex min-h-0 flex-col"
    >
      <header className="border-b px-3 py-2 text-[12px] font-medium">
        {leadDiffHeader(lead, diff)}
      </header>
      {total === 0 && diff.branches.every((b) => !b.deleted) ? (
        <p className="p-3 text-[12px] text-muted-foreground">{NO_CHANGES}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-72 shrink-0 overflow-auto border-r py-1" aria-label="Changed files">
            {diff.branches.map((branch) => (
              <BranchGroup
                key={branch.worktree}
                branch={branch}
                opened={opened}
                onOpen={(file) => setOpenedKey({ worktree: branch.worktree, path: file.path })}
              />
            ))}
          </ul>
          {opened ? (
            <OpenedFile
              diff={diff}
              opened={opened}
              generation={moves}
              repoPath={pathOf.get(opened.branch.worktree) ?? opened.branch.worktree}
              onShow={(branch) =>
                setOpenedKey({ worktree: branch.worktree, path: opened.file.path })
              }
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function BranchGroup({
  branch,
  opened,
  onOpen,
}: {
  branch: LeadBranch;
  opened: Opened | null;
  onOpen: (file: LeadDiffFile) => void;
}) {
  const title = `${branch.branch}${branch.own ? " (the lead's own)" : ""}, ${files(branch.files.length)}`;
  return (
    <li data-testid="lead-diff-branch" className="pb-1">
      <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">{title}</div>
      {branch.deleted ? (
        <p className="px-3 text-[12px] text-muted-foreground">{`${branch.branch} was deleted`}</p>
      ) : branch.error ? (
        <p className="px-3 text-[12px] text-muted-foreground" title={branch.error}>
          {`${branch.branch} couldn't be read`}
        </p>
      ) : branch.files.length === 0 ? (
        <p className="px-3 text-[12px] text-muted-foreground">{NO_CHANGES}</p>
      ) : (
        <ul>
          {branch.files.map((file) => {
            const active =
              opened?.branch.worktree === branch.worktree && opened.file.path === file.path;
            return (
              <li key={file.path}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onOpen(file)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-0.5 text-left text-[12px] hover:bg-[var(--ibx-lifted)]",
                    active && "bg-[var(--ibx-lifted)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  {file.branches > 1 ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">{`${file.branches} stories`}</span>
                  ) : null}
                  <LineStat added={file.added} removed={file.removed} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function OpenedFile({
  diff,
  opened,
  generation,
  repoPath,
  onShow,
}: {
  diff: LeadDiffData;
  opened: Opened;
  /** The lead diff's head-move count: a new one reads the file again. */
  generation: number;
  repoPath: string;
  onShow: (branch: LeadBranch) => void;
}) {
  const { branch, file } = opened;
  const [read, setRead] = useState<{
    key: string;
    redline: FileRedline | null;
    error: string | null;
  }>({
    key: "",
    redline: null,
    error: null,
  });
  const key = `${branch.worktree}\n${file.path}\n${generation}`;
  useEffect(() => {
    let cancelled = false;
    getFileRedline(
      repoPath,
      file.path,
      file.renamedFrom,
      undefined,
      undefined,
      branch.worktree,
    ).then(
      (redline) => {
        if (!cancelled) setRead({ key, redline, error: null });
      },
      (e: unknown) => {
        if (!cancelled)
          setRead({ key, redline: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, repoPath, file.path, file.renamedFrom, branch.worktree]);
  const redline = read.key === key ? read.redline : null;
  const others = diff.branches.filter(
    (b) => b.worktree !== branch.worktree && b.files.some((f) => f.path === file.path),
  );
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="lead-diff-file">
      {others.map((other) => (
        <p key={other.worktree} className="border-b px-3 py-1.5 text-[12px] text-muted-foreground">
          {`${other.branch} also changes this file. `}
          <button type="button" className="underline" onClick={() => onShow(other)}>
            Show its version
          </button>
        </p>
      ))}
      <div className="min-h-0 flex-1 overflow-auto">
        <SourceDiffPane
          filePath={file.path}
          binary={redline?.binary ?? false}
          status={file.status}
          badges={file.badges}
          before={redline?.before ?? null}
          after={redline?.after ?? null}
          error={read.key === key ? read.error : null}
          inline={false}
          wordWrap
          expandAll={false}
        />
      </div>
    </div>
  );
}

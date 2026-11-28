// SPDX-License-Identifier: MIT
/**
 * Each kind's face in a tile's tab bar: its identity sits on the tab and in the bar, and no kind
 * draws a caption of its own. A story page's only pill is its stage; an HTML file shows its
 * source, its team and its unread badge; a diff puts its worktree picker before ‹ ›, which are
 * always drawn, and keeps Open in Finder and Copy path for the picked worktree in ⋯.
 *
 * Faces are pure: the window reads a tab's data and hands it in.
 */
import { createContext, useContext } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DocBadge, DocBadgeSeverity } from "@/features/dashboard/components/html-viewer";
import { dashboardRefOfKey } from "@/features/dashboard/lib/dashboard-ref";
import type { SourceRepo } from "@/features/git-sync/lib/source-redline-source";
import { StageRail } from "@/shared/components/stage-rail";
import { useCopyToClipboard } from "@/shared/hooks/use-copy-to-clipboard";
import { basename } from "@/shared/lib/path";
import { tileKindOf } from "@/shared/tiling/tile-kinds";
import { revealPath } from "@/tauri/commands";

import { MiddleTruncate } from "./middle-truncate";
import type { TileTab } from "./tile-tab-bar";

/** A story page: its title, with its stage as the only pill. */
export function storyTabFace({
  key,
  storyId,
  title,
  status,
}: {
  key: string;
  storyId: string;
  title?: string | null;
  /** The story's status id; unset while it is read. */
  status?: string | null;
}): TileTab {
  const name = title || storyId;
  return {
    key,
    kind: "story",
    name,
    fullName: title ? `${storyId} ${title}` : storyId,
    badge: status ? <StageRail status={status} size={12} labelled /> : undefined,
  };
}

/** A file in a team's content: its name, its path in full. */
export function fileTabFace({ key, path }: { key: string; path: string }): TileTab {
  return { key, kind: "file", name: basename(path), fullName: path };
}

/** An HTML file: its title and where it comes from, its team's chip and its unread badge. */
export function htmlTabFace({
  key,
  name,
  source,
  team,
  badge,
}: {
  key: string;
  name: string;
  /** Where the file comes from: its team's content, a pane folder, a pack. */
  source: string;
  /** Its team, for a file from another team than the one on screen. */
  team?: string | null;
  badge?: DocBadge | null;
}): TileTab {
  const unread = badge && badge.count > 0 ? unreadLabel(badge) : null;
  return {
    key,
    kind: "file",
    name,
    fullName: [`${name} · ${source}`, team, unread].filter(Boolean).join(" · "),
    badge: badge && badge.count > 0 ? <UnreadBadge badge={badge} /> : undefined,
    chip: team ? <TeamChip team={team} /> : undefined,
  };
}

/** A diff: the picked worktree's branch. */
export function diffTabFace({ key, row }: { key: string; row?: DiffWorktreeRow }): TileTab {
  return {
    key,
    kind: "diff",
    name: row ? `Diff ${row.branch}` : "Diff",
    fullName: row ? `Diff ${worktreeLabel(row)}` : undefined,
  };
}

/** A tab's face from its key alone, for a tab whose data the window has not read. */
export function tabFaceOfKey(key: string): TileTab {
  const kind = tileKindOf(key);
  switch (kind) {
    case "dashboard": {
      const ref = dashboardRefOfKey(key);
      const owner = ref?.scope === "team" ? ref.team : ref?.org;
      return { key, kind, name: ref?.id ?? key, fullName: ref ? `${ref.id} · ${owner}` : key };
    }
    case "file": {
      const [, team = "", path = key] = /^doc:([^/]+)\/(.+)$/.exec(key) ?? [];
      return /\.html?$/i.test(path)
        ? htmlTabFace({ key, name: basename(path), source: team })
        : fileTabFace({ key, path });
    }
    case "story":
      return storyTabFace({ key, storyId: key.slice("story-page:".length) });
    case "diff":
      return diffTabFace({ key });
    case "notes":
      return { key, kind, name: "Notes" };
    case "inbox":
      return { key, kind, name: "Inbox", fullName: `Inbox · ${key.slice("inbox:".length)}` };
    case "agent":
      return {
        key,
        kind,
        name: key.slice(key.indexOf("/") + 1),
        fullName: key.slice("agent:".length),
      };
    case "shell":
      return { key, kind, name: key };
  }
}

const SEVERITY_CLASS: Record<DocBadgeSeverity, string> = {
  info: "bg-muted text-muted-foreground",
  warning: "bg-warning-wash text-warning-ink",
  error: "bg-destructive/20 text-destructive",
};

function unreadLabel(badge: DocBadge): string {
  return badge.severity === "info"
    ? `${badge.count} unread`
    : `${badge.count} unread, ${badge.severity}`;
}

function UnreadBadge({ badge }: { badge: DocBadge }) {
  return (
    <span
      data-tile-tab-badge=""
      data-severity={badge.severity}
      aria-hidden
      className={`rounded-full px-1.5 text-[0.65rem] font-medium ${SEVERITY_CLASS[badge.severity]}`}
    >
      {badge.count > 99 ? "99+" : badge.count}
    </span>
  );
}

function TeamChip({ team }: { team: string }) {
  return (
    <span aria-hidden className="rounded bg-foreground/5 px-1 text-[0.65rem] text-muted-foreground">
      {team}
    </span>
  );
}

/** HTML's identity in the bar: where the file comes from, cut off before the controls. */
export function HtmlSourceIdentity({ source }: { source: string }) {
  return <MiddleTruncate text={source} title={source} aria-label={source} className="min-w-0" />;
}

/** One worktree a story's diff can show, as the story's worktree list gives it. */
export interface DiffWorktreeRow {
  kind: "context" | "source";
  id: string;
  branch: string;
  /** Files changed against main; null while uncounted or its machine is offline. */
  files: number | null;
  path: string;
  /** The machine it is on; unset on this Mac. */
  machine?: string;
  /** The machine's offline state, while it is offline. */
  offline?: string;
  /** Where the diff reads it. */
  repo: SourceRepo;
  /** The ref it is compared against. Unset, the worktree's own base. */
  baseRef?: string;
}

/** A story's worktrees, handed down by the window until the story's own list is read here. */
export const DiffWorktreesContext = createContext<readonly DiffWorktreeRow[]>([]);

export function useDiffWorktrees(): readonly DiffWorktreeRow[] {
  return useContext(DiffWorktreesContext);
}

/** The key of the diff tab that shows `row`. */
export const diffKeyOfRow = (row: Pick<DiffWorktreeRow, "kind" | "id">) =>
  `diff:${row.kind}:${row.id}`;

/** A row as the picker names it: "branch (context)", or "machine, branch" for a machine's. */
function worktreeLabel(row: DiffWorktreeRow): string {
  return row.machine ? `${row.machine}, ${row.branch}` : `${row.branch} (${row.kind})`;
}

/** What a row says after its name: its file count, "remote", or its machine's offline state. */
function worktreeNote(row: DiffWorktreeRow): string {
  if (row.offline) return row.offline;
  const count = row.files === null ? null : `${row.files} ${row.files === 1 ? "file" : "files"}`;
  return [count, row.machine ? "remote" : null].filter(Boolean).join(", ");
}

/** The diff's worktree picker: a menu button over the story's worktrees, before ‹ ›. */
export function DiffWorktreePicker({
  rows,
  picked,
  onPick,
}: {
  rows: readonly DiffWorktreeRow[];
  picked?: DiffWorktreeRow;
  onPick(row: DiffWorktreeRow): void;
}) {
  const label = picked ? worktreeLabel(picked) : "Pick a worktree";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Worktree: ${label}`}
          title={picked ? `${label} · ${picked.path}` : label}
          data-tile-diff-picker=""
          className="flex min-w-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          <MiddleTruncate text={label} className="min-w-0" />
          <ChevronDown size={11} className="flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {rows.map((row) => {
          const note = worktreeNote(row);
          return (
            <DropdownMenuItem
              key={diffKeyOfRow(row)}
              aria-current={row === picked ? "true" : undefined}
              onSelect={() => onPick(row)}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span>{worktreeLabel(row)}</span>
              {note && <span className="text-muted-foreground">{note}</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NAV_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-40";

/** The diff's ‹ ›, always drawn: they step through the shown file's changes. */
export function DiffNavControls({
  onPrev,
  onNext,
  disabled,
}: {
  onPrev(): void;
  onNext(): void;
  /** No file shown, or one without changes. */
  disabled?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Previous change"
        title="Previous change"
        disabled={disabled}
        onClick={onPrev}
        className={NAV_BUTTON}
      >
        <ChevronLeft size={12} />
      </button>
      <button
        type="button"
        aria-label="Next change"
        title="Next change"
        disabled={disabled}
        onClick={onNext}
        className={NAV_BUTTON}
      >
        <ChevronRight size={12} />
      </button>
    </>
  );
}

/** The diff's ⋯ items, for the picked worktree: Open in Finder for one on this Mac, Copy path
 *  for every one ("On ‹machine›" for a machine's, copying the machine's path). */
export function DiffTabMenu({ row }: { row?: DiffWorktreeRow }) {
  const { handleCopy } = useCopyToClipboard();
  if (!row) return null;
  return (
    <>
      {!row.machine && (
        <DropdownMenuItem onSelect={() => void revealPath(row.path)}>
          Open in Finder
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => handleCopy(row.path)}>
        {row.machine ? `Copy path · On ${row.machine}` : "Copy path"}
      </DropdownMenuItem>
    </>
  );
}

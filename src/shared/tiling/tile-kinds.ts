// SPDX-License-Identifier: MIT
/**
 * The kinds of tile a tab can hold, the ref that names each one, the tile key a ref is held by,
 * and the one check of opening a ref as a tab.
 *
 * Every kind is a tab in any tile: a tile is a tab group and its bar never nests. Opening is
 * refused only for a `{kind:"workspace"}` ref (a workspace is shown, never placed), and for a
 * terminal that is live in another tile (one live copy). A ref already open focuses its tab
 * instead of adding a second. A terminal in the CLI workspace may move into a tile: it leaves
 * the CLI workspace and keeps its PTY.
 *
 * Pure and kind-agnostic about bodies: a key names a tile, and the window decides what renders it.
 */

export type TileKind =
  | "dashboard"
  | "file"
  | "story"
  | "diff"
  | "notes"
  | "inbox"
  | "agent"
  | "shell";

/** A dashboard's identity, as the app's `DashboardRef` names it. */
interface DashboardTileRef {
  scope: "built-in" | "team" | "private";
  org: string;
  team?: string;
  id: string;
}

export type TileRef =
  | { kind: "dashboard"; ref: DashboardTileRef }
  | { kind: "file"; team: string; path: string }
  | { kind: "story"; storyId: string }
  | { kind: "diff"; worktree: { kind: "context" | "source"; id: string } }
  | { kind: "notes"; id?: string }
  | { kind: "inbox"; org: string }
  | { kind: "agent"; team: string; name: string }
  | { kind: "shell"; tabId: string };

export const TILE_KINDS: readonly TileKind[] = [
  "dashboard",
  "file",
  "story",
  "diff",
  "notes",
  "inbox",
  "agent",
  "shell",
];

/** Why a workspace ref is refused. */
export const WORKSPACE_REF_REASON =
  "A workspace is not a tile. Show it with group_show or open_workspace.";
/** Why a second live copy of a terminal is refused. */
export const LIVE_ELSEWHERE_REASON = "This terminal is already open in another tile.";

const NOTES_DEFAULT = "scratch";

/** The key a ref is held by in a tile's tabs. */
export function tileKeyOf(ref: TileRef): string {
  switch (ref.kind) {
    case "dashboard": {
      const { scope, org, team, id } = ref.ref;
      return `dashboard:${scope}:${org}${scope === "team" ? `:${team}` : ""}/${id}`;
    }
    case "file":
      return `doc:${ref.team}/${ref.path}`;
    case "story":
      return `story-page:${ref.storyId}`;
    case "diff":
      return `diff:${ref.worktree.kind}:${ref.worktree.id}`;
    case "notes":
      return `notes:${ref.id ?? NOTES_DEFAULT}`;
    case "inbox":
      return `inbox:${ref.org}`;
    case "agent":
      return `agent:${ref.team}/${ref.name}`;
    case "shell":
      return ref.tabId;
  }
}

const PREFIXES: readonly [string, TileKind][] = [
  ["dashboard:", "dashboard"],
  ["doc:", "file"],
  ["story-page:", "story"],
  ["diff:", "diff"],
  ["notes:", "notes"],
  ["inbox:", "inbox"],
  ["agent:", "agent"],
];

/** The kind of the tab a key names. An unprefixed key is a terminal tab id. */
export function tileKindOf(key: string): TileKind {
  for (const [prefix, kind] of PREFIXES) if (key.startsWith(prefix)) return kind;
  return "shell";
}

/** Whether a kind's body is a terminal, held to one live copy. */
function isTerminalKind(kind: TileKind): boolean {
  return kind === "agent" || kind === "shell";
}

export type TileRefParse = { ok: true; ref: TileRef } | { ok: false; reason: string };

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Reads a ref from an untrusted value: an MCP argument, a drop payload or a saved tab. */
export function parseTileRef(value: unknown): TileRefParse {
  if (typeof value !== "object" || value === null) return refused("A tile ref is an object.");
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "workspace":
      return refused(WORKSPACE_REF_REASON);
    case "dashboard": {
      const ref = v.ref as Record<string, unknown> | null | undefined;
      const scope = ref?.scope;
      if (scope !== "built-in" && scope !== "team" && scope !== "private")
        return refused("A dashboard ref needs a scope: built-in, team or private.");
      if (!isText(ref?.org) || !isText(ref?.id))
        return refused("A dashboard ref needs an org and an id.");
      if (scope === "team" && !isText(ref?.team))
        return refused("A team dashboard ref needs its team.");
      const team = scope === "team" ? { team: ref?.team as string } : {};
      return {
        ok: true,
        ref: { kind: "dashboard", ref: { scope, org: ref.org, ...team, id: ref.id } },
      };
    }
    case "file":
      if (!isText(v.team) || !isText(v.path)) return refused("A file ref needs a team and a path.");
      return { ok: true, ref: { kind: "file", team: v.team, path: v.path } };
    case "story":
      if (!isText(v.storyId)) return refused("A story ref needs a storyId.");
      return { ok: true, ref: { kind: "story", storyId: v.storyId } };
    case "diff": {
      const worktree = v.worktree as Record<string, unknown> | null | undefined;
      const kind = worktree?.kind;
      if ((kind !== "context" && kind !== "source") || !isText(worktree?.id))
        return refused("A diff ref needs a context or source worktree and its id.");
      return { ok: true, ref: { kind: "diff", worktree: { kind, id: worktree.id } } };
    }
    case "notes":
      if (v.id !== undefined && !isText(v.id)) return refused("A notes id is text.");
      return {
        ok: true,
        ref: v.id === undefined ? { kind: "notes" } : { kind: "notes", id: v.id },
      };
    case "inbox":
      if (!isText(v.org)) return refused("An inbox ref needs its org.");
      return { ok: true, ref: { kind: "inbox", org: v.org } };
    case "agent":
      if (!isText(v.team) || !isText(v.name))
        return refused("An agent ref needs a team and a name.");
      return { ok: true, ref: { kind: "agent", team: v.team, name: v.name } };
    case "shell":
      if (!isText(v.tabId)) return refused("A shell ref needs its tabId.");
      return { ok: true, ref: { kind: "shell", tabId: v.tabId } };
    default:
      return refused(`No tile kind ${JSON.stringify(v.kind)}.`);
  }
}

function refused(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Where a terminal's one live copy is, if it is live. */
export type TerminalPlace = { where: "cli-workspace" } | { where: "tile"; cell: string };

export interface TileOpenContext {
  /** The tile the ref opens in. */
  cell: string;
  /** The cell of the shown group already holding a key as a tab, or null. */
  cellHolding(key: string): string | null;
  /** Where a terminal key is live: the CLI workspace, a tile of the shown group, or another
   *  tile anywhere (`cell` is then one the shown group does not hold). Null when not live. */
  terminalPlace(key: string): TerminalPlace | null;
}

export type TileOpenCheck =
  | { status: "open"; ref: TileRef; key: string; leavesCliWorkspace: boolean }
  | { status: "focus"; key: string; cell: string }
  | { status: "refused"; reason: string };

/** The one check of opening a value as a tab of `context.cell`. */
export function checkTileOpen(value: unknown, context: TileOpenContext): TileOpenCheck {
  const parsed = parseTileRef(value);
  if (!parsed.ok) return { status: "refused", reason: parsed.reason };
  const key = tileKeyOf(parsed.ref);
  const holder = context.cellHolding(key);
  if (holder !== null) return { status: "focus", key, cell: holder };
  let leavesCliWorkspace = false;
  if (isTerminalKind(parsed.ref.kind)) {
    const place = context.terminalPlace(key);
    if (place?.where === "tile") return { status: "refused", reason: LIVE_ELSEWHERE_REASON };
    leavesCliWorkspace = place?.where === "cli-workspace";
  }
  return { status: "open", ref: parsed.ref, key, leavesCliWorkspace };
}

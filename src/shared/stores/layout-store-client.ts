// SPDX-License-Identifier: MIT
/**
 * The window store's copy of its layouts in the group files, with the tiles flag on. A team's
 * foreground (or one rail of it) and a workspace's tab grid each live in one group file: the
 * window reads it at launch (`hydrateLayouts`) and saves each gesture as kit ops with
 * `group_commit` (`saveLayout`), never by writing a file. The screen updates from the store at
 * once; the commit runs behind it.
 *
 * Resize steps on one split coalesce, last wins, into one commit per 100 ms;
 * `flushGroupCommits` sends what is pending now (gesture end, window close). A conflict reloads
 * the head and replays the ops on it, unless an agent's write touched the same tiles
 * (`collided`): then the window shows the head and drops the ops, and the person repeats the
 * gesture. Any reply other than the next rev means another writer was folded in, so the window
 * re-reads the head and shows it.
 *
 * With the flag off nothing here reads or writes a group file, and `app-state.json` keeps the
 * layout as before.
 */
import { tilesEnabled } from "@/shared/lib/tiles-enabled";
import { parseTeamKey } from "@/shared/lib/parse-team-key";
import { parseWorkspaceKey } from "@/shared/lib/workspace-key";
import { applyKitOp, KIT_OP_FAILED } from "@/shared/tiling/apply-kit-op";
import type { KitOp } from "@/shared/tiling/kit-op";
import { parseMosaicNode, type MosaicNode } from "@/shared/tiling/mosaic-tree";
import { groupCommit, groupRead, type GroupFileRef } from "@/tauri/commands";
import type { ViewerState } from "./viewer-store";

/** The layout a group file holds: a team's foreground (`railKey` null when flat, else the
 *  rail's key) or the tab grid of the workspace with that store key. */
export type LayoutTarget =
  | { kind: "foreground"; teamKey: string; railKey: string | null }
  | { kind: "tabGrid"; workspaceKey: string };

/** The window store's slices this client reads and seeds. */
export type LayoutSlices = Pick<
  ViewerState,
  "workspaces" | "foregroundLayout" | "foregroundLayoutByRail" | "tabGridLayout"
>;

/** Applies a seed to the window store. */
type Seed = (update: (s: LayoutSlices) => Partial<LayoutSlices>) => void;

const COALESCE_MS = 100;
/** Hex digits of the sha-256 kept in a file id. */
const ID_HEX = 32;

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, ID_HEX);
}

/** The org and group file of `target`. The twin of `groups::file_id` in Rust; both read
 *  `tests/fixtures/group-file-ids.json`. */
export async function layoutFileRef(
  target: LayoutTarget,
): Promise<{ org: string; file: GroupFileRef }> {
  if (target.kind === "foreground") {
    const { teamKey, railKey } = target;
    const id = await digest(railKey === null ? teamKey : `${teamKey}\n${railKey}`);
    return { org: parseTeamKey(teamKey).orgSlug, file: { owner: "group", id: `fg-${id}` } };
  }
  const teamKey = parseWorkspaceKey(target.workspaceKey)?.teamKey ?? target.workspaceKey;
  const id = await digest(target.workspaceKey);
  return { org: parseTeamKey(teamKey).orgSlug, file: { owner: "workspace", id: `ws-${id}` } };
}

function firstLeaf(node: MosaicNode): string {
  return node.kind === "leaf" ? node.id : firstLeaf(node.children[0]);
}

/** Ops that build `root` from no tree: place its first leaf, split each leaf off its left
 *  sibling, then set every split's sizes. */
export function buildOps(root: MosaicNode | null): KitOp[] {
  if (!root) return [];
  const ops: KitOp[] = [{ op: "place", leafId: firstLeaf(root) }];
  const grow = (node: MosaicNode) => {
    if (node.kind === "leaf") return;
    for (let i = 1; i < node.children.length; i++) {
      ops.push({
        op: "splitAt",
        targetLeafId: firstLeaf(node.children[i - 1]),
        axis: node.axis,
        side: "after",
        leafId: firstLeaf(node.children[i]),
      });
    }
    node.children.forEach(grow);
  };
  const size = (node: MosaicNode, path: number[]) => {
    if (node.kind === "leaf") return;
    ops.push({ op: "resize", path, sizes: node.sizes });
    node.children.forEach((child, i) => size(child, [...path, i]));
  };
  grow(root);
  size(root, []);
  return ops;
}

function applyAll(root: MosaicNode | null, ops: KitOp[]): MosaicNode | null | typeof KIT_OP_FAILED {
  let at = root;
  for (const op of ops) {
    const next = applyKitOp(at, op);
    if (next === KIT_OP_FAILED) return KIT_OP_FAILED;
    at = next;
  }
  return at;
}

/** Two trees alike but for float noise in their sizes. */
function sameTree(a: MosaicNode | null, b: MosaicNode | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "leaf" || b.kind === "leaf") {
    return a.kind === "leaf" && b.kind === "leaf" && a.id === b.id;
  }
  return (
    a.axis === b.axis &&
    a.children.length === b.children.length &&
    a.sizes.every((s, i) => Math.abs(s - b.sizes[i]) < 1e-6) &&
    a.children.every((child, i) => sameTree(child, b.children[i]))
  );
}

interface LayoutFile {
  target: LayoutTarget;
  org: string;
  file: GroupFileRef;
  /** The head as the window last read or wrote it. */
  rev: number;
  tree: MosaicNode | null;
  /** The tree with the pending resizes applied. */
  shown: MosaicNode | null;
  /** Coalesced resizes by split path, sent in the order first seen. */
  pending: Map<string, KitOp>;
  timer: ReturnType<typeof setTimeout> | null;
}

let files = new Map<string, LayoutFile>();
let lane: Promise<void> = Promise.resolve();
let seed: Seed | null = null;

/** Runs `step` after every step before it, so ops reach a file in the order they were made. */
function inLane(step: () => Promise<void>): Promise<void> {
  lane = lane.then(step).catch((error) => console.error("group commit failed", error));
  return lane;
}

const targetKey = (t: LayoutTarget) =>
  t.kind === "foreground" ? `fg\n${t.teamKey}\n${t.railKey ?? "\0"}` : `ws\n${t.workspaceKey}`;

async function readHead(f: LayoutFile): Promise<void> {
  const head = await groupRead(f.org, f.file);
  f.rev = head?.rev ?? 0;
  f.tree = parseMosaicNode(head?.tree ?? null);
  f.shown = f.tree;
}

async function fileFor(target: LayoutTarget): Promise<LayoutFile> {
  const key = targetKey(target);
  const known = files.get(key);
  if (known) return known;
  const ref = await layoutFileRef(target);
  const f: LayoutFile = {
    target,
    ...ref,
    rev: 0,
    tree: null,
    shown: null,
    pending: new Map(),
    timer: null,
  };
  await readHead(f);
  files.set(key, f);
  return f;
}

/** The store's slices with `target` showing `root`. */
function seeded(
  s: LayoutSlices,
  target: LayoutTarget,
  root: MosaicNode | null,
): Partial<LayoutSlices> {
  if (target.kind === "tabGrid") {
    const saved = s.tabGridLayout[target.workspaceKey];
    if (!saved || root?.kind !== "split") return {};
    return { tabGridLayout: { ...s.tabGridLayout, [target.workspaceKey]: { ...saved, root } } };
  }
  const { teamKey, railKey } = target;
  const layout = (prior: ViewerState["foregroundLayout"][string] | undefined) => ({
    sizes: prior?.sizes ?? [],
    direction: prior?.direction ?? ("row" as const),
    preset: root ? ("custom" as const) : (prior?.preset ?? ("columns" as const)),
    root,
  });
  if (railKey === null) {
    return {
      foregroundLayout: { ...s.foregroundLayout, [teamKey]: layout(s.foregroundLayout[teamKey]) },
    };
  }
  const rails = s.foregroundLayoutByRail[teamKey] ?? {};
  return {
    foregroundLayoutByRail: {
      ...s.foregroundLayoutByRail,
      [teamKey]: { ...rails, [railKey]: layout(rails[railKey]) },
    },
  };
}

function show(f: LayoutFile) {
  const root = f.tree;
  seed?.((s) => seeded(s, f.target, root));
}

/** Sends `ops` on the file's rev and settles the reply. */
async function commit(f: LayoutFile, ops: KitOp[]): Promise<void> {
  const base = f.rev;
  const reply = await groupCommit(f.org, f.file, base, ops);
  if ("rev" in reply) {
    const after = applyAll(f.tree, ops);
    if (reply.rev === base + 1 && after !== KIT_OP_FAILED) {
      f.rev = reply.rev;
      f.tree = after;
      f.shown = applyAll(after, [...f.pending.values()]) as MosaicNode | null;
      return;
    }
    await readHead(f);
    show(f);
    return;
  }
  await readHead(f);
  if (!reply.conflict.collided) {
    const replayed = await groupCommit(f.org, f.file, f.rev, ops);
    const after = applyAll(f.tree, ops);
    if ("rev" in replayed && replayed.rev === f.rev + 1 && after !== KIT_OP_FAILED) {
      f.rev = replayed.rev;
      f.tree = after;
      f.shown = after;
    } else {
      await readHead(f);
    }
  }
  show(f);
}

async function sendPending(f: LayoutFile): Promise<void> {
  if (f.timer !== null) clearTimeout(f.timer);
  f.timer = null;
  if (f.pending.size === 0) return;
  const ops = [...f.pending.values()];
  f.pending.clear();
  await commit(f, ops);
}

/**
 * Saves `next`, the layout `target` now shows, made by `gesture`. A resize waits up to 100 ms
 * for the steps after it; any other gesture sends at once. When `gesture` doesn't make `next`
 * from what the file holds (no file yet, or no gesture), the ops close what it holds and
 * build `next`.
 */
export function saveLayout(target: LayoutTarget, next: MosaicNode | null, gesture?: KitOp): void {
  void inLane(async () => {
    if (!(await tilesEnabled())) return;
    const f = await fileFor(target);
    const made = gesture ? applyAll(f.shown, [gesture]) : KIT_OP_FAILED;
    if (gesture?.op === "resize" && made !== KIT_OP_FAILED && sameTree(made, next)) {
      f.pending.set(JSON.stringify(gesture.path), gesture);
      f.shown = made;
      f.timer ??= setTimeout(() => void inLane(() => sendPending(f)), COALESCE_MS);
      return;
    }
    await sendPending(f);
    if (sameTree(f.tree, next)) return;
    const ops =
      gesture && made !== KIT_OP_FAILED && sameTree(made, next)
        ? [gesture]
        : [
            ...(f.tree ? leafIds(f.tree).map((leafId): KitOp => ({ op: "close", leafId })) : []),
            ...buildOps(next),
          ];
    f.shown = next;
    await commit(f, ops);
  });
}

function leafIds(node: MosaicNode): string[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIds);
}

/**
 * Sends every pending coalesced commit now (of every file, or of `target`'s) and resolves when
 * each reply has come back, a conflict's after its reload and replay. With nothing pending it
 * resolves with no call.
 */
export function flushGroupCommits(target?: LayoutTarget): Promise<void> {
  return inLane(async () => {
    const key = target && targetKey(target);
    for (const [k, f] of files) if (key === undefined || k === key) await sendPending(f);
  });
}

/** The layouts `state` holds: each team's foreground and rails, and each saved tab grid. */
function targetsOf(state: LayoutSlices): LayoutTarget[] {
  const teams = new Set([...Object.keys(state.workspaces), ...Object.keys(state.foregroundLayout)]);
  return [
    ...[...teams].map((teamKey): LayoutTarget => ({ kind: "foreground", teamKey, railKey: null })),
    ...Object.entries(state.foregroundLayoutByRail).flatMap(([teamKey, rails]) =>
      Object.keys(rails).map((railKey): LayoutTarget => ({ kind: "foreground", teamKey, railKey })),
    ),
    ...Object.keys(state.tabGridLayout).map(
      (workspaceKey): LayoutTarget => ({ kind: "tabGrid", workspaceKey }),
    ),
  ];
}

/**
 * Reads the group file of every layout `state` holds and shows each tree found through `set`,
 * which also shows a head a later conflict reloads. A layout with no group file keeps what
 * `app-state.json` restored.
 */
export function hydrateLayouts(state: LayoutSlices, set: Seed): Promise<void> {
  return inLane(async () => {
    if (!(await tilesEnabled())) return;
    seed = set;
    for (const target of targetsOf(state)) {
      const f = await fileFor(target);
      if (f.tree) show(f);
    }
  });
}

/** Forgets every file and pending commit, so a test starts clean. */
export function resetLayoutClientForTests(): void {
  for (const f of files.values()) if (f.timer !== null) clearTimeout(f.timer);
  files = new Map();
  lane = Promise.resolve();
  seed = null;
}

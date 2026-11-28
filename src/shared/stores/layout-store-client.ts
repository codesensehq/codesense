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
 * gesture. A replay that conflicts again is replayed on the newer head, three times at most,
 * then dropped and logged; a commit that fails outright re-reads the head and shows it. Any reply other than the next rev means another writer was folded in, so the window
 * re-reads the head and shows it.
 *
 * Another writer's change (an agent's ops) arrives through the host's live hub: the window
 * watches each file it shows on the host-only `group` topic and each org's index on `groups`,
 * and applies a newer head to that layout's slice alone, with its pending resizes on top. A
 * head the window already shows changes nothing in the store, so no mounted tile re-renders.
 *
 * With the flag on, `app-state.json` keeps the roots it held at launch as a read-only fallback:
 * `savedRoot` hands them back to the store's persist, so its bytes for them never change. With
 * the flag off nothing here reads or writes a group file, and `app-state.json` saves the layout
 * as before.
 */
import { tilesEnabled } from "@/shared/lib/tiles-enabled";
import { logger } from "@/shared/lib/logger";
import { parseTeamKey } from "@/shared/lib/parse-team-key";
import { parseWorkspaceKey } from "@/shared/lib/workspace-key";
import { applyKitOp, KIT_OP_FAILED } from "@/shared/tiling/apply-kit-op";
import type { KitOp } from "@/shared/tiling/kit-op";
import {
  parseMosaicNode,
  serializeMosaicNode,
  type MosaicNode,
  type SavedMosaicNode,
} from "@/shared/tiling/mosaic-tree";
import { groupCommit, groupRead, type GroupFileRef } from "@/tauri/commands";
import type { HubRow } from "@/features/dashboard/lib/live-hub";
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
/** Replays of one gesture on a newer head before it is dropped. */
const REPLAYS = 3;
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
/** The roots `app-state.json` held at launch, by `slotKey`; set once the flag reads on. */
let launchRoots: Map<string, unknown> | null = null;
/** Stops each live-hub watch the client holds. */
let watches: Array<() => void> = [];
/** The orgs whose `groups` view is watched. */
let watchedOrgs = new Set<string>();

/** A saved layout slot: the store slice that holds it (a rail's slice names its team too) and
 *  its key there. */
const slotKey = (slice: string, key: string) => `${slice}\n${key}`;

/** Every saved root in `viewer`, the viewer section `app-state.json` held at launch. */
function rootsOf(viewer: Record<string, unknown>): Map<string, unknown> {
  const roots = new Map<string, unknown>();
  const record = (v: unknown) =>
    (v && typeof v === "object" ? v : {}) as Record<string, { root?: unknown } | undefined>;
  const add = (slice: string, layouts: unknown) => {
    for (const [key, layout] of Object.entries(record(layouts))) {
      if (layout && typeof layout === "object" && "root" in layout) {
        roots.set(slotKey(slice, key), layout.root);
      }
    }
  };
  add("foregroundLayout", viewer.foregroundLayout);
  for (const [teamKey, rails] of Object.entries(record(viewer.foregroundLayoutByRail))) {
    add(slotKey("foregroundLayoutByRail", teamKey), rails);
  }
  add("tabGridLayout", viewer.terminalTabGridSizes);
  return roots;
}

/**
 * The root the store's persist saves for slot `key` of `slice`: with the flag on, the one
 * `app-state.json` held at launch (none for a slot it didn't hold); else `root`, saved.
 */
export function savedRoot(
  slice: string,
  key: string,
  root: MosaicNode | null,
): SavedMosaicNode | null {
  if (!launchRoots) return serializeMosaicNode(root);
  return (launchRoots.get(slotKey(slice, key)) ?? null) as SavedMosaicNode | null;
}

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
  await watchFile(f);
  return f;
}

/** Watches the host's view of `f`'s file and, once per org, of its org's index. The hub is
 *  loaded on first use: the window store reaches this module before the hub is built. */
async function watchFile(f: LayoutFile): Promise<void> {
  const { liveHub } = await import("@/features/dashboard/lib/live-hub");
  watches.push(
    liveHub.watch("group", `${f.org}:${f.file.id}`, (view) => {
      void inLane(() => applyFile(f, view.snapshot[0]));
    }),
  );
  if (watchedOrgs.has(f.org)) return;
  watchedOrgs.add(f.org);
  const org = f.org;
  watches.push(
    liveHub.watch("groups", org, (view) => {
      void inLane(() => applyIndex(org, view.snapshot));
    }),
  );
}

/** Shows `f`'s head with its pending resizes on top, unless that is `before`, what the store
 *  already shows. */
function reshow(f: LayoutFile, before: MosaicNode | null): void {
  const after = applyAll(f.tree, [...f.pending.values()]);
  f.shown = after === KIT_OP_FAILED ? f.tree : after;
  if (!sameTree(before, f.shown)) show(f);
}

/** Applies the `group` view's row for `f`: a newer file, or no file (re-read). A row the store
 *  can't read keeps what the window shows. */
async function applyFile(f: LayoutFile, row: HubRow | undefined): Promise<void> {
  if (row && "unreadable" in row) return;
  const before = f.shown;
  const file = row?.file as { rev: number; root: unknown } | undefined;
  if (!file) {
    if (f.rev === 0) return;
    await readHead(f);
  } else {
    if (file.rev <= f.rev) return;
    f.rev = file.rev;
    f.tree = parseMosaicNode(file.root);
  }
  reshow(f, before);
}

/** Re-reads each file of `org` whose index row is past the rev the window holds. */
async function applyIndex(org: string, rows: HubRow[]): Promise<void> {
  for (const f of files.values()) {
    if (f.org !== org) continue;
    const row = rows.find((r) => r.id === f.file.id);
    if (typeof row?.rev !== "number" || row.rev <= f.rev) continue;
    const before = f.shown;
    await readHead(f);
    reshow(f, before);
  }
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
  const root = f.shown;
  seed?.((s) => seeded(s, f.target, root));
}

/** Sends `ops` on the file's rev and settles the reply. A commit that throws re-reads the
 *  head and shows it, so the next save goes out on a rev the store holds. */
async function commit(f: LayoutFile, ops: KitOp[]): Promise<void> {
  try {
    if (await place(f, ops)) return;
  } catch (error) {
    logger.warn("tiling", `A layout change wasn't saved: ${String(error)}`);
    await readHead(f);
  }
  show(f);
}

/**
 * Sends `ops` on the file's rev, and after each plain conflict reloads the head and replays them
 * on it, up to {@link REPLAYS} times; past that the gesture is dropped and logged. True when the
 * first send placed them as the next rev, which the screen already shows; else the file holds
 * the head to show.
 */
async function place(f: LayoutFile, ops: KitOp[]): Promise<boolean> {
  for (let replay = 0; ; replay++) {
    const base = f.rev;
    const reply = await groupCommit(f.org, f.file, base, ops);
    if ("rev" in reply) {
      const after = applyAll(f.tree, ops);
      if (reply.rev !== base + 1 || after === KIT_OP_FAILED) {
        await readHead(f);
        return false;
      }
      f.rev = reply.rev;
      f.tree = after;
      const shown = applyAll(after, [...f.pending.values()]);
      f.shown = shown === KIT_OP_FAILED ? after : shown;
      return replay === 0;
    }
    await readHead(f);
    if (reply.conflict.collided) return false;
    if (replay === REPLAYS) {
      logger.warn("tiling", `A layout change was dropped after ${REPLAYS} conflicting replays`);
      return false;
    }
  }
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
 * `app-state.json` restored. `launch` is the viewer section `app-state.json` held, whose roots
 * the store then saves unchanged.
 */
export function hydrateLayouts(
  state: LayoutSlices,
  set: Seed,
  launch: Record<string, unknown> = {},
): Promise<void> {
  return inLane(async () => {
    if (!(await tilesEnabled())) return;
    launchRoots = rootsOf(launch);
    seed = set;
    for (const target of targetsOf(state)) {
      const f = await fileFor(target);
      if (f.tree) show(f);
    }
  });
}

/** Forgets every file, pending commit and watch, so a test starts clean. */
export function resetLayoutClientForTests(): void {
  for (const f of files.values()) if (f.timer !== null) clearTimeout(f.timer);
  for (const stop of watches) stop();
  watches = [];
  watchedOrgs = new Set();
  files = new Map();
  lane = Promise.resolve();
  seed = null;
  launchRoots = null;
}

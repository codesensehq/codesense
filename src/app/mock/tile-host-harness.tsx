// SPDX-License-Identifier: MIT
/**
 * `dev:mock` only: `?harness=tile-host&run=<id>` mounts the tile host alone, each tile's body a
 * live pane (`HtmlViewer`) of the probe dashboard, so the tile specs can drive the kit's gestures
 * and watch whether a frame stayed put. The tree is held in a slice the page writes, as a group
 * file re-seed or another writer's rev would.
 *
 * Each tile key's pane is `<run>-<key, dashed>.html` in `/mock-ctx/default/panes`; the spec
 * writes it first. `window.__tileHost` drives the page (see `api`).
 */
import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { HtmlViewer } from "@/features/dashboard/components/html-viewer";
import {
  appendLeaf,
  moveLeaf,
  parseMosaicNode,
  pruneLeaf,
  serializeMosaicNode,
  setNodeSizes,
  splitAt,
  type Axis,
  type MosaicNode,
  type SplitSide,
} from "@/shared/tiling";
import { TileHost, type CellTabs, type TileBodyContext } from "@/shared/tiling/tile-host";
import { registerKeepPredicate } from "@/shared/tiling/tile-keep-alive";

const PANES_DIR = "/mock-ctx/default/panes";
const CONTENT = "/mock-ctx/default/content";
const run = new URLSearchParams(window.location.search).get("run") ?? "tiles";

/** The probe pane a tile key's body shows. The spec names it the same way. */
const paneOf = (key: string) => `${run}-${key.replace(/[^a-z0-9]+/gi, "-")}`;

interface HarnessState {
  root: MosaicNode | null;
  zoomPath: number[] | null;
  tabs: ReadonlyMap<string, CellTabs>;
  width: number;
  nav: boolean;
  cap: number | undefined;
  held: ReadonlySet<string>;
  modal: boolean;
  dragLayer: boolean;
}

let state: HarnessState = {
  root: null,
  zoomPath: null,
  tabs: new Map(),
  width: 1000,
  nav: true,
  cap: undefined,
  held: new Set(),
  modal: false,
  dragLayer: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<HarnessState>) => {
  state = { ...state, ...patch };
  listeners.forEach((changed) => changed());
};
const subscribe = (changed: () => void) => {
  listeners.add(changed);
  return () => listeners.delete(changed);
};
const tree = () => {
  if (!state.root) throw new Error("seed the harness first");
  return state.root;
};

const kept = new Set<string>();
registerKeepPredicate((key) => kept.has(key));

/** What a spec drives. Every gesture goes through the kit's own ops. */
const api = {
  /** Replace the shown tree, as a group file's head does: new objects every time. */
  seed: (saved: unknown) => set({ root: parseMosaicNode(saved) }),
  /** The shown tree, serialized. */
  tree: () => serializeMosaicNode(state.root),
  /** The same keys, every node new: a launch hydrate or a conflict reload. */
  reseed: () => set({ root: parseMosaicNode(serializeMosaicNode(tree())) }),
  split: (target: string, axis: Axis, side: SplitSide, key: string) =>
    set({ root: splitAt(tree(), target, axis, side, key) }),
  close: (key: string) => set({ root: pruneLeaf(tree(), key) }),
  move: (key: string, target: string, axis: Axis, side: SplitSide) =>
    set({ root: moveLeaf(tree(), key, { targetWorkspaceId: target, axis, side }) }),
  append: (key: string) => set({ root: appendLeaf(state.root, key) }),
  /** Another writer's rev: the head re-read with one more leaf, written to the slice. */
  grow: (key: string) =>
    set({ root: parseMosaicNode(serializeMosaicNode(appendLeaf(state.root, key))) }),
  sizes: (path: number[], sizes: number[]) => set({ root: setNodeSizes(tree(), path, sizes) }),
  zoom: (path: number[] | null) => set({ zoomPath: path }),
  tabs: (cell: string, keys: string[], active: string) =>
    set({ tabs: new Map([...state.tabs, [cell, { keys, active }]]) }),
  width: (px: number) => set({ width: px }),
  nav: (open: boolean) => set({ nav: open }),
  cap: (n: number | undefined) => set({ cap: n }),
  keep: (key: string) => void kept.add(key),
  hold: (key: string) => set({ held: new Set([...state.held, key]) }),
  release: (key: string) => set({ held: new Set([...state.held].filter((k) => k !== key)) }),
  modal: (open: boolean) => set({ modal: open }),
  dragLayer: (open: boolean) => set({ dragLayer: open }),
};
Object.assign(window, { __tileHost: api });

/** A tile's body: the probe pane, its instance id fixed for the body's life. */
function ProbeBody({ tileKey, context }: { tileKey: string; context: TileBodyContext }) {
  const [instance] = useState(() => crypto.randomUUID());
  const held = useSyncExternalStore(subscribe, () => state.held.has(tileKey));
  const { reportLoading } = context;
  const loaded = useCallback(() => reportLoading(false), [reportLoading]);
  const loading = useCallback(() => reportLoading(true), [reportLoading]);
  useLayoutEffect(loading, [loading]);
  const fileName = `${paneOf(tileKey)}.html`;
  return (
    <div data-instance={instance} className="h-full w-full">
      {!held && (
        <HtmlViewer
          filePath={`${PANES_DIR}/${fileName}`}
          teamContentPath={CONTENT}
          refreshKey={0}
          visible={context.visible}
          onPageStart={loading}
          onPageLoad={loaded}
          pane={{ contentRoot: CONTENT, panesDir: PANES_DIR, fileName, badge: "live" }}
        />
      )}
    </div>
  );
}
const renderBody = (key: string, context: TileBodyContext) => (
  <ProbeBody tileKey={key} context={context} />
);
const renderSkeleton = () => <div data-tile-skeleton="pane" className="h-full w-full bg-muted" />;

export function TileHostHarness() {
  const s = useSyncExternalStore(subscribe, () => state);
  return (
    <main className="flex h-screen" style={{ width: s.width }}>
      {s.nav && <nav data-testid="harness-nav" className="w-48 shrink-0" />}
      <section className="min-w-0 flex-1">
        <TileHost
          node={s.root}
          renderBody={renderBody}
          renderSkeleton={renderSkeleton}
          onSizesCommit={api.sizes}
          zoomPath={s.zoomPath}
          cellTabs={s.tabs}
          keepAliveCap={s.cap}
        />
      </section>
      <Dialog open={s.modal} onOpenChange={(open) => api.modal(open)}>
        <DialogContent data-testid="harness-modal">
          <DialogTitle>Modal</DialogTitle>
          <button type="button" data-testid="harness-modal-button">
            Modal button
          </button>
        </DialogContent>
      </Dialog>
      {s.dragLayer &&
        createPortal(
          <div data-testid="harness-drag-layer" className="fixed inset-0 z-50 cursor-grabbing" />,
          document.body,
        )}
    </main>
  );
}

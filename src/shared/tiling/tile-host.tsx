// SPDX-License-Identifier: MIT
/**
 * The tile host: one layer per window that mounts every live tile body once, keyed by its tile
 * key, and positions it over its cell. Cells (MosaicView's leaves) only report where they are;
 * a move, swap, split, close, re-tab, Expand or re-seed of the tree moves a body by style and
 * never reparents it, so no frame reloads and no terminal restarts.
 *
 * The host is kind-agnostic, like the kit: it is handed `renderBody(key)` and knows nothing of
 * what fills a tile, which team it belongs to or which window owns it. A body whose key leaves
 * the tree stays mounted hidden until the keep-alive policy (`tile-keep-alive.ts`) lets it go.
 *
 * - Rects: one `ResizeObserver` over the cells and the root, plus a re-measure on each new tree
 *   (a swap or a close moves a cell without resizing it). They live outside React and reach
 *   bodies through `useTileHost()`; a body's wrapper writes its own position to `style`.
 * - Hidden bodies take no pointer input and are not painted. The layer is its own stacking
 *   context, so menus, modals, popovers and the drag layer, which portal above it, sit above
 *   every frame.
 * - The owner gate says whether this window mounts a body; a body it doesn't own draws its
 *   skeleton and leaves a surface slot. Pins mount whatever the gate says.
 */
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";

import type { Axis, MosaicNode } from "./mosaic-tree";
import { MosaicView } from "./mosaic-view";
import { evictHidden } from "./tile-keep-alive";

/** Where a body sits, relative to the host's root. A folded body (its cell measures no area)
 *  keeps its last position and size. */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
  folded: boolean;
}

/** Whether this window mounts a tile's live body. `subscribe` names the keys whose answer may
 *  have changed, so only those are asked again. */
export interface TileOwnerGate {
  owns(key: string): boolean;
  subscribe(changed: (keys: readonly string[]) => void): () => void;
}

/** Whether the window is shown: false only while the app hides it (a minimized window is
 *  shown). */
export interface WindowShownSource {
  get(): boolean;
  subscribe(changed: () => void): () => void;
}

/** A cell's tabs: the bodies it holds and the one it shows. */
export interface CellTabs {
  keys: readonly string[];
  active: string;
}

/** What a body is told by its host. */
export interface TileBodyContext {
  /** The body is on screen: in the tree, its cell's active tab and not behind an Expand. */
  visible: boolean;
  /** The body is loading (true) or ready (false). While it loads the host shows the body's
   *  last frame greyed, or its skeleton when it was never ready. */
  reportLoading(loading: boolean): void;
}

/** The host's reads, the same object for the host's whole life. */
export interface TileHostHandle {
  /** Calls `changed` with the key's rect each time it changes. Returns the unsubscribe. */
  subscribeTileRect(key: string, changed: (rect: TileRect) => void): () => void;
  getTileRect(key: string): TileRect | null;
  /** The tile's cell is in the shown tree, it is the cell's active tab and the window is shown.
   *  Never true for a pin. */
  isBodyVisible(key: string): boolean;
  /** The frames mounted in that body, none for a body not mounted. */
  framesOf(key: string): HTMLIFrameElement[];
}

/** Test-only: told each time a body renders, and once when it mounts. */
export type TileBodyProbe = (key: string, phase: "render" | "mount") => void;

export interface TileHostProps {
  /** The window's shown tree. Bodies are keyed by leaf id (`tileKey`), never by node object. */
  node: MosaicNode | null;
  /** A tile's live body. Keep it stable: a new function renders every body. */
  renderBody: (key: string, context: TileBodyContext) => ReactNode;
  /** A tile's skeleton in its own kind's form; a plain one by default. Keep it stable. */
  renderSkeleton?: (key: string) => ReactNode;
  /** What goes over the skeleton of a tile another window owns. Keep it stable. */
  renderSurface?: (key: string) => ReactNode;
  /** Mounted once inside each body's wrapper, around the body. Keep it stable. */
  wrapBody?: ComponentType<{ tileKey: string; children: ReactNode }>;
  /** A divider was released: the split at `path` ([] = root) now has `sizes`. */
  onSizesCommit: (path: number[], sizes: number[]) => void;
  /** The index trail to an Expanded leaf. */
  zoomPath?: number[] | null;
  minSizePx?: Record<Axis, number>;
  resizeIdentity?: string;
  /** Each cell's tabs, by leaf id. A cell not here holds one tab, its leaf id. */
  cellTabs?: ReadonlyMap<string, CellTabs>;
  /** The window's pinned tile keys, never evicted and mounted whatever the gate says. */
  pins?: ReadonlySet<string>;
  /** Whether this window mounts each body. Default: every body. Keep it stable. */
  ownerGate?: TileOwnerGate;
  /** Whether the window is shown. Default: always. */
  windowShown?: WindowShownSource;
  /** Hidden bodies kept mounted. Default `tileKeepAliveMaxHidden`. */
  keepAliveCap?: number;
  /** The host's reads, for a caller outside the host. */
  handleRef?: Ref<TileHostHandle>;
  /** Test-only body render counter. */
  renderProbe?: TileBodyProbe;
}

/** The word Loading shows only once a body has loaded this long. */
export const TILE_LOADING_WORD_MS = 400;

const OWN_EVERY_TILE: TileOwnerGate = { owns: () => true, subscribe: () => () => {} };
const ALWAYS_SHOWN: WindowShownSource = { get: () => true, subscribe: () => () => {} };
const NO_PINS: ReadonlySet<string> = new Set();
const NO_TABS: ReadonlyMap<string, CellTabs> = new Map();

const sameRect = (a: TileRect | undefined, b: TileRect) =>
  !!a &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.folded === b.folded;

/** The host's state outside React: cells, rects, body elements and owner listeners. */
class TileHostStore implements TileHostHandle {
  private root: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private slots = new Map<string, HTMLElement>();
  private rects = new Map<string, TileRect>();
  private rectListeners = new Map<string, Set<(rect: TileRect) => void>>();
  private bodies = new Map<string, HTMLElement>();
  private ownerListeners = new Map<string, Set<() => void>>();
  /** The latest render's view of the tree, for the reads. */
  view: { keysOf: (cell: string) => readonly string[]; shown: (key: string) => boolean } = {
    keysOf: () => [],
    shown: () => false,
  };
  pins: ReadonlySet<string> = NO_PINS;
  windowShown: WindowShownSource = ALWAYS_SHOWN;

  /** Takes the committed render's tree view, pins and window source for the reads. */
  sync(view: TileHostStore["view"], pins: ReadonlySet<string>, windowShown: WindowShownSource) {
    this.view = view;
    this.pins = pins;
    this.windowShown = windowShown;
  }

  attachRoot(root: HTMLElement | null) {
    this.observer?.disconnect();
    this.observer = null;
    this.root = root;
    if (!root || typeof ResizeObserver === "undefined") return;
    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(root);
    for (const slot of this.slots.values()) this.observer.observe(slot);
  }

  registerSlot(cell: string, element: HTMLElement | null) {
    const prev = this.slots.get(cell);
    if (prev && prev !== element) {
      this.observer?.unobserve(prev);
      this.slots.delete(cell);
    }
    if (!element) return;
    this.slots.set(cell, element);
    this.observer?.observe(element);
  }

  registerBody(key: string, element: HTMLElement | null) {
    if (element) this.bodies.set(key, element);
    else this.bodies.delete(key);
  }

  /** Reads every cell's place and tells each body whose rect changed. */
  measure() {
    if (!this.root) return;
    const origin = this.root.getBoundingClientRect();
    for (const [cell, slot] of this.slots) {
      const box = slot.getBoundingClientRect();
      for (const key of this.view.keysOf(cell)) {
        this.setRect(key, {
          x: box.left - origin.left,
          y: box.top - origin.top,
          width: box.width,
          height: box.height,
          folded: box.width === 0 || box.height === 0,
        });
      }
    }
  }

  private setRect(key: string, measured: TileRect) {
    const prev = this.rects.get(key);
    const next = measured.folded && prev ? { ...prev, folded: true } : measured;
    if (sameRect(prev, next)) return;
    this.rects.set(key, next);
    this.rectListeners.get(key)?.forEach((changed) => changed(next));
  }

  subscribeTileRect = (key: string, changed: (rect: TileRect) => void) => {
    let set = this.rectListeners.get(key);
    if (!set) this.rectListeners.set(key, (set = new Set()));
    set.add(changed);
    return () => {
      set.delete(changed);
      if (set.size === 0) this.rectListeners.delete(key);
    };
  };

  getTileRect = (key: string) => this.rects.get(key) ?? null;

  isBodyVisible = (key: string) =>
    !this.pins.has(key) && this.view.shown(key) && this.windowShown.get();

  framesOf = (key: string) => [...(this.bodies.get(key)?.querySelectorAll("iframe") ?? [])];

  subscribeOwner(key: string, changed: () => void) {
    let set = this.ownerListeners.get(key);
    if (!set) this.ownerListeners.set(key, (set = new Set()));
    set.add(changed);
    return () => {
      set.delete(changed);
      if (set.size === 0) this.ownerListeners.delete(key);
    };
  }

  ownersChanged(keys: readonly string[]) {
    for (const key of keys) this.ownerListeners.get(key)?.forEach((changed) => changed());
  }

  forget(key: string) {
    this.rects.delete(key);
  }

  /** The handle: the host's reads, bound. */
  handle(): TileHostHandle {
    return {
      subscribeTileRect: this.subscribeTileRect,
      getTileRect: this.getTileRect,
      isBodyVisible: this.isBodyVisible,
      framesOf: this.framesOf,
    };
  }
}

const TileHostContext = createContext<TileHostHandle | null>(null);
const SlotContext = createContext<TileHostStore | null>(null);

/** The key of the tile whose body this is. */
export const TileKeyContext = createContext<string | null>(null);

/** The host's reads, from inside a body. The value never changes. */
export function useTileHost(): TileHostHandle {
  const value = useContext(TileHostContext);
  if (!value) throw new Error("useTileHost is called inside a tile body");
  return value;
}

/** A cell: an empty region the host measures. */
const TileCellSlot = memo(function TileCellSlot({ id }: { id: string }) {
  const store = useContext(SlotContext);
  const ref = useCallback(
    (element: HTMLDivElement | null) => store?.registerSlot(id, element),
    [store, id],
  );
  return <div ref={ref} data-tile-cell={id} className="h-full w-full" />;
});

const renderCell = (id: string) => <TileCellSlot id={id} />;

/** The leaves behind an Expand: every leaf outside the zoomed node. */
function collapsedLeaves(root: MosaicNode | null, zoomPath: number[] | null | undefined) {
  const collapsed = new Set<string>();
  if (!root || !zoomPath?.length) return collapsed;
  const collect = (node: MosaicNode) => {
    if (node.kind === "leaf") collapsed.add(node.id);
    else node.children.forEach(collect);
  };
  let at: MosaicNode = root;
  for (const i of zoomPath) {
    if (at.kind !== "split" || !at.children[i]) return new Set<string>();
    at.children.forEach((child, j) => j !== i && collect(child));
    at = at.children[i];
  }
  return collapsed;
}

function leavesOf(root: MosaicNode | null): string[] {
  if (!root) return [];
  return root.kind === "leaf" ? [root.id] : root.children.flatMap(leavesOf);
}

/** The tree as the host reads it: each cell's tabs, which bodies show, which are active. */
interface HostView {
  cells: readonly string[];
  keysOf: (cell: string) => readonly string[];
  /** Key → in the tree and its cell's active tab. */
  active: ReadonlySet<string>;
  /** Active and not behind an Expand: on screen. */
  displayed: ReadonlySet<string>;
}

function readView(
  node: MosaicNode | null,
  zoomPath: number[] | null | undefined,
  tabs: ReadonlyMap<string, CellTabs>,
): HostView {
  const cells = leavesOf(node);
  const collapsed = collapsedLeaves(node, zoomPath);
  const active = new Set<string>();
  const displayed = new Set<string>();
  for (const cell of cells) {
    const key = tabs.get(cell)?.active ?? cell;
    active.add(key);
    if (!collapsed.has(cell)) displayed.add(key);
  }
  return { cells, keysOf: (cell) => tabs.get(cell)?.keys ?? [cell], active, displayed };
}

export function TileHost({
  node,
  renderBody,
  renderSkeleton,
  renderSurface,
  wrapBody,
  onSizesCommit,
  zoomPath,
  minSizePx,
  resizeIdentity,
  cellTabs = NO_TABS,
  pins = NO_PINS,
  ownerGate = OWN_EVERY_TILE,
  windowShown = ALWAYS_SHOWN,
  keepAliveCap,
  handleRef,
  renderProbe,
}: TileHostProps) {
  const [store] = useState(() => new TileHostStore());
  const [handle] = useState(() => store.handle());
  useImperativeHandle(handleRef, () => handle, [handle]);

  const view = useMemo(() => readView(node, zoomPath, cellTabs), [node, zoomPath, cellTabs]);
  useLayoutEffect(
    () =>
      store.sync({ keysOf: view.keysOf, shown: (key) => view.active.has(key) }, pins, windowShown),
    [store, view, pins, windowShown],
  );

  // Bodies mount in the order first shown and keep their place, so React never moves one.
  const [mounted, setMounted] = useState<readonly string[]>([]);
  const missing = [...view.displayed, ...pins].filter((key) => !mounted.includes(key));
  if (missing.length > 0) setMounted([...mounted, ...new Set(missing)]);

  // Recency for the keep-alive: each body is stamped when it is on screen.
  const shownAt = useRef(new Map<string, number>());
  const clock = useRef(0);
  useLayoutEffect(() => {
    for (const key of view.displayed) shownAt.current.set(key, ++clock.current);
  }, [view]);

  useLayoutEffect(() => {
    const hidden = mounted
      .filter((key) => !view.displayed.has(key))
      .sort((a, b) => (shownAt.current.get(a) ?? 0) - (shownAt.current.get(b) ?? 0));
    const evicted = evictHidden({
      hidden,
      cap: keepAliveCap,
      pins,
      keep: (key) => view.active.has(key),
    });
    if (evicted.length === 0) return;
    const gone = new Set(evicted);
    for (const key of gone) {
      shownAt.current.delete(key);
      store.forget(key);
    }
    setMounted((prev) => prev.filter((key) => !gone.has(key)));
  }, [mounted, view, pins, keepAliveCap, store]);

  // Rects: on each new tree, then on every resize the observer sees.
  useLayoutEffect(() => store.measure(), [store, view]);
  const rootRef = useCallback((root: HTMLDivElement | null) => store.attachRoot(root), [store]);

  useEffect(() => ownerGate.subscribe((keys) => store.ownersChanged(keys)), [ownerGate, store]);

  return (
    <TileHostContext.Provider value={handle}>
      <SlotContext.Provider value={store}>
        <div ref={rootRef} data-tile-host="" className="relative isolate h-full w-full">
          <MosaicView
            node={node}
            renderLeaf={renderCell}
            onSizesCommit={onSizesCommit}
            zoomPath={zoomPath}
            minSizePx={minSizePx}
            resizeIdentity={resizeIdentity}
          />
          <div data-tile-layer="" className="pointer-events-none absolute inset-0 z-0">
            {mounted.map((key) => (
              <TileBody
                key={key}
                tileKey={key}
                shown={view.displayed.has(key)}
                pinned={pins.has(key)}
                store={store}
                ownerGate={ownerGate}
                renderBody={renderBody}
                renderSkeleton={renderSkeleton}
                renderSurface={renderSurface}
                wrapBody={wrapBody}
                renderProbe={renderProbe}
              />
            ))}
          </div>
        </div>
      </SlotContext.Provider>
    </TileHostContext.Provider>
  );
}

interface TileBodyProps {
  tileKey: string;
  shown: boolean;
  pinned: boolean;
  store: TileHostStore;
  ownerGate: TileOwnerGate;
  renderBody: TileHostProps["renderBody"];
  renderSkeleton?: TileHostProps["renderSkeleton"];
  renderSurface?: TileHostProps["renderSurface"];
  wrapBody?: TileHostProps["wrapBody"];
  renderProbe?: TileBodyProbe;
}

/** One body's wrapper, redrawn only when the body shows or hides, or its owner changes. */
const TileBody = memo(function TileBody({
  tileKey,
  shown,
  pinned,
  store,
  ownerGate,
  renderBody,
  renderSkeleton,
  renderSurface,
  wrapBody: Wrap,
  renderProbe,
}: TileBodyProps) {
  renderProbe?.(tileKey, "render");
  useEffect(() => {
    renderProbe?.(tileKey, "mount");
    // Once per mount: the key is the body's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribeOwner = useCallback(
    (changed: () => void) => store.subscribeOwner(tileKey, changed),
    [store, tileKey],
  );
  const owned = useSyncExternalStore(subscribeOwner, () => pinned || ownerGate.owns(tileKey));

  // The wrapper's place is written to its style, never rendered.
  const wrapper = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const place = (rect: TileRect) => {
      const style = wrapper.current?.style;
      if (!style) return;
      style.left = `${rect.x}px`;
      style.top = `${rect.y}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
    };
    const rect = store.getTileRect(tileKey);
    if (rect) place(rect);
    return store.subscribeTileRect(tileKey, place);
  }, [store, tileKey]);
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      wrapper.current = element;
      store.registerBody(tileKey, element);
    },
    [store, tileKey],
  );

  const [loading, setLoading] = useState(false);
  const [wasReady, setWasReady] = useState(false);
  const reportLoading = useCallback((next: boolean) => {
    setLoading(next);
    if (!next) setWasReady(true);
  }, []);
  const context = useMemo<TileBodyContext>(
    () => ({ visible: shown, reportLoading }),
    [shown, reportLoading],
  );

  const skeleton = renderSkeleton?.(tileKey) ?? <PlainSkeleton />;
  const body = owned ? renderBody(tileKey, context) : null;
  const greyed = owned && loading && wasReady;

  return (
    <div
      ref={ref}
      data-tile-body={tileKey}
      data-tile-shown={shown ? "true" : "false"}
      className="absolute"
      style={{
        visibility: shown ? "visible" : "hidden",
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      <TileKeyContext.Provider value={tileKey}>
        <div
          data-tile-content=""
          data-tile-loading={greyed ? "last-frame" : undefined}
          className="absolute inset-0"
          style={greyed ? { filter: "grayscale(1)", opacity: 0.5 } : undefined}
        >
          {owned && (Wrap ? <Wrap tileKey={tileKey}>{body}</Wrap> : body)}
        </div>
        {owned ? (
          loading && <TileLoadingForm skeleton={wasReady ? null : skeleton} />
        ) : (
          <div data-tile-held="" className="absolute inset-0">
            {skeleton}
            <div data-tile-surface={tileKey} className="absolute inset-0">
              {renderSurface?.(tileKey)}
            </div>
          </div>
        )}
      </TileKeyContext.Provider>
    </div>
  );
});

/** The host's skeleton for a kind that has none of its own. */
function PlainSkeleton() {
  return <div data-tile-skeleton="plain" className="h-full w-full bg-muted/40" />;
}

/** Over a loading body: its skeleton when it has no last frame to show, and the word Loading
 *  once it has loaded a while. */
function TileLoadingForm({ skeleton }: { skeleton: ReactNode }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), TILE_LOADING_WORD_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div data-tile-loading-form="" className="absolute inset-0">
      {skeleton && (
        <div data-tile-loading="skeleton" className="absolute inset-0">
          {skeleton}
        </div>
      )}
      {late && (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          Loading
        </span>
      )}
    </div>
  );
}

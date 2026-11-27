// SPDX-License-Identifier: MIT
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import type { Axis, MosaicNode } from "./mosaic-tree";
import { stabilizeTree, type StableNode, type StableTree } from "./stabilize-tree";
import { TileGroup, type TileLike } from "./tile-group";

// ---------------------------------------------------------------------------
// MosaicView — renders a mosaic tree as nested resizable groups. The one
// renderer for every mosaic on screen: the workspace mosaic (a leaf is a
// workspace's tile) and a workspace's tab grid (a leaf is one of its terminals), so
// both have the same dividers, the same drag feel and the same double-click to
// even a pair.
//
// Each render stabilizes the tree against the last one (`stabilizeTree`), and
// every node is memoized on its stable identity, so a change redraws only the
// splits on its path and the leaves it adds or moves. That holds while
// `renderLeaf` is a stable reference: a new one redraws every leaf.
// ---------------------------------------------------------------------------

/** Test-only: told each time a split renders, and when one mounts. */
export type MosaicRenderProbe = (key: string, phase: "render" | "mount") => void;

export interface MosaicViewProps {
  node: MosaicNode | null;
  /** What fills a leaf's region, by its id. Keep it stable (memoize it): a new
   *  function redraws every leaf. */
  renderLeaf: (id: string) => ReactNode;
  /** A divider was released: the split at `path` ([] = root) now has `sizes`. */
  onSizesCommit: (path: number[], sizes: number[]) => void;
  /** The index trail to a zoomed leaf, which then fills the whole region. */
  zoomPath?: number[] | null;
  /** A pixel floor per split axis (a row's cells keep a width, a column's a
   *  height). Without it a tile keeps a percent floor. */
  minSizePx?: Record<Axis, number>;
  /** Cancels a resize gesture when a persistent mosaic changes owners. */
  resizeIdentity?: string;
  /** Test-only render counter for splits. */
  renderProbe?: MosaicRenderProbe;
}

interface MosaicContextValue {
  renderLeaf: (id: string) => ReactNode;
  minSizePx?: Record<Axis, number>;
  resizeIdentity?: string;
  commit: (split: StableNode, sizes: number[]) => void;
  renderProbe?: MosaicRenderProbe;
}

const MosaicContext = createContext<MosaicContextValue | null>(null);
/** The keys from the root to the zoomed leaf, or none. */
const ZoomTrailContext = createContext<readonly string[]>([]);
const NO_TRAIL: readonly string[] = [];

export function MosaicView({
  node,
  renderLeaf,
  onSizesCommit,
  zoomPath,
  minSizePx,
  resizeIdentity,
  renderProbe,
}: MosaicViewProps) {
  const committedRef = useRef<StableTree | null>(null);
  const tree = useMemo(() => stabilizeTree(committedRef.current, node), [node]);
  useLayoutEffect(() => {
    committedRef.current = tree;
  }, [tree]);

  // A commit finds its split's path in the tree on screen, so it holds whatever moved since.
  const onSizesCommitRef = useRef(onSizesCommit);
  useLayoutEffect(() => {
    onSizesCommitRef.current = onSizesCommit;
  }, [onSizesCommit]);
  const commit = useCallback((split: StableNode, sizes: number[]) => {
    const root = committedRef.current?.root;
    const path = root ? pathTo(root, split) : null;
    if (path) onSizesCommitRef.current(path, sizes);
  }, []);

  const minRow = minSizePx?.row;
  const minColumn = minSizePx?.column;
  const context = useMemo<MosaicContextValue>(
    () => ({
      renderLeaf,
      minSizePx:
        minRow === undefined || minColumn === undefined
          ? undefined
          : { row: minRow, column: minColumn },
      resizeIdentity,
      commit,
      renderProbe,
    }),
    [renderLeaf, minRow, minColumn, resizeIdentity, commit, renderProbe],
  );

  const trailKeys = zoomTrail(tree.root, zoomPath);
  const trailId = trailKeys.join("\u0000");
  // Keyed on the joined keys, so an equal trail keeps its identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trail = useMemo(() => trailKeys, [trailId]);

  if (!tree.root) return null;
  return (
    <MosaicContext.Provider value={context}>
      <ZoomTrailContext.Provider value={trail}>
        <MosaicNodeView stable={tree.root} hidden={false} />
      </ZoomTrailContext.Provider>
    </MosaicContext.Provider>
  );
}

/** The keys along `zoomPath`, from the root to the zoomed node, or none when the path
 *  leaves the tree. */
function zoomTrail(root: StableNode | null, zoomPath: number[] | null | undefined) {
  if (!root || !zoomPath || zoomPath.length === 0) return NO_TRAIL;
  const keys = [root.key];
  let cur = root;
  for (const i of zoomPath) {
    const child = cur.children[i];
    if (!child) return NO_TRAIL;
    keys.push(child.key);
    cur = child;
  }
  return keys;
}

/** The index trail from `root` to `target`, by identity. */
function pathTo(root: StableNode, target: StableNode): number[] | null {
  if (root === target) return [];
  for (let i = 0; i < root.children.length; i++) {
    const sub = pathTo(root.children[i], target);
    if (sub) return [i, ...sub];
  }
  return null;
}

function useMosaic(): MosaicContextValue {
  const value = useContext(MosaicContext);
  if (!value) throw new Error("a mosaic node renders inside MosaicView");
  return value;
}

interface MosaicNodeViewProps {
  stable: StableNode;
  /** This node sits inside a collapsed sibling of the zoomed leaf (hidden), so
   *  its splits are out of play. */
  hidden: boolean;
}

/** One node of the tree, redrawn only when its stable node or `hidden` changes. */
const MosaicNodeView = memo(function MosaicNodeView({ stable, hidden }: MosaicNodeViewProps) {
  if (stable.node.kind === "leaf") return <MosaicLeafView id={stable.node.id} />;
  return <MosaicSplitView stable={stable} hidden={hidden} />;
});

function MosaicLeafView({ id }: { id: string }) {
  const { renderLeaf } = useMosaic();
  return <MosaicLeaf id={id} renderLeaf={renderLeaf} />;
}

/** A leaf's content, redrawn only for a new id or a new `renderLeaf`. */
const MosaicLeaf = memo(function MosaicLeaf({
  id,
  renderLeaf,
}: {
  id: string;
  renderLeaf: (id: string) => ReactNode;
}) {
  return <>{renderLeaf(id)}</>;
});

interface FrameTile extends TileLike {
  stable: StableNode;
}

function MosaicSplitView({ stable, hidden }: MosaicNodeViewProps) {
  const { minSizePx, resizeIdentity, commit, renderProbe } = useMosaic();
  const trail = useContext(ZoomTrailContext);
  renderProbe?.(stable.key, "render");
  useEffect(() => {
    renderProbe?.(stable.key, "mount");
    // Once per mount: the key is the node's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { node } = stable;
  if (node.kind !== "split") return null;
  const tiles: FrameTile[] = stable.children.map((child) => ({ key: child.key, stable: child }));

  // Two-level zoom: at each split on the trail to the zoomed leaf, zoom the
  // on-trail child so the zoomed leaf fills the whole region up the tree.
  const at = trail.indexOf(stable.key);
  const zoomedChildKey = at >= 0 && at + 1 < trail.length ? trail[at + 1] : null;
  const zoomedHere = zoomedChildKey != null && tiles.some((tile) => tile.key === zoomedChildKey);

  return (
    <TileGroup
      tiles={tiles}
      resizeIdentity={resizeIdentity}
      direction={node.axis}
      sizes={node.sizes}
      onSizesCommit={(sizes) => commit(stable, sizes)}
      zoomedKey={zoomedChildKey}
      disabled={hidden}
      minSizePx={minSizePx?.[node.axis]}
      renderTile={(tile) => (
        <MosaicNodeView
          stable={tile.stable}
          hidden={hidden || (zoomedHere && tile.key !== zoomedChildKey)}
        />
      )}
    />
  );
}

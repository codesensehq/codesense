# Tiling kit

One tree, one renderer and one drop-zone rule for every tile kind: the
workspace mosaic, a workspace's tab grid, and any surface that tiles terminals,
agents or docs side by side. Import everything from `@/shared/tiling`.

The kit knows nothing about what fills a tile. It imports nothing from
`features/**` or `shared/stores/**` and never reads a team key;
`tiling-kit.guard.test.ts` fails if that changes, or if a second definition of
`MosaicNode`, `EDGE_BANDS`, `resolveZoneAt` or `TileDropSide` appears outside
the kit.

## The tree

```ts
type MosaicNode =
  | { kind: "leaf"; id: string }
  | { kind: "split"; axis: "row" | "column"; children: MosaicNode[]; sizes: number[] };
```

A split has two or more children and one percent size per child, summing
to 100. Every op is pure and returns a new tree:

| Op                                                 | Does                                                           |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `seedTreeFromFlat(ids, axis, sizes?)`              | One flat split (or a leaf, or null).                           |
| `buildPresetTree(preset, ids, maxCols?, maxRows?)` | The even `columns`, `rows` or `grid` arrangement.              |
| `reconcilePresetTree(saved, preset, ids, …)`       | The preset tree, keeping a saved resize that still fits.       |
| `splitAt(tree, target, axis, side, id)`            | Put a new leaf beside `target`.                                |
| `moveLeaf(tree, id, target)`                       | Move a leaf to another tile's edge.                            |
| `appendLeaf(tree, id)`                             | Add a leaf at the end of the root, evening the root.           |
| `pruneLeaf(tree, id)`                              | Remove a leaf; a split left with one child collapses.          |
| `reconcileMosaic(tree, liveIds)`                   | Prune leaves that are gone, append live ones that are missing. |
| `replaceLeafWorkspaceId(tree, old, next)`          | Put another id in a leaf's place.                              |
| `swapLeaves(tree, a, b)`                           | Exchange two leaves' places, keeping every size.               |
| `setNodeSizes(tree, path, sizes)`                  | Commit one split's sizes.                                      |
| `evenSizes(tree, path?)`                           | Even out one split, or every split with no path.               |

Readers: `leafId`, `leafWorkspaceIds`, `findLeafPath`, `sameMosaicStructure`,
`placementChangesLayout`, `balancedColsRows` and `clampedGridShape`.

### Identity

Every op keeps each subtree it doesn't touch by reference (`===`), and a call
that changes nothing returns its input: equal sizes, a move onto the edge a
tile already holds, swapping or replacing an id with itself, an absent id, an
id already placed, an already even split. A store can compare by reference to
skip a write, and the renderer redraws only what changed.

## Leaf ids

A leaf's `id` is opaque: a workspace id, a terminal tab id, an
`agent:<team>/<name>` or `doc:<path>` id from any team. The kit passes it
through untouched; read it with `leafId`.

Saved state goes through one parse and one serializer:

- `parseMosaicNode(value)` reads a leaf's `workspaceId`, then its `id`. When
  both are set and differ, `workspaceId` wins. A leaf with neither is dropped,
  and its split keeps the other children (sizes renormalized) or becomes its
  one remaining child. Any other malformed node makes the whole value `null`.
- `serializeMosaicNode(tree)` writes both `id` and `workspaceId` on every
  leaf, so a build that only reads `workspaceId` still opens the layout.

## Rendering

```tsx
<MosaicView
  node={tree}
  renderLeaf={renderLeaf}
  onSizesCommit={(path, sizes) => setSizes(path, sizes)}
  zoomPath={zoomPath}
  minSizePx={{ row: 240, column: 120 }}
/>
```

`MosaicView` draws the tree as nested resizable groups (`TileGroup` is one
group). Each render runs `stabilizeTree` against the previous one:

- A subtree equal to one from the last render comes back as the same object,
  so a tree rebuilt from scratch (a preset, a parse) costs nothing.
- A split keeps its React key across edits: a changed split takes the key of
  the split it replaced under the same parent. The root's key is fixed, and a
  leaf's key is its id.
- Every node is memoized on that identity. An edit redraws only the splits on
  its path and mounts only the leaves it adds or moves to a new parent.

`onSizesCommit` gets the index path of the split in the tree on screen at
release time, so it stays right after leaves move.

**Keep `renderLeaf` stable.** Wrap it in `useCallback` with the dependencies it
really reads. A new function every render redraws every leaf. The CLI workspace's tile
mosaic and its tab grid are conforming callers: what changes per leaf reaches the leaf through
a keyed view store, not through `renderLeaf`.

## Drop zones

`EDGE_BANDS` is the one table of drop bands, as fractions of a tile:

| Side   | Box                                                                  |
| ------ | -------------------------------------------------------------------- |
| left   | the outer quarter of the width, full height                          |
| right  | the outer quarter of the width, full height                          |
| top    | the outer quarter of the height, across the middle half of the width |
| bottom | the outer quarter of the height, across the middle half of the width |

The sides win the corners and the centre is inert. Each band holds its left
and top edges but not its right and bottom ones. `bandRect(rect, band)` turns
a band into a box.

`resolveZoneAt(point, tiles)` picks the band under a point. The first tile
containing the point decides; a point on its centre, or on a side it disables,
is `null` and never falls through to a neighbour.

Draw the bands from `EDGE_BANDS` and resolve the drop with `resolveZoneAt`, so
the highlighted band and the drop always agree. The workspace grid does this:
each tile registers one frame droppable carrying its disabled sides, and the
drag's collision detection rebuilds the tiles from those rects.

// SPDX-License-Identifier: MIT
import { fixtureRefs, leaf, split, type SavedNode, type TileHostPage } from "./fixtures/tile-host";

/**
 * The tile gestures a live body must survive, as one table every tile spec walks. Each row runs
 * one gesture through the kit's own ops on the tile host harness and names the keys it adds, so
 * a spec can tell an expected new body from one that moved. Later stories append their rows.
 *
 * e2e-mock has no `group_read` or `group_commit` handler, so the re-seed rows write the layout
 * slice directly, as the client does with the head it read.
 */

export interface TileAction {
  name: string;
  /** Keys whose body this step mounts for the first time. */
  adds: string[];
  run(host: TileHostPage): Promise<void>;
}

/** Another team's doc and agent, from the leaf-key fixture rather than typed here. The harness
 *  window belongs to no team, so any of the fixture's docs is another team's. */
export const OTHER_DOC = fixtureRefs("doc:")[0];
export const OTHER_AGENT = fixtureRefs("agent:").find((key) => !key.startsWith("agent:core/"))!;

/** The tree every walk starts from. */
export const T1_TREE: SavedNode = split("row", [
  leaf("ws-a"),
  split("column", [leaf("ws-b"), leaf("ws-c")]),
]);

export const T1_ACTIONS: TileAction[] = [
  {
    name: "resize",
    adds: [],
    run: async (host) => {
      await host.call("sizes", [], [30, 70]);
      await host.call("width", 700);
      await host.call("width", 1000);
    },
  },
  {
    name: "sibling close",
    adds: [],
    run: (host) => host.call("close", "ws-c").then(() => {}),
  },
  {
    name: "move",
    adds: [],
    run: (host) => host.call("move", "ws-a", "ws-b", "column", "after").then(() => {}),
  },
  {
    name: "re-tab",
    adds: ["ws-a2"],
    run: async (host) => {
      await host.call("tabs", "ws-b", ["ws-b", "ws-a2"], "ws-a2");
      await host.loaded("ws-a2");
      await host.call("tabs", "ws-b", ["ws-b", "ws-a2"], "ws-b");
    },
  },
  {
    name: "split",
    adds: ["ws-d"],
    run: async (host) => {
      await host.call("split", "ws-b", "row", "after", "ws-d");
      await host.loaded("ws-d");
    },
  },
  {
    name: "expand and restore",
    adds: [],
    run: async (host) => {
      await host.call("zoom", [0]);
      await host.call("zoom", null);
    },
  },
  {
    name: "hide",
    adds: [],
    run: async (host) => {
      await host.call("close", "ws-d");
      await host.call("append", "ws-d");
    },
  },
  {
    name: "nav collapse",
    adds: [],
    run: async (host) => {
      await host.call("nav", false);
      await host.call("nav", true);
    },
  },
  {
    name: "open another team's doc beside",
    adds: [OTHER_DOC],
    run: async (host) => {
      await host.call("split", "ws-b", "row", "after", OTHER_DOC);
      await host.loaded(OTHER_DOC);
    },
  },
  {
    name: "re-seed with equal keys",
    adds: [],
    run: (host) => host.call("reseed").then(() => {}),
  },
  {
    name: "another writer's rev adds a leaf",
    adds: [OTHER_AGENT],
    run: async (host) => {
      await host.call("grow", OTHER_AGENT);
      await host.loaded(OTHER_AGENT);
    },
  },
];

/** Every key a walk of `T1_ACTIONS` shows, beyond `T1_TREE`'s. */
export const T1_LATER_KEYS = [...new Set(T1_ACTIONS.flatMap((action) => action.adds))];

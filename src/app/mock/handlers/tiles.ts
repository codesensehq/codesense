// SPDX-License-Identifier: MIT
import { layoutFileRef } from "@/shared/stores/layout-store-client";
import { applyKitOp, KIT_OP_FAILED } from "@/shared/tiling/apply-kit-op";
import type { KitOp } from "@/shared/tiling/kit-op";
import {
  parseMosaicNode,
  serializeMosaicNode,
  type SavedMosaicNode,
} from "@/shared/tiling/mosaic-tree";

import type { MockEventBus } from "../mock-events";
import type { HandlerRegistry } from "../mock-router";

/** `?tiles=on`: the tiles release flag is on for the session, as the local setting would set it. */
function isTilesWorld(search: string): boolean {
  return new URLSearchParams(search).get("tiles") === "on";
}

interface Head {
  rev: number;
  tree: SavedMosaicNode | null;
}

/** What a `group` hub view holds: the file's head as one row, keyed as the window watches it. */
const groupView = (viewKey: string, head: Head | undefined) => ({
  topic: "group",
  viewKey,
  rev: head?.rev ?? 0,
  snapshot: head ? [{ id: viewKey, file: { rev: head.rev, root: head.tree } }] : [],
  total: head ? 1 : 0,
});

/**
 * The tiles flag and the group store. Outside the tiles world the flag reads off, so the app is
 * today's app. In it, each group file starts unwritten; a commit on the head applies its kit ops
 * and moves the rev on, and a commit on an older rev is a conflict, as the host's store answers.
 * A window's pins are kept for the page's life.
 *
 * `window.__mockGroups.write(teamKey, root)` writes a team's foreground file as another writer
 * (an agent) would, and the window hears it through the hub's `group` topic.
 */
export function tilesHandlers(search: string, events: MockEventBus) {
  const on = isTilesWorld(search);
  const heads = new Map<string, Head>();
  let pins: string[] = [];
  const viewKeyOf = (org: unknown, file: unknown) => `${org}:${(file as { id: string }).id}`;

  const handlers: HandlerRegistry = {
    tiles_enabled: () => on,
    group_read: (args) => heads.get(viewKeyOf(args.org, args.file)) ?? null,
    group_commit: (args) => {
      const key = viewKeyOf(args.org, args.file);
      const head = heads.get(key) ?? { rev: 0, tree: null };
      if (args.baseRev !== head.rev) return { conflict: { currentRevision: head.rev } };
      let tree = parseMosaicNode(head.tree);
      for (const op of args.ops as KitOp[]) {
        const next = applyKitOp(tree, op);
        if (next === KIT_OP_FAILED) return { conflict: { currentRevision: head.rev } };
        tree = next;
      }
      heads.set(key, { rev: head.rev + 1, tree: serializeMosaicNode(tree) });
      return { rev: head.rev + 1 };
    },
    window_pins_read: () => pins,
    window_pins_write: (args) => {
      if (!on) return { refused: "flag-off" };
      pins = (args.keys as string[]).slice();
      return { ok: true };
    },
  };

  /** The hub's `group` view of a file, or undefined for any other topic. */
  const subscribe = (args: Record<string, unknown>) =>
    args.topic === "group"
      ? groupView(String(args.viewKey), heads.get(String(args.viewKey)))
      : undefined;

  if (on) {
    const write = async (teamKey: string, root: SavedMosaicNode | null) => {
      const { org, file } = await layoutFileRef({ kind: "foreground", teamKey, railKey: null });
      const viewKey = viewKeyOf(org, file);
      const head = { rev: (heads.get(viewKey)?.rev ?? 0) + 1, tree: root };
      heads.set(viewKey, head);
      const { snapshot } = groupView(viewKey, head);
      events.emit("codesense:delta", {
        topic: "group",
        viewKey,
        rev: head.rev,
        upserts: snapshot,
        removes: [],
      });
    };
    Object.assign(window, { __mockGroups: { write } });
  }

  return { handlers, subscribe };
}

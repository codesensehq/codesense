// SPDX-License-Identifier: MIT
import type { FrameRecord } from "@/tauri/commands";
import type { MockEventBus } from "../mock-events";
import { NotMockedError, type HandlerRegistry } from "../mock-router";
import type { MockState } from "../mock-state";

/**
 * A dashboard's `files` surface in mock mode, enough for a doc to read a team file and hear it
 * change: `files.read` (`file_surface_call` "read") and the `files` topic, over the mock's
 * content store. Paths are relative to the frame's content root, as in the app; a write through
 * `write_content_file` pushes the changed row to every `files` view over its folder, as the
 * app's `context-file-change` watcher does.
 *
 * It wraps `fallback`'s `mint_frame` (to learn each frame's content root), `live_hub_subscribe`,
 * `live_hub_unsubscribe` and `write_content_file`.
 */

interface FileView {
  viewKey: string;
  /** The folder the view lists, absolute. */
  dir: string;
  rev: number;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `path` under `root`, refused when it is absolute or climbs out. */
function inside(root: string, path: string): string {
  if (path.startsWith("/") || path.split("/").includes(".."))
    throw new Error(`denied: ${path} is outside the team content`);
  return `${root.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`.replace(/\/$/, "");
}

export function fileSurfaceHandlers(
  state: MockState,
  events: MockEventBus,
  fallback: HandlerRegistry,
): HandlerRegistry {
  const roots = new Map<string, string>();
  const views = new Map<string, FileView>();
  const subscriptions = new Map<string, string>();
  const rootOf = (frameId: unknown) => {
    const root = roots.get(String(frameId));
    if (!root) throw new Error("denied: frame released");
    return root;
  };
  const row = (view: FileView, path: string) => {
    const relativePath = path.slice(view.dir.length + 1);
    return { id: relativePath, relativePath, name: relativePath, kind: "file" };
  };
  const listed = (view: FileView) =>
    state.contentFiles
      .list()
      .filter((file) => file.path.startsWith(`${view.dir}/`))
      .filter((file) => !file.path.slice(view.dir.length + 1).includes("/"))
      .map((file) => row(view, file.path));
  return {
    mint_frame: async (args) => {
      const frame = (await fallback.mint_frame(args)) as FrameRecord;
      roots.set(frame.frameId, frame.contentRoot);
      return frame;
    },
    file_surface_call: async ({ operation, args: raw, frameId }) => {
      if (operation !== "read") throw new NotMockedError(`file_surface_call ${String(operation)}`);
      const args = (raw ?? {}) as { path?: unknown };
      if (typeof args.path !== "string" || !args.path)
        throw new Error("invalid: files.read needs {path}");
      const file = state.contentFiles.get(inside(rootOf(frameId), args.path));
      if (!file) throw new Error(`not found: ${args.path}`);
      return {
        text: file.content,
        sha256: await sha256(file.content),
        size: new TextEncoder().encode(file.content).length,
        truncated: false,
      };
    },
    file_surface_prepare_view: ({ frameId, args: raw }) => {
      const args = (raw ?? {}) as { dir?: unknown };
      const dir = inside(rootOf(frameId), typeof args.dir === "string" ? args.dir : "");
      const viewKey = `mock|files:${dir}`;
      if (!views.has(viewKey)) views.set(viewKey, { viewKey, dir, rev: 0 });
      return viewKey;
    },
    live_hub_subscribe: (args) => {
      const view = views.get(String(args.viewKey));
      if (args.topic !== "files" || !view) return fallback.live_hub_subscribe(args);
      if (args.subscriptionId) subscriptions.set(String(args.subscriptionId), view.viewKey);
      return { topic: "files", viewKey: view.viewKey, rev: view.rev, snapshot: listed(view) };
    },
    live_hub_unsubscribe: (args) => {
      if (subscriptions.delete(String(args.subscriptionId))) return undefined;
      return fallback.live_hub_unsubscribe(args);
    },
    write_content_file: async (args) => {
      const result = await fallback.write_content_file(args);
      const path = String(args.path);
      for (const view of views.values()) {
        if (path.slice(0, path.lastIndexOf("/")) !== view.dir) continue;
        const baseRev = view.rev++;
        const delta = {
          topic: "files",
          viewKey: view.viewKey,
          rev: view.rev,
          upserts: [row(view, path)],
          removes: [],
        };
        for (const [subscriptionId, viewKey] of subscriptions)
          if (viewKey === view.viewKey)
            events.emit("codesense:subscription-delta", { subscriptionId, baseRev, delta });
      }
      return result;
    },
  };
}

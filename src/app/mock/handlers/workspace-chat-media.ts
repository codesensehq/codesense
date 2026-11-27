// SPDX-License-Identifier: MIT
import type { HandlerRegistry } from "../mock-router";
import type { MockEventBus } from "../mock-events";
import { CHAT_MEDIA_WS, DAMAGED_SHA, chatMediaFixtures } from "../chat-media-fixtures";
import type { WorkspaceChatMessage } from "@/tauri/commands";

/** `?harness=chat-media` only: the workspace chat world its handlers serve. */
export function isChatMediaWorld(search: string): boolean {
  return new URLSearchParams(search).get("harness") === "chat-media";
}

/** How long a tapped load takes before the image arrives. */
const LOAD_MS = 1500;

/** A frame as the media read sends it: the MIME, a newline, then the bytes. */
const frame = (mime: string, bytes: Uint8Array): ArrayBuffer => {
  const head = new TextEncoder().encode(`${mime}\n`);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head);
  out.set(bytes, head.length);
  return out.buffer;
};

/** A stand-in image for message `id`: a gradient with its id, drawn at its stored size. */
async function picture(id: number, width: number, height: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext("2d")!;
  const hue = (id * 67) % 360;
  const fill = g.createLinearGradient(0, 0, width, height);
  fill.addColorStop(0, `hsl(${hue} 70% 55%)`);
  fill.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 35%)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, width, height);
  g.fillStyle = "rgba(255 255 255 / 0.9)";
  g.font = `600 ${Math.round(height / 6)}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(`GIF #${id}`, width / 2, height / 2);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The workspace chat of `?harness=chat-media`: one image post per media state. A read returns
 * the posts as the presented read does; a media read draws the image (the damaged one's bytes
 * don't decode); a load holds the image as loading for a moment, then caches it, sending the
 * chat-media event each time as the host does.
 */
export function workspaceChatMediaHandlers(events: MockEventBus): HandlerRegistry {
  const messages = new Map<number, WorkspaceChatMessage>(
    chatMediaFixtures().map(({ message }) => [message.messageId, message]),
  );
  const changed = (messageId: number, next: WorkspaceChatMessage) => {
    messages.set(messageId, next);
    events.emit("codesense:workspace-chat-media", { workspaceId: CHAT_MEDIA_WS, messageId });
  };
  return {
    workspace_chat_read: (args) => {
      const since = (args.since as number | null) ?? 0;
      const all = args.workspaceId === CHAT_MEDIA_WS ? [...messages.values()] : [];
      const page = all.filter((m) => m.messageId > since);
      return {
        workspaceId: args.workspaceId,
        messages: page.slice(0, (args.limit as number | null) ?? page.length),
        headId: all.length,
        archived: false,
        humanReadId: all.length,
      };
    },
    workspace_chat_mark_viewed: () => undefined,
    read_workspace_chat_media: async (args) => {
      const m = messages.get(args.messageId as number);
      const a = m?.attachments?.[0];
      if (!m || !a || a.sha256 !== args.sha256) throw new Error("media unavailable");
      if (a.sha256 === DAMAGED_SHA) return frame("image/gif", new TextEncoder().encode("GIF89a"));
      return frame("image/png", await picture(m.messageId, a.width ?? 480, a.height ?? 270));
    },
    load_workspace_chat_media: (args) => {
      const id = args.messageId as number;
      const m = messages.get(id);
      const a = m?.attachments?.[0];
      if (!m || !a) throw new Error("media unavailable");
      changed(id, { ...m, mediaState: "pending", attachments: [{ ...a, state: "pending" }] });
      setTimeout(() => {
        const cached = { ...a, state: "cached", width: 480, height: 270 } as const;
        changed(id, {
          ...m,
          mediaState: "cached",
          attachments: [{ ...cached, sha256: id.toString(16).padStart(64, "c") }],
        });
      }, LOAD_MS);
      return undefined;
    },
  };
}

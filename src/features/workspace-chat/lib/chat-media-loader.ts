// SPDX-License-Identifier: MIT
import { isCachedImage, type MediaLoader } from "@/features/inbox/components/message-media";
import {
  loadWorkspaceChatMedia,
  readWorkspaceChatMedia,
  type InboxMediaAttachment,
  type WorkspaceChatMessage,
} from "@/tauri/commands";

/** The chat's loader for `message`'s image: read and load it by workspace and message id.
 *  `machine` is the row's machine label for a sender on another machine. */
export function chatMediaLoader(
  message: WorkspaceChatMessage,
  machine?: string | null,
): MediaLoader {
  return {
    read: (sha256) => readWorkspaceChatMedia(message.workspaceId, message.messageId, sha256),
    load: () => loadWorkspaceChatMedia(message.workspaceId, message.messageId),
    teamLabel: message.mediaTeam?.team ?? "this",
    machine,
  };
}

/** `message`'s image as the media bubble shows it, from the chat read's presented attachment
 *  and the stored `mediaState`: media Off is `blocked` whatever was stored; a fetch in flight
 *  is `loading` (no Load); a held image is `tapToLoad`; a cached one with no hash is gone
 *  from the cache. */
export function chatMediaAttachment(message: WorkspaceChatMessage): InboxMediaAttachment | null {
  const a = message.attachments?.[0];
  if (!a) return null;
  if (a.state === "blocked") return a;
  switch (message.mediaState) {
    case "cached": {
      const cached: InboxMediaAttachment = { ...a, state: "cached" };
      return isCachedImage(cached)
        ? cached
        : { ...a, state: "failed", reason: "cache", retryable: false };
    }
    case "pending":
      return { ...a, state: "loading" };
    case "tapToLoad":
      return { ...a, state: "tapToLoad" };
    case "failed":
      return { ...a, state: "failed" };
    default:
      return a;
  }
}

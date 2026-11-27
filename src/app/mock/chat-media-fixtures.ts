// SPDX-License-Identifier: MIT
import type { InboxMediaAttachment, WorkspaceChatMessage } from "@/tauri/commands";

/** The workspace whose chat shows one image post per media state, for `?harness=chat-media`. */
export const CHAT_MEDIA_WS = "story:chat-media";

/** The hash the mock reads back as bytes that won't decode. */
export const DAMAGED_SHA = "d".repeat(64);

const sha = (n: number) => n.toString(16).padStart(64, "a");
const team = { org: "acme", team: "crew" };
const AT = Date.UTC(2026, 10, 27, 9, 0);

const gif = (over: Partial<InboxMediaAttachment>): InboxMediaAttachment => ({
  kind: "image",
  mime: "image/gif",
  alt: "A cat types on a laptop",
  sourceUrl: "https://media.giphy.com/media/g1/giphy.gif",
  sourceHost: "media.giphy.com",
  provider: "giphy",
  state: "cached",
  retryable: false,
  ...over,
});

const post = (
  messageId: number,
  from: string,
  text: string,
  attachment: InboxMediaAttachment,
  mediaState: WorkspaceChatMessage["mediaState"],
): WorkspaceChatMessage => ({
  messageId,
  workspaceId: CHAT_MEDIA_WS,
  from,
  fromName: from,
  createdAtMs: AT + messageId * 60_000,
  text,
  kind: "chat",
  attachments: [attachment],
  mediaTeam: team,
  mediaState,
});

/** One post per state, in the order the harness lists them. The keys name each post's state
 *  for a capture (`data-state` on its row). */
export function chatMediaFixtures(): Array<{ state: string; message: WorkspaceChatMessage }> {
  return [
    {
      state: "loaded-text",
      message: post(
        1,
        "builder",
        "Tests pass on the media branch.",
        gif({ sha256: sha(1), width: 480, height: 270 }),
        "cached",
      ),
    },
    {
      state: "loaded",
      message: post(2, "reviewer", "", gif({ sha256: sha(2), width: 480, height: 270 }), "cached"),
    },
    {
      state: "klipy",
      message: post(
        3,
        "builder",
        "",
        gif({
          sha256: sha(3),
          width: 300,
          height: 300,
          alt: "A dog nods",
          sourceUrl: "https://static.klipy.com/ii/d1/dog.gif",
          sourceHost: "static.klipy.com",
          provider: "klipy",
        }),
        "cached",
      ),
    },
    {
      state: "tap-to-load",
      message: post(4, "remote", "", gif({ state: "pending", reason: "sender" }), "tapToLoad"),
    },
    {
      state: "tap-to-load-host",
      message: post(
        5,
        "reviewer",
        "",
        gif({
          state: "pending",
          reason: "host",
          provider: undefined,
          alt: "A chart of build times",
          sourceUrl: "https://cdn.example.com/chart.gif",
          sourceHost: "cdn.example.com",
        }),
        "tapToLoad",
      ),
    },
    {
      state: "loading",
      message: post(6, "builder", "", gif({ state: "pending" }), "pending"),
    },
    {
      state: "failed",
      message: post(
        7,
        "reviewer",
        "",
        gif({ state: "failed", reason: "fetch", retryable: true }),
        "failed",
      ),
    },
    {
      state: "damaged",
      message: post(8, "builder", "", gif({ sha256: DAMAGED_SHA }), "cached"),
    },
    {
      state: "blocked",
      message: post(9, "reviewer", "", gif({ state: "blocked" }), "cached"),
    },
  ];
}

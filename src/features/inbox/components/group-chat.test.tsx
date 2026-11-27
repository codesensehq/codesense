// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import type { InboxMediaAttachment, WorkspaceChatMessage } from "@/tauri/commands";

const messages = vi.hoisted(() => ({ current: [] as WorkspaceChatMessage[] }));
vi.mock("@/features/workspace-chat/hooks/use-workspace-chat", () => ({
  useWorkspaceChat: () => ({
    messages: messages.current,
    headId: messages.current.length,
    loading: false,
    error: null,
    archived: false,
    reload: async () => {},
  }),
}));

import { GroupRow } from "./group-chat";

const gif = (over: Partial<InboxMediaAttachment> = {}): InboxMediaAttachment => ({
  kind: "image",
  mime: "image/gif",
  alt: "A cat waves",
  state: "cached",
  ...over,
});
const msg = (over: Partial<WorkspaceChatMessage>): WorkspaceChatMessage => ({
  messageId: 1,
  workspaceId: "story:ws-1",
  from: "agent-a",
  fromName: "agent a",
  createdAtMs: 1_700_000_000_000,
  text: "Tests pass",
  kind: "chat",
  ...over,
});

function preview(last: Partial<WorkspaceChatMessage>) {
  messages.current = [msg(last)];
  const { container, unmount } = render(
    <GroupRow
      room={{ workspaceId: "story:ws-1", sessions: [] }}
      selected={false}
      onOpen={() => {}}
    />,
  );
  const text = container.querySelector(".pv")!.textContent;
  unmount();
  return text;
}

describe("GroupRow preview", () => {
  beforeEach(() => {
    messages.current = [];
  });

  it("shows the last post's sender and text", () => {
    expect(preview({})).toBe("agent a: Tests pass");
  });

  it("names a media-only post's kind and alt", () => {
    expect(preview({ text: "", attachments: [gif()] })).toBe("agent a: GIF · A cat waves");
    expect(preview({ text: " ", attachments: [gif({ mime: "image/png", alt: "A chart" })] })).toBe(
      "agent a: Image · A chart",
    );
  });

  it("keeps a post's text when it carries an image too", () => {
    expect(preview({ attachments: [gif()] })).toBe("agent a: Tests pass");
  });

  it("says New chat when there is no post yet", () => {
    expect(preview({ kind: "system", text: "Chat started." })).toBe("New chat");
  });
});

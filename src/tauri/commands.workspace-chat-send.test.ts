// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { workspaceChatSend } from "./commands";

const team = { org: "acme", team: "core" };
const media = {
  url: "https://media.giphy.com/media/g1/giphy.gif",
  alt: "Typing cat",
  provider: "giphy" as const,
  providerId: "g1",
};

describe("workspaceChatSend", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ messageId: 2, createdAtMs: 1, headId: 2 });
  });

  it("forwards media and the team, and never attachments", async () => {
    await workspaceChatSend("story:a", "", { media, team });
    expect(invokeMock).toHaveBeenCalledWith("workspace_chat_send", {
      workspaceId: "story:a",
      text: "",
      contentType: null,
      onClick: null,
      primaryFile: null,
      media,
      team,
    });
    expect(invokeMock.mock.calls[0][1]).not.toHaveProperty("attachments");
  });

  it("sends null media and team for a text-only post", async () => {
    await workspaceChatSend("story:a", "hi");
    expect(invokeMock).toHaveBeenCalledWith("workspace_chat_send", {
      workspaceId: "story:a",
      text: "hi",
      contentType: null,
      onClick: null,
      primaryFile: null,
      media: null,
      team: null,
    });
  });
});

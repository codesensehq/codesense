// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { InboxMediaAttachment, WorkspaceChatMessage } from "@/tauri/commands";
import { WorkspaceChatMessageRow } from "./workspace-chat-message-row";

vi.mock("@/features/weft/components/inbox-message-content", () => ({
  InboxMessageContent: ({ text }: { text: string }) => (
    <span data-testid="inbox-content">{text}</span>
  ),
}));

const gif: InboxMediaAttachment = {
  kind: "image",
  alt: "A cat waves",
  state: "pending",
  sourceHost: "i.giphy.com",
};

function row(overrides: Partial<WorkspaceChatMessage>) {
  const message: WorkspaceChatMessage = {
    messageId: 7,
    workspaceId: "story:ws-1",
    from: "agent-a",
    fromName: "agent a",
    createdAtMs: 1_700_000_000_000,
    text: "Tests pass",
    kind: "chat",
    ...overrides,
  };
  render(
    <WorkspaceChatMessageRow
      message={message}
      isLead
      isHuman={false}
      avatarGlyph="A"
      roleColour="#888"
    />,
  );
}

describe("WorkspaceChatMessageRow media placeholder", () => {
  it("shows the image's alt under the text", () => {
    row({ attachments: [gif] });
    expect(screen.getByTestId("inbox-content")).toHaveTextContent("Tests pass");
    expect(screen.getByTestId("workspace-chat-media")).toHaveTextContent("GIF: A cat waves");
  });

  it("shows the alt alone when the message has no text", () => {
    row({ text: "", attachments: [gif] });
    expect(screen.queryByTestId("inbox-content")).toBeNull();
    expect(screen.getByTestId("workspace-chat-message")).toHaveTextContent("GIF: A cat waves");
  });

  it("shows the alt alone when the message text is only whitespace", () => {
    row({ text: "  \n\t", attachments: [gif] });
    expect(screen.queryByTestId("inbox-content")).toBeNull();
    expect(screen.getByTestId("workspace-chat-media")).toHaveTextContent("GIF: A cat waves");
  });

  it("shows an alt with markdown and HTML as literal text", () => {
    const alt = '**bold** [link](https://example.com) <img src="x.gif"><a href="#">a</a>';
    row({ text: "", attachments: [{ ...gif, alt }] });
    const media = screen.getByTestId("workspace-chat-media");
    expect(media.textContent).toBe(`GIF: ${alt}`);
    expect(media).toHaveAttribute("title", alt);
    const message = screen.getByTestId("workspace-chat-message");
    expect(message.querySelector("a")).toBeNull();
    expect(message.querySelector("img")).toBeNull();
  });

  it("leaves a text-only message as it was", () => {
    row({});
    expect(screen.getByTestId("inbox-content")).toHaveTextContent("Tests pass");
    expect(screen.queryByTestId("workspace-chat-media")).toBeNull();
  });
});

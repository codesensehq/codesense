// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test-utils";
import type { InboxMediaAttachment, WorkspaceChatMessage } from "@/tauri/commands";
import { formatClock } from "@/features/inbox/model";
import type { ChatIdentity } from "./workspace-chat-body";
import { WorkspaceChatMessageRow } from "./workspace-chat-message-row";

const readWorkspaceChatMedia = vi.hoisted(() => vi.fn());
const loadWorkspaceChatMedia = vi.hoisted(() => vi.fn());
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  readWorkspaceChatMedia,
  loadWorkspaceChatMedia,
}));
vi.mock("@/features/weft/components/inbox-message-content", () => ({
  InboxMessageContent: ({ text }: { text: string }) => (
    <span data-testid="inbox-content">{text}</span>
  ),
}));

const SHA = "c".repeat(64);
const AT = 1_700_000_000_000;

const gif = (over: Partial<InboxMediaAttachment> = {}): InboxMediaAttachment => ({
  kind: "image",
  sha256: SHA,
  mime: "image/gif",
  width: 320,
  height: 180,
  alt: "A cat waves",
  sourceUrl: "https://i.giphy.com/cat.gif",
  sourceHost: "i.giphy.com",
  state: "cached",
  retryable: false,
  ...over,
});

/** A held GIF as the chat read presents it: stored `tapToLoad`, attachment `pending`. */
const held = (over: Partial<InboxMediaAttachment> = {}) => ({
  attachments: [gif({ state: "pending", sha256: undefined, reason: "sender", ...over })],
  mediaState: "tapToLoad" as const,
});

function row(overrides: Partial<WorkspaceChatMessage>, identity?: ChatIdentity) {
  const message: WorkspaceChatMessage = {
    messageId: 7,
    workspaceId: "story:ws-1",
    from: "agent-a",
    fromName: "agent a",
    createdAtMs: AT,
    text: "Tests pass",
    kind: "chat",
    mediaTeam: { org: "acme", team: "crew" },
    ...overrides,
  };
  return render(
    <WorkspaceChatMessageRow
      identity={identity}
      message={message}
      isLead
      isHuman={false}
      avatarGlyph="A"
      roleColour="#888"
    />,
  );
}

const cached = { attachments: [gif()], mediaState: "cached" as const };
const content = () =>
  screen.getByTestId("workspace-chat-message").querySelector(".wc-msg__content")!;

/** Turn the OS Reduce Motion setting on for the rest of the test. */
function reduceMotion() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  readWorkspaceChatMedia.mockReset().mockResolvedValue(new Blob(["GIF89a"], { type: "image/gif" }));
  loadWorkspaceChatMedia.mockReset().mockResolvedValue(undefined);
  URL.createObjectURL = vi.fn(() => "blob:cat");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspaceChatMessageRow media bubble", () => {
  it("shows the image under the text, inside the content column, at the inbox's box", async () => {
    row(cached);
    const img = await screen.findByAltText("A cat waves");
    const figure = img.closest("figure")!;
    expect(content().contains(figure)).toBe(true);
    expect(screen.getByTestId("inbox-content")).toHaveTextContent("Tests pass");
    expect(
      screen.getByTestId("inbox-content").compareDocumentPosition(figure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(figure.style.getPropertyValue("--max-h")).toBe("");
    expect(readWorkspaceChatMedia).toHaveBeenCalledWith("story:ws-1", 7, SHA);
  });

  it("shows a media-only message's image alone, capped at 160px tall", async () => {
    row({ text: "  \n", ...cached });
    const figure = (await screen.findByAltText("A cat waves")).closest("figure")!;
    expect(screen.queryByTestId("inbox-content")).toBeNull();
    expect(figure.style.getPropertyValue("--max-h")).toBe("160px");
  });

  it("leaves a text-only message as it was", () => {
    row({});
    expect(screen.getByTestId("inbox-content")).toHaveTextContent("Tests pass");
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.queryByTestId("ibx-media-card")).toBeNull();
  });

  it("no longer shows the GIF: <alt> stand-in", async () => {
    row({ text: "", ...cached });
    await screen.findByAltText("A cat waves");
    expect(screen.queryByTestId("workspace-chat-media")).toBeNull();
    expect(screen.getByTestId("workspace-chat-message").textContent).not.toContain("GIF: ");
  });

  it("reserves a cached image's stored size, lazily loaded, named Open GIF", async () => {
    row(cached);
    const img = await screen.findByAltText("A cat waves");
    const figure = img.closest("figure")!;
    expect(figure.style.getPropertyValue("--w")).toBe("320");
    expect(figure.style.getPropertyValue("--h")).toBe("180");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(screen.getByRole("button", { name: "Open GIF: A cat waves" })).toBeTruthy();
  });

  it("gives an image still loading on its own the default box, named, with no Load", () => {
    row({
      text: "",
      attachments: [
        gif({ state: "pending", sha256: undefined, width: undefined, height: undefined }),
      ],
      mediaState: "pending",
    });
    const figure = screen.getByRole("figure", { name: "Loading GIF: A cat waves" });
    expect(figure.style.getPropertyValue("--w")).toBe("480");
    expect(figure.style.getPropertyValue("--h")).toBe("270");
    expect(figure.style.getPropertyValue("--max-h")).toBe("160px");
    expect(screen.queryByRole("button", { name: /Load/ })).toBeNull();
    expect(readWorkspaceChatMedia).not.toHaveBeenCalled();
  });
});

describe("WorkspaceChatMessageRow lightbox and attribution", () => {
  it("opens the full image with its sender, time, alt, kind, size and source; Esc returns focus", async () => {
    row(cached, { name: "Builder", color: "#123", initials: "B", machine: "studio" });
    await screen.findByAltText("A cat waves");
    const open = screen.getByRole("button", { name: "Open GIF: A cat waves" });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", {
      name: `GIF from Builder, ${formatClock(AT)}`,
    });
    expect(dialog.textContent).toContain("A cat waves");
    expect(dialog.textContent).toContain("GIF · 320 × 180 · Powered by GIPHY");
    expect(
      screen.getByRole("link", { name: "Open source page · i.giphy.com ↗" }).getAttribute("href"),
    ).toBe("https://i.giphy.com/cat.gif");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("shows Powered by GIPHY under the bubble in every state", () => {
    const states: Array<Partial<WorkspaceChatMessage>> = [
      cached,
      held(),
      { attachments: [gif({ state: "failed", reason: "size" })], mediaState: "failed" },
      { attachments: [gif({ state: "blocked", sha256: undefined })], mediaState: "cached" },
      {
        attachments: [gif({ state: "pending", sha256: undefined })],
        mediaState: "pending",
      },
    ];
    for (const state of states) {
      const { unmount } = row(state);
      expect(screen.getByText("Powered by GIPHY")).toBeTruthy();
      unmount();
    }
  });

  it("credits KLIPY in the lightbox source line only", async () => {
    row({
      attachments: [
        gif({ sourceUrl: "https://static.klipy.com/cat.gif", sourceHost: "static.klipy.com" }),
      ],
      mediaState: "cached",
    });
    await screen.findByAltText("A cat waves");
    expect(screen.queryByText(/KLIPY/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open GIF: A cat waves" }));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "GIF · 320 × 180 · via KLIPY",
    );
  });
});

describe("WorkspaceChatMessageRow under Reduce Motion", () => {
  it("plays a GIF on its own when Reduce Motion is off", async () => {
    row(cached);
    fireEvent.load(await screen.findByAltText("A cat waves"));
    expect(screen.queryByRole("button", { name: /Play GIF|Pause GIF/ })).toBeNull();
  });

  it("shows a still frame with a pressed-state Play that animates it", async () => {
    reduceMotion();
    row(cached);
    const img = await screen.findByAltText("A cat waves");
    fireEvent.load(img);
    const figure = img.closest("figure")!;
    const play = screen.getByRole("button", { name: "Play GIF" });
    expect(play.getAttribute("aria-pressed")).toBe("false");
    expect(figure.className).toContain("still");
    fireEvent.click(play);
    expect(screen.getByRole("button", { name: "Pause GIF" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(figure.className).not.toContain("still");
  });
});

describe("WorkspaceChatMessageRow tap to load", () => {
  it("reads nothing before the tap, and loads once on it", () => {
    row(
      { text: "", ...held() },
      { name: "Builder", color: "#123", initials: "B", machine: "studio" },
    );
    expect(screen.getByTestId("ibx-media-card").textContent).toContain("A cat waves");
    expect(readWorkspaceChatMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load GIF from i.giphy.com: A cat waves" }));
    expect(loadWorkspaceChatMedia).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceChatMedia).toHaveBeenCalledWith("story:ws-1", 7);
    expect(readWorkspaceChatMedia).not.toHaveBeenCalled();
  });

  it("names a remote sender's machine", () => {
    row(
      { text: "", ...held() },
      { name: "Builder", color: "#123", initials: "B", machine: "studio" },
    );
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "GIF · sent from studio, not loaded here yet",
    );
  });

  it("keeps the inbox's reason for a sender with no machine label", () => {
    row({ text: "", ...held() }, { name: "Builder", color: "#123", initials: "B" });
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "GIF · from another person's machine",
    );
  });

  it("shows an alt with markdown and HTML as literal text", () => {
    const alt = '**bold** [link](https://example.com) <img src="x.gif"><a href="#">a</a>';
    row({ text: "", ...held({ alt }) });
    expect(screen.getByTestId("ibx-media-card").querySelector(".alt")!.textContent).toBe(alt);
    const message = screen.getByTestId("workspace-chat-message");
    expect(message.querySelector("a[href='#']")).toBeNull();
    expect(message.querySelector("img")).toBeNull();
  });

  it("keeps the inbox's reason for a host off the auto-load list", () => {
    row(
      { text: "", ...held({ reason: "host" }) },
      { name: "Builder", color: "#123", initials: "B", machine: "studio" },
    );
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "GIF · not on your auto-load list",
    );
  });
});

describe("WorkspaceChatMessageRow failed and blocked", () => {
  it("shows a failed fetch's reason, with Retry only when it can be retried", () => {
    const { unmount } = row({
      text: "",
      attachments: [gif({ state: "failed", sha256: undefined, reason: "size", retryable: true })],
      mediaState: "failed",
    });
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "Couldn't load this GIF. The file is over 8 MB.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadWorkspaceChatMedia).toHaveBeenCalledWith("story:ws-1", 7);
    unmount();
    row({
      text: "",
      attachments: [gif({ state: "failed", sha256: undefined, reason: "fetch" })],
      mediaState: "failed",
    });
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "Couldn't load this GIF. i.giphy.com didn't answer.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the failed card when the image won't decode", async () => {
    row({ text: "", ...cached });
    fireEvent.error(await screen.findByAltText("A cat waves"));
    expect((await screen.findByTestId("ibx-media-card")).textContent).toContain(
      "Couldn't show this GIF. The file is damaged.",
    );
    expect(screen.getByRole("link", { name: "i.giphy.com ↗" })).toBeTruthy();
  });

  it("keeps the inbox's copy when the image can't be read", async () => {
    readWorkspaceChatMedia.mockRejectedValue(new Error("media unavailable"));
    row({ text: "", ...cached });
    expect(await screen.findByText("Couldn't load this image. A cat waves")).toBeTruthy();
  });

  it("treats a cached state with no hash as gone from the cache", () => {
    row({ text: "", attachments: [gif({ sha256: undefined })], mediaState: "cached" });
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "This image is no longer in the cache.",
    );
    expect(readWorkspaceChatMedia).not.toHaveBeenCalled();
  });

  it("shows media Off as blocked, naming the row's media team, with its source", () => {
    row({
      text: "",
      attachments: [gif({ state: "blocked", sha256: undefined })],
      mediaState: "cached",
    });
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "GIF · media is off in crew's team config",
    );
    expect(screen.getByRole("link", { name: "i.giphy.com ↗" }).getAttribute("href")).toBe(
      "https://i.giphy.com/cat.gif",
    );
    expect(screen.queryByRole("button", { name: /Load/ })).toBeNull();
    expect(readWorkspaceChatMedia).not.toHaveBeenCalled();
  });
});

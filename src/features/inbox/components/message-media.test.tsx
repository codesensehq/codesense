// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const readInboxMedia = vi.hoisted(() => vi.fn());
const loadInboxMedia = vi.hoisted(() => vi.fn());
const readWorkspaceChatMedia = vi.hoisted(() => vi.fn());
const loadWorkspaceChatMedia = vi.hoisted(() => vi.fn());
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  readInboxMedia,
  loadInboxMedia,
  readWorkspaceChatMedia,
  loadWorkspaceChatMedia,
}));

import type { InboxMediaAttachment, WorkspaceChatMessage } from "@/tauri/commands";
import { chatMediaLoader } from "@/features/workspace-chat/lib/chat-media-loader";
import { fixtureMessages } from "../fixtures";
import { formatClock } from "../model";
import { isCachedImage, mediaReason, MessageMedia, type MediaLoader } from "./message-media";
import { inboxMediaLoader } from "./primitives";

const SHA = "b".repeat(64);
const inboxMessage = { ...fixtureMessages()[0]!, via: null, id: 7, text: "" };
const chatMessage: WorkspaceChatMessage = {
  messageId: 7,
  workspaceId: "story:ws-1",
  from: "agent-a",
  fromName: "agent a",
  createdAtMs: inboxMessage.createdAtMs,
  text: "",
  kind: "chat",
  mediaTeam: { org: "acme", team: "crew" },
};
const sender = { name: "agent a", atMs: inboxMessage.createdAtMs };

const image = (over: Partial<InboxMediaAttachment> = {}): InboxMediaAttachment => ({
  kind: "image",
  sha256: SHA,
  mime: "image/gif",
  width: 320,
  height: 180,
  alt: "a dog nods",
  sourceUrl: "https://media.example/dog.gif",
  sourceHost: "media.example",
  state: "cached",
  retryable: false,
  ...over,
});

/** The two loaders the bubble serves, each with the command it must read and load through. */
const LOADERS: Array<{
  name: string;
  loader: () => MediaLoader;
  held: InboxMediaAttachment["state"];
  read: ReturnType<typeof vi.fn>;
  readArgs: unknown[];
  load: ReturnType<typeof vi.fn>;
  loadArgs: unknown[];
}> = [
  {
    name: "inbox",
    loader: () => inboxMediaLoader(inboxMessage),
    held: "pending",
    read: readInboxMedia,
    readArgs: [inboxMessage.team, 7, SHA],
    load: loadInboxMedia,
    loadArgs: [inboxMessage.team, 7],
  },
  {
    name: "chat",
    loader: () => chatMediaLoader(chatMessage),
    held: "tapToLoad",
    read: readWorkspaceChatMedia,
    readArgs: ["story:ws-1", 7, SHA],
    load: loadWorkspaceChatMedia,
    loadArgs: ["story:ws-1", 7],
  },
];

beforeEach(() => {
  for (const read of [readInboxMedia, readWorkspaceChatMedia]) {
    read.mockReset().mockResolvedValue(new Blob(["GIF89a"], { type: "image/gif" }));
  }
  for (const load of [loadInboxMedia, loadWorkspaceChatMedia]) {
    load.mockReset().mockResolvedValue(undefined);
  }
  URL.createObjectURL = vi.fn(() => "blob:dog");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe.each(LOADERS)("MessageMedia with the $name loader", (c) => {
  it("reads a cached image through its loader, and opens it in the lightbox", async () => {
    render(<MessageMedia a={image()} loader={c.loader()} sender={sender} />);
    const img = await screen.findByAltText("a dog nods");
    expect(c.read).toHaveBeenCalledWith(...c.readArgs);
    expect(img.getAttribute("loading")).toBe("lazy");
    const open = screen.getByRole("button", { name: "Open GIF: a dog nods" });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", {
      name: `GIF from agent a, ${formatClock(sender.atMs)}`,
    });
    expect(dialog.textContent).toContain("GIF · 320 × 180");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("loads a held image through its loader, reading nothing before the tap", () => {
    render(<MessageMedia a={image({ state: c.held, sha256: undefined })} loader={c.loader()} />);
    expect(c.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Load GIF from media\.example/ }));
    expect(c.load).toHaveBeenCalledTimes(1);
    expect(c.load).toHaveBeenCalledWith(...c.loadArgs);
  });

  it("gives only the card being loaded a live region, and announces the image there", async () => {
    const loader = c.loader();
    const held = image({ state: c.held, sha256: undefined, alt: "held" });
    const list = (tapped: InboxMediaAttachment) => (
      <div>
        <MessageMedia a={image({ alt: "history" })} loader={loader} />
        <MessageMedia a={image({ state: "blocked", sha256: undefined })} loader={loader} />
        <MessageMedia a={image({ state: "failed", retryable: true })} loader={loader} />
        <MessageMedia a={tapped} loader={loader} />
      </div>
    );
    const { container, rerender } = render(list(held));
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Load GIF from media.example: held" }));
    const regions = container.querySelectorAll("[aria-live]");
    expect(regions).toHaveLength(1);
    expect(regions[0]!.textContent).toBe("Loading GIF…");
    rerender(list(image({ alt: "held" })));
    await waitFor(() =>
      expect(container.querySelector("[aria-live]")!.textContent).toBe("GIF loaded: held"),
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("names a still image, not a GIF, while it loads", async () => {
    const png = (over: Partial<InboxMediaAttachment>) =>
      image({ mime: "image/png", alt: "a chart", ...over });
    const { container, rerender } = render(
      <MessageMedia a={png({ state: c.held, sha256: undefined })} loader={c.loader()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Load Image from/ }));
    expect(container.querySelector("[aria-live]")!.textContent).toBe("Loading Image…");
    rerender(<MessageMedia a={png({ state: "loading", sha256: undefined })} loader={c.loader()} />);
    await waitFor(() =>
      expect(screen.getByTestId("ibx-media-live").textContent).toBe("Loading Image…"),
    );
  });

  it("announces a failed load in the tapped card's region", async () => {
    c.load.mockRejectedValue(new Error("media is off in team config"));
    const { container } = render(
      <MessageMedia a={image({ state: c.held, sha256: undefined })} loader={c.loader()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Load GIF from/ }));
    await waitFor(() =>
      expect(container.querySelector("[aria-live]")!.textContent).toBe(
        "media is off in team config",
      ),
    );
  });

  it("swaps an image that won't decode for the failed card, with its source", async () => {
    render(<MessageMedia a={image()} loader={c.loader()} />);
    fireEvent.error(await screen.findByAltText("a dog nods"));
    const card = await screen.findByTestId("ibx-media-card");
    expect(card.textContent).toContain("Couldn't show this GIF. The file is damaged.");
    expect(screen.getByRole("link", { name: "media.example ↗" }).getAttribute("href")).toBe(
      "https://media.example/dog.gif",
    );
    expect(screen.queryByRole("figure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("MessageMedia while an image loads on its own", () => {
  it("reserves a named figure showing the alt, with no Load and no read", () => {
    render(
      <MessageMedia
        a={image({ state: "loading", sha256: undefined, width: undefined, height: undefined })}
        loader={chatMediaLoader(chatMessage)}
      />,
    );
    const figure = screen.getByRole("figure", { name: "Loading GIF: a dog nods" });
    const copy = figure.querySelector(".ibx-media-spin")!;
    expect(copy.textContent).toBe("Loading GIF · a dog nods");
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(figure.classList.contains("loading")).toBe(true);
    expect(figure.style.getPropertyValue("--w")).toBe("480");
    expect(figure.style.getPropertyValue("--h")).toBe("270");
    expect(screen.queryByRole("button", { name: /Load/ })).toBeNull();
    expect(readWorkspaceChatMedia).not.toHaveBeenCalled();
  });
});

describe("isCachedImage", () => {
  it("is a cached image with a well-formed hash", () => {
    expect(isCachedImage(image())).toBe(true);
    expect(isCachedImage(image({ sha256: undefined }))).toBe(false);
    expect(isCachedImage(image({ sha256: "B".repeat(64) }))).toBe(false);
    expect(isCachedImage(image({ state: "pending" }))).toBe(false);
  });
});

describe("mediaReason with no team", () => {
  it("says the team config, not a team name, when the chat's post names no team", () => {
    const team = chatMediaLoader({ ...chatMessage, mediaTeam: undefined }).teamLabel;
    expect(team).toBeNull();
    expect(mediaReason(image({ state: "blocked" }), team)).toBe(
      "GIF · media is off in the team config",
    );
    expect(mediaReason(image({ state: "pending", reason: "ask" }), team)).toBe(
      "GIF · the team asks before loading",
    );
  });
});

describe("MessageMedia loading shimmer", () => {
  it("pulses a loading figure only when motion is allowed", () => {
    const css = readFileSync(resolve(__dirname, "../inbox.css"), "utf-8");
    const gated = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(gated).toMatch(/^[^}]*\{\s*\.ibx-media\.loading\s*\{\s*animation: ibx-shim/);
    const ungated = css.replace(
      /@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\n\}/g,
      "",
    );
    expect(ungated).not.toMatch(/\.ibx-media\.loading\s*\{[^}]*animation/);
  });
});

describe("MessageMedia size rule", () => {
  it("caps the figure's height when given one, and keeps the inbox box otherwise", async () => {
    const { rerender } = render(
      <MessageMedia a={image()} loader={chatMediaLoader(chatMessage)} maxHeight={160} />,
    );
    const figure = (await screen.findByAltText("a dog nods")).closest("figure")!;
    expect(figure.style.getPropertyValue("--max-h")).toBe("160px");
    rerender(<MessageMedia a={image()} loader={chatMediaLoader(chatMessage)} />);
    expect(figure.style.getPropertyValue("--max-h")).toBe("");
  });
});

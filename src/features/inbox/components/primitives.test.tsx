// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const readInboxMedia = vi.hoisted(() => vi.fn());
const loadInboxMedia = vi.hoisted(() => vi.fn());
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  readInboxMedia,
  loadInboxMedia,
}));
const openFile = vi.hoisted(() => vi.fn());
vi.mock("@/features/dashboard/components/html-bridge", () => ({
  HTML_BRIDGE_ALLOWLIST: { openFile },
}));
vi.mock("@/features/weft/components/inbox-message-content", () => ({
  InboxMessageContent: ({ text }: { text: string }) => <p>{text}</p>,
}));

import type { InboxMediaAttachment } from "@/tauri/commands";
import { fixtureMessages } from "../fixtures";
import { MessageBody } from "./primitives";

const SHA = "a".repeat(64);
const base = { ...fixtureMessages()[0]!, via: null, id: 7, text: "" };
const team = base.team;

const image = (over: Partial<InboxMediaAttachment> = {}): InboxMediaAttachment => ({
  kind: "image",
  sha256: SHA,
  mime: "image/gif",
  width: 320,
  height: 180,
  alt: "a cat waving",
  sourceUrl: "https://media.example/cat.gif",
  sourceHost: "media.example",
  state: "cached",
  retryable: false,
  ...over,
});
const withMedia = (a: InboxMediaAttachment, text = "") => ({ ...base, text, attachments: [a] });

beforeEach(() => {
  readInboxMedia.mockReset().mockResolvedValue({ mime: "image/gif", base64: btoa("GIF89a") });
  loadInboxMedia.mockReset().mockResolvedValue(undefined);
  openFile.mockReset().mockResolvedValue({});
  URL.createObjectURL = vi.fn(() => "blob:cat");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.clearAllMocks());

describe("MessageBody image attachments", () => {
  it("shows a cached image inline, read through the app by team, message and hash", async () => {
    render(<MessageBody m={withMedia(image(), "look")} />);
    expect(screen.getByText("look")).toBeTruthy();
    expect(screen.getByText("Loading GIF…")).toBeTruthy();
    const img = await screen.findByAltText("a cat waving");
    expect(readInboxMedia).toHaveBeenCalledWith(team, 7, SHA);
    expect(img.getAttribute("src")).toBe("blob:cat");
    fireEvent.load(img);
    expect(screen.queryByText("Loading GIF…")).toBeNull();
    expect(img.closest("figure")!.className).toBe("ibx-media");
  });

  it("leaves out the empty text of a media-only message", () => {
    const { container } = render(<MessageBody m={withMedia(image())} />);
    expect(container.querySelector("p")).toBeNull();
  });

  it("says when a cached image can't be read", async () => {
    readInboxMedia.mockRejectedValue(new Error("media unavailable"));
    render(<MessageBody m={withMedia(image())} />);
    expect(await screen.findByText("Couldn't load this image. a cat waving")).toBeTruthy();
  });

  it("revokes the image's object URL on unmount", async () => {
    const { unmount } = render(<MessageBody m={withMedia(image())} />);
    await screen.findByAltText("a cat waving");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cat");
  });

  it("opens the image in a lightbox that Esc closes", async () => {
    render(<MessageBody m={withMedia(image())} />);
    await screen.findByAltText("a cat waving");
    fireEvent.click(screen.getByRole("button", { name: "Open GIF: a cat waving" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("a cat waving");
    expect(dialog.textContent).toContain("GIF · 320 × 180");
    expect(
      screen.getByRole("link", { name: "Open source page · media.example ↗" }).getAttribute("href"),
    ).toBe("https://media.example/cat.gif");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("pending: says why and loads on request", async () => {
    render(<MessageBody m={withMedia(image({ state: "pending", sha256: undefined }))} />);
    const card = screen.getByTestId("ibx-media-card");
    expect(card.textContent).toContain("GIF · not on your auto-load list");
    fireEvent.click(
      screen.getByRole("button", { name: "Load GIF from media.example: a cat waving" }),
    );
    expect(loadInboxMedia).toHaveBeenCalledWith(team, 7);
    expect(card.textContent).toContain("Loading GIF…");
    expect(readInboxMedia).not.toHaveBeenCalled();
  });

  it("pending: shows the load error and lets the person try again", async () => {
    loadInboxMedia.mockRejectedValue(new Error("media is off in team config"));
    render(<MessageBody m={withMedia(image({ state: "pending", reason: "ask" }))} />);
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      `GIF · ${team.team} asks before loading`,
    );
    const load = screen.getByRole("button", { name: /^Load GIF from/ });
    fireEvent.click(load);
    expect(await screen.findByText("media is off in team config")).toBeTruthy();
    expect((load as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocked: says media is off and links its source, with no Load", () => {
    render(<MessageBody m={withMedia(image({ state: "blocked" }))} />);
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      `GIF · media is off in ${team.team}'s team config`,
    );
    expect(screen.getByRole("link", { name: "media.example ↗" }).getAttribute("href")).toBe(
      "https://media.example/cat.gif",
    );
    expect(screen.queryByRole("button", { name: /Load/ })).toBeNull();
  });

  it("failed: names the failure, with Retry only when it can be retried", () => {
    const { unmount } = render(
      <MessageBody m={withMedia(image({ state: "failed", reason: "size", retryable: true }))} />,
    );
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "Couldn't load this GIF. The file is over 8 MB.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(loadInboxMedia).toHaveBeenCalledWith(team, 7);
    unmount();
    render(
      <MessageBody
        m={withMedia(image({ state: "failed", mime: "image/png", sourceHost: "cdn.example" }))}
      />,
    );
    expect(screen.getByTestId("ibx-media-card").textContent).toContain(
      "Couldn't load this image. cdn.example didn't answer.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("MessageBody Open chip", () => {
  it("opens the primary file in a viewer tab through the bridge's openFile", async () => {
    render(<MessageBody m={{ ...base, text: "review this", primaryFile: "docs/plan.md" }} />);
    fireEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith({ ...team, path: "docs/plan.md" }));
  });

  it("falls back to an open-file click, and shows an open that fails", async () => {
    openFile.mockRejectedValue(new Error("unavailable: unknown synced team"));
    render(
      <MessageBody m={{ ...base, onClick: { type: "open-file", path: "reports/today.html" } }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "reports/today.html" }));
    expect((await screen.findByRole("alert")).textContent).toBe("unavailable: unknown synced team");
  });

  it("is absent when the message names no file", () => {
    render(<MessageBody m={{ ...base, text: "hi" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

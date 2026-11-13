// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const readInboxMedia = vi.hoisted(() => vi.fn());
const loadInboxMedia = vi.hoisted(() => vi.fn());
const bridgeResolveOpenTarget = vi.hoisted(() => vi.fn());
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  readInboxMedia,
  loadInboxMedia,
  bridgeResolveOpenTarget,
}));
const openFileInTeam = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/open-file-in-team", () => ({ openFileInTeam }));
vi.mock("@/features/weft/components/inbox-message-content", () => ({
  InboxMessageContent: ({
    text,
    contentType,
    live,
  }: {
    text: string;
    contentType?: string;
    live?: boolean;
  }) => (
    <p data-content-type={contentType} data-live={String(!!live)}>
      {text}
    </p>
  ),
}));

import type { InboxMediaAttachment } from "@/tauri/commands";
import { useOrgStore } from "@/shared/stores/org-store";
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
  readInboxMedia.mockReset().mockResolvedValue(new Blob(["GIF89a"], { type: "image/gif" }));
  loadInboxMedia.mockReset().mockResolvedValue(undefined);
  bridgeResolveOpenTarget.mockReset();
  openFileInTeam.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:cat");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Turn the OS Reduce Motion setting on for the rest of the test. */
function reduceMotion() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

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

  it("reads an image once for every view of it, and revokes it when the last one goes", async () => {
    const first = render(<MessageBody m={withMedia(image())} />);
    const second = render(<MessageBody m={{ ...withMedia(image()), id: 8 }} />);
    await waitFor(() => expect(screen.getAllByAltText("a cat waving")).toHaveLength(2));
    expect(readInboxMedia).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(readInboxMedia.mock.calls[0]![0]).toEqual(team);
    first.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cat");
  });

  it("renders the text of an html message with an image as a markdown caption", () => {
    render(<MessageBody m={{ ...withMedia(image(), "<b>look</b>"), contentType: "html" }} />);
    const caption = screen.getByText("<b>look</b>");
    expect(caption.dataset.contentType).toBe("markdown");
    expect(caption.dataset.live).toBe("false");
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

describe("MessageBody animated images under Reduce Motion", () => {
  it("plays a GIF on its own when Reduce Motion is off", async () => {
    render(<MessageBody m={withMedia(image())} />);
    fireEvent.load(await screen.findByAltText("a cat waving"));
    expect(screen.queryByRole("button", { name: "Play GIF" })).toBeNull();
  });

  it("shows a still frame with Play, plays on Pause's press, and pauses off-screen", async () => {
    reduceMotion();
    let offScreen: (entries: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof offScreen) {
          offScreen = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<MessageBody m={withMedia(image())} />);
    const img = await screen.findByAltText("a cat waving");
    expect(screen.queryByRole("button", { name: "Play GIF" })).toBeNull();
    fireEvent.load(img);
    const figure = img.closest("figure")!;
    expect(figure.classList.contains("still")).toBe(true);
    const play = screen.getByRole("button", { name: "Play GIF" });
    expect(play.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(play);
    expect(figure.classList.contains("still")).toBe(false);
    expect(screen.getByRole("button", { name: "Pause GIF" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    act(() => offScreen([{ isIntersecting: false }]));
    expect(figure.classList.contains("still")).toBe(true);
    expect(screen.getByRole("button", { name: "Play GIF" })).toBeTruthy();
  });

  it("leaves a still image alone under Reduce Motion", async () => {
    reduceMotion();
    render(<MessageBody m={withMedia(image({ mime: "image/png" }))} />);
    fireEvent.load(await screen.findByAltText("a cat waving"));
    expect(screen.queryByRole("button", { name: "Play GIF" })).toBeNull();
  });
});

describe("MessageBody Open chip", () => {
  const target = { ...team, path: "docs/plan.md", contentRoot: "/orgs/x/default/content" };
  beforeEach(() => {
    useOrgStore.setState({
      orgs: [{ slug: team.org, org_root: "/orgs/x", teams: [{ name: team.team }] }],
    } as unknown as Partial<ReturnType<typeof useOrgStore.getState>>);
  });

  it("opens the primary file as the person's own open, resolved inside the message's team", async () => {
    bridgeResolveOpenTarget.mockResolvedValue(target);
    render(<MessageBody m={{ ...base, text: "review this", primaryFile: "docs/plan.md" }} />);
    fireEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    await waitFor(() => expect(openFileInTeam).toHaveBeenCalledWith(target, {}));
    expect(bridgeResolveOpenTarget).toHaveBeenCalledWith(
      `/orgs/x/${team.team}/content/inbox.html`,
      "docs/plan.md",
      team.team,
    );
  });

  it("opens a path#fragment the team doesn't hold as the path, at the fragment", async () => {
    bridgeResolveOpenTarget.mockImplementation(async (_page: string, path: string) => {
      if (path.includes("#")) throw new Error("not-found: docs/plan.md#goals");
      return target;
    });
    render(<MessageBody m={{ ...base, primaryFile: "docs/plan.md#goals" }} />);
    fireEvent.click(screen.getByRole("button", { name: "docs/plan.md#goals" }));
    await waitFor(() => expect(openFileInTeam).toHaveBeenCalledWith(target, { hash: "#goals" }));
    expect(bridgeResolveOpenTarget).toHaveBeenLastCalledWith(
      `/orgs/x/${team.team}/content/inbox.html`,
      "docs/plan.md",
      team.team,
    );
  });

  it("falls back to an open-file click, and shows an open that fails", async () => {
    bridgeResolveOpenTarget.mockRejectedValue(new Error("refused: outside the team"));
    render(
      <MessageBody m={{ ...base, onClick: { type: "open-file", path: "reports/today.html" } }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "reports/today.html" }));
    expect((await screen.findByRole("alert")).textContent).toBe("refused: outside the team");
    expect(openFileInTeam).not.toHaveBeenCalled();
  });

  it("says so when the message's team isn't synced here", async () => {
    useOrgStore.setState({ orgs: [] } as unknown as Partial<
      ReturnType<typeof useOrgStore.getState>
    >);
    render(<MessageBody m={{ ...base, primaryFile: "docs/plan.md" }} />);
    fireEvent.click(screen.getByRole("button", { name: "docs/plan.md" }));
    expect((await screen.findByRole("alert")).textContent).toBe("unavailable: unknown synced team");
    expect(bridgeResolveOpenTarget).not.toHaveBeenCalled();
  });

  it("is absent when the message names no file", () => {
    render(<MessageBody m={{ ...base, text: "hi" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

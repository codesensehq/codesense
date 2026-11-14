// SPDX-License-Identifier: MIT
vi.mock("@/features/dashboard/lib/verb-dispatch", async () =>
  (await import("@/test/verb-dispatch-mock")).openVerbDispatchMock(),
);
vi.mock("@/shared/lib/local-profile-session", () => ({ rendererPrincipal: async () => "42" }));
import { frameFixture, FrameMessageEvent } from "../../../../tests/support/fixtures/frame";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

// Seam: ⌘W forwarded from a dashboard frame. Over a maximized surface it leaves that surface
// through the overlay's own frame-escape event; with none open it closes the file tab as before.
const { tauriInvoke, closeActiveFileTab } = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
  closeActiveFileTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: (cmd: string, args?: unknown) => tauriInvoke(cmd, args) };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@/shared/lib/close-active-file-tab", () => ({ closeActiveFileTab }));

import { HtmlViewer } from "./html-viewer";

const PORT = 9321;
const DOC = "/ctx/acme/default/content/dashboards/board.html";
const ROOT = "/ctx/acme/default/content";

function stubTauri(cmd: string, args?: unknown): unknown {
  switch (cmd) {
    case "get_http_api_port":
      return PORT;
    case "mint_frame":
      return frameFixture((args as { args: import("@/tauri/commands").MintFrameArgs }).args, PORT);
    case "resolve_frame_grant":
      return frameFixture({ documentPath: DOC, contentRoot: ROOT, slot: "centre" }, PORT).grant;
    case "read_file":
      return "<!doctype html><html><head></head><body>board</body></html>";
    case "dashboard_probe_sessions_alive":
      return [];
    default:
      return null;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
  tauriInvoke.mockImplementation(async (cmd: string, args?: unknown) => stubTauri(cmd, args));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.querySelectorAll("[data-fullscreen]").forEach((el) => el.remove());
});

async function mountAndForwardCmdW(
  props: Partial<React.ComponentProps<typeof HtmlViewer>> = {},
  container?: HTMLElement,
) {
  render(<HtmlViewer filePath={DOC} teamContentPath={ROOT} {...props} />, { container });
  await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBeTruthy());
  const iframe = document.querySelector("iframe")!;
  const fakeWindow = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { value: fakeWindow, configurable: true });
  window.dispatchEvent(
    new FrameMessageEvent("message", {
      origin: `http://f-test.localhost:${PORT}`,
      data: { type: "codesense:close-tab" },
      source: fakeWindow,
    }),
  );
}

function openOverlay() {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-fullscreen", "true");
  document.body.appendChild(overlay);
  const onEscape = vi.fn();
  overlay.addEventListener("codesense:frame-escape", onEscape);
  return { overlay, onEscape };
}

describe("a forwarded ⌘W from a dashboard frame", () => {
  it("exits the maximize overlay holding the frame and leaves the file tab alone", async () => {
    const { overlay, onEscape } = openOverlay();
    await mountAndForwardCmdW({}, overlay.appendChild(document.createElement("div")));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(closeActiveFileTab).not.toHaveBeenCalled();
  });

  it("leaves an overlay that does not hold the frame alone and closes the tab", async () => {
    const { onEscape } = openOverlay();
    await mountAndForwardCmdW();
    expect(onEscape).not.toHaveBeenCalled();
    expect(closeActiveFileTab).toHaveBeenCalledWith(DOC);
  });

  it("closes the file tab as before when no overlay is open", async () => {
    await mountAndForwardCmdW();
    expect(closeActiveFileTab).toHaveBeenCalledWith(DOC);
  });

  it("still ignores an embedded pane when no overlay is open", async () => {
    await mountAndForwardCmdW({
      pane: { contentRoot: ROOT, panesDir: "/ctx/acme/default/panes", fileName: "board.html" },
    });
    expect(closeActiveFileTab).not.toHaveBeenCalled();
  });
});

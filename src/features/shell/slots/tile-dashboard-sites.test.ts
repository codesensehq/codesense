// SPDX-License-Identifier: MIT
/**
 * The sites that mean "the pane on the right" rather than "a dashboard frame", with a frame a tile
 * hosts: reveal and Escape focus return here; Inbox recovery in `slot-dashboard-host.test.tsx`
 * and Escape through the page's own message in `html-viewer.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardRefKey } from "@/features/dashboard/lib/dashboard-ref";
import { useDashboardProfileStore } from "@/features/dashboard/lib/dashboard-profile";
import { registerFrame } from "@/features/dashboard/lib/frame-lifecycle";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import { focusTileTab, isTileHosted } from "@/shared/tiling/hosted-frame";

import { defaultRightPaneLayout } from "../right-pane/right-pane-layout";
import { usePaneStore } from "../right-pane/panes/pane-store";
import { revealSlot } from "./reveal-slot";

vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  readDashboardProfile: vi.fn(async () => null),
  writeDashboardProfile: vi.fn(async (_org, profile) => profile),
}));

const ref = { scope: "team" as const, org: "acme", team: "dev", id: "board" };
const TILE = dashboardRefKey(ref);

/** A tile body as the host draws it, its tab bar and a frame inside. */
function tileWithFrame(shown = true) {
  const body = document.createElement("div");
  body.dataset.tileBody = TILE;
  body.dataset.tileShown = String(shown);
  const tab = document.createElement("button");
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "true");
  const iframe = document.createElement("iframe");
  body.append(tab, iframe);
  document.body.append(body);
  return { body, tab, iframe };
}

function liveFrame(element: HTMLIFrameElement) {
  return registerFrame({
    frameId: `frame-${Math.random()}`,
    dashboard: TILE,
    panelId: `tile:${TILE}`,
    slotId: "right-pane",
    element,
    post: () => {},
    hide: () => {},
  });
}

beforeEach(() => {
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "dev" });
  usePaneStore.setState({
    teamKey: "acme:dev",
    listing: {
      contentRoot: "/ctx",
      chain: ["dev"],
      panes: [
        {
          id: "board",
          title: "Board",
          scope: "team",
          team: "dev",
          path: "/ctx/panes/board.html",
          panesDir: "/ctx/panes",
          panelId: "pane:acme:dev/board",
          dashboardRef: ref,
        },
      ],
    },
    pendingIntents: {},
    knownEntries: {},
  });
  useDashboardProfileStore.setState({
    org: "acme",
    profile: {
      id: "default",
      name: "Default",
      posture: "",
      slots: { "right-pane": [ref] },
      cliLayout: "default",
      chrome: {},
    },
  });
  useViewerStore.setState({ rightPaneOpen: false, rightPaneLayout: defaultRightPaneLayout() });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTileHosted", () => {
  it("is true for a frame in a tile body and false anywhere else", () => {
    const { iframe } = tileWithFrame();
    const loose = document.createElement("iframe");
    document.body.append(loose);
    expect(isTileHosted({ element: iframe })).toBe(true);
    expect(isTileHosted(iframe)).toBe(true);
    expect(isTileHosted({ element: loose })).toBe(false);
    expect(isTileHosted({})).toBe(false);
    expect(isTileHosted(null)).toBe(false);
  });
});

describe("reveal", () => {
  it("reveals a dashboard a tile shows in its tile, not the right pane", () => {
    const { iframe } = tileWithFrame();
    const unregister = liveFrame(iframe);
    revealSlot("right-pane", { dashboard: ref, focus: true });
    expect(useViewerStore.getState().rightPaneOpen).toBe(false);
    expect(document.activeElement).toBe(iframe);
    unregister();
  });

  it("does not open the right pane for a tile whose tab is hidden", () => {
    const { iframe } = tileWithFrame(false);
    const unregister = liveFrame(iframe);
    revealSlot("right-pane", { dashboard: ref, focus: true });
    expect(useViewerStore.getState().rightPaneOpen).toBe(false);
    unregister();
  });

  it("opens the right pane as today when no tile shows the dashboard", () => {
    const loose = document.createElement("iframe");
    document.body.append(loose);
    const unregister = liveFrame(loose);
    revealSlot("right-pane", { dashboard: ref, focus: true });
    expect(useViewerStore.getState().rightPaneOpen).toBe(true);
    unregister();
  });
});

describe("Escape focus return", () => {
  it("moves focus from a tile's frame to its shown tab", () => {
    const { iframe, tab } = tileWithFrame();
    iframe.focus();
    expect(focusTileTab(iframe)).toBe(true);
    expect(document.activeElement).toBe(tab);
  });

  it("leaves a right-pane frame to today's terminal return", () => {
    const loose = document.createElement("iframe");
    document.body.append(loose);
    expect(focusTileTab(loose)).toBe(false);
  });
});

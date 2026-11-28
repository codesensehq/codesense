// SPDX-License-Identifier: MIT
/**
 * With the tiles flag off, `isTileHosted` is false everywhere, even for a frame in a tile body's
 * markup, so every right-pane site does what it does on main.
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dashboardRefKey } from "@/features/dashboard/lib/dashboard-ref";
import { useDashboardProfileStore } from "@/features/dashboard/lib/dashboard-profile";
import { registerFrame } from "@/features/dashboard/lib/frame-lifecycle";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import {
  focusTileTab,
  isShownInTile,
  isTileHosted,
  useTileHosted,
} from "@/shared/tiling/hosted-frame";
import { TileKeyContext } from "@/shared/tiling/tile-host";

import { defaultRightPaneLayout } from "../right-pane/right-pane-layout";
import { usePaneStore } from "../right-pane/panes/pane-store";
import { revealSlot } from "./reveal-slot";

vi.mock("@/shared/lib/tiles-enabled", () => ({ tilesEnabled: async () => false }));
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  readDashboardProfile: vi.fn(async () => null),
  writeDashboardProfile: vi.fn(async (_org, profile) => profile),
}));

const ref = { scope: "team" as const, org: "acme", team: "dev", id: "board" };
const KEY = dashboardRefKey(ref);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tiles flag off", () => {
  it("reads no frame as tile-hosted, and Escape and reveal keep today's paths", () => {
    const body = document.createElement("div");
    body.dataset.tileBody = KEY;
    body.dataset.tileShown = "true";
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "true");
    const iframe = document.createElement("iframe");
    body.append(tab, iframe);
    document.body.append(body);
    expect(isTileHosted(iframe)).toBe(false);
    expect(isShownInTile(iframe)).toBe(false);
    expect(focusTileTab(iframe)).toBe(false);

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
    const unregister = registerFrame({
      frameId: "frame-off",
      dashboard: KEY,
      slotId: "right-pane",
      element: iframe,
      post: () => {},
      hide: () => {},
    });
    revealSlot("right-pane", { dashboard: ref });
    expect(useViewerStore.getState().rightPaneOpen).toBe(true);
    unregister();
  });

  it("reads a component in a tile body as not tile-hosted", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TileKeyContext.Provider value={KEY}>{children}</TileKeyContext.Provider>
    );
    expect(renderHook(() => useTileHosted(), { wrapper }).result.current).toBe(false);
  });
});

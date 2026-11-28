// SPDX-License-Identifier: MIT
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardRefKey } from "@/features/dashboard/lib/dashboard-ref";
import { useOrgStore } from "@/shared/stores/org-store";
import type { DashboardRef, PaneEntry, PaneListing } from "@/tauri/commands";

import { usePaneStore } from "../right-pane/panes/pane-store";
import { DashboardTileBody, InboxTileBody } from "./dashboard-tile-body";

const host = vi.hoisted(() => ({ props: null as any }));
vi.mock("./slot-dashboard-host", () => ({
  SlotDashboardHost: (p: any) => {
    host.props = p;
    return <div data-testid="slot-host" />;
  },
}));
const listings = vi.hoisted(() => new Map<string, PaneListing>());
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  listPanes: vi.fn(async (org: string, team: string) => listings.get(`${org}:${team}`)),
}));

const pane = (ref: DashboardRef): PaneEntry => ({
  id: ref.id,
  title: ref.id,
  scope: ref.scope === "built-in" ? "private" : ref.scope,
  team: ref.team,
  path: `/home/me/code/${ref.team ?? "private"}/panes/${ref.id}.html`,
  panesDir: `/home/me/code/${ref.team ?? "private"}/panes`,
  panelId: `pane:${dashboardRefKey(ref)}`,
  dashboardRef: ref,
});
const board: DashboardRef = { scope: "team", org: "acme", team: "alpha", id: "board" };
const builtinInbox: DashboardRef = { scope: "built-in", org: "acme", id: "inbox" };
const betaInbox: DashboardRef = { scope: "team", org: "acme", team: "beta", id: "inbox" };
const context = { visible: true, reportLoading: vi.fn() };

beforeEach(() => {
  host.props = null;
  listings.clear();
  listings.set("acme:alpha", {
    contentRoot: "/home/me/code/alpha",
    chain: ["alpha"],
    panes: [pane(board)],
  });
  listings.set("acme:beta", {
    contentRoot: "/home/me/code/beta",
    chain: ["beta"],
    panes: [pane(betaInbox), pane(builtinInbox)],
  });
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "beta" });
  usePaneStore.setState({ teamKey: null, listing: null, pendingIntents: {}, knownEntries: {} });
});

describe("DashboardTileBody", () => {
  it("frames under right-pane for its file's team, not the team on screen, under its own panel id", async () => {
    render(<DashboardTileBody tileKey={dashboardRefKey(board)} context={context} />);
    await waitFor(() => expect(host.props).not.toBeNull());
    expect(host.props.slotId).toBe("right-pane");
    expect(host.props.teamKey).toBe("acme:alpha");
    expect(host.props.contentRoot).toBe("/home/me/code/alpha");
    expect(host.props.entry.dashboardRef).toEqual(board);
    expect(host.props.panelId).toBe(`tile:${dashboardRefKey(board)}`);
  });

  it("takes the story's team in a story workspace", async () => {
    listings.set("acme:beta", {
      contentRoot: "/home/me/code/beta",
      chain: ["beta", "alpha"],
      panes: [pane(board)],
    });
    render(
      <DashboardTileBody
        tileKey={dashboardRefKey(board)}
        context={context}
        storyTeam={{ org: "acme", team: "beta" }}
      />,
    );
    await waitFor(() => expect(host.props).not.toBeNull());
    expect(host.props.teamKey).toBe("acme:beta");
  });

  it("keeps its page team when the team on screen changes", async () => {
    render(<DashboardTileBody tileKey={dashboardRefKey(board)} context={context} />);
    await waitFor(() => expect(host.props).not.toBeNull());
    const first = host.props;
    act(() => useOrgStore.setState({ activeTeamName: "gamma" }));
    expect(host.props.teamKey).toBe("acme:alpha");
    expect(host.props.entry).toBe(first.entry);
  });

  it("opens a team pane with the built-in's id in place of the built-in", async () => {
    render(<DashboardTileBody tileKey={dashboardRefKey(builtinInbox)} context={context} />);
    await waitFor(() => expect(host.props).not.toBeNull());
    expect(host.props.entry.dashboardRef).toEqual(betaInbox);
  });

  it("says so when its team does not list the dashboard", async () => {
    const other = { ...board, id: "gone" };
    render(<DashboardTileBody tileKey={dashboardRefKey(other)} context={context} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This dashboard isn't listed for alpha.",
    );
    expect(host.props).toBeNull();
  });
});

describe("InboxTileBody", () => {
  it("frames the inbox dashboard the team on screen resolves, under its tile's panel id", async () => {
    render(<InboxTileBody tileKey="inbox:acme" context={context} />);
    await waitFor(() => expect(host.props).not.toBeNull());
    expect(host.props.teamKey).toBe("acme:beta");
    expect(host.props.entry.dashboardRef).toEqual(betaInbox);
    expect(host.props.panelId).toBe("tile:inbox:acme");
  });
});

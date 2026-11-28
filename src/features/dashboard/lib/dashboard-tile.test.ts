// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import type { DashboardRef, PaneEntry } from "@/tauri/commands";

import { dashboardRefKey, dashboardRefOfKey } from "./dashboard-ref";
import {
  dashboardPageTeam,
  resolveDashboardTileEntry,
  type DashboardTilePlace,
} from "./dashboard-tile";

const teamA: DashboardRef = { scope: "team", org: "acme", team: "alpha", id: "board" };
const privateRef: DashboardRef = { scope: "private", org: "acme", id: "board" };
const builtin: DashboardRef = { scope: "built-in", org: "acme", id: "inbox" };
const storyB = { org: "acme", team: "beta" };
const twoTeams = ["agent:alpha/dev", "agent:beta/review"];

describe("dashboard ref + where it sits → page team", () => {
  it.each<[string, DashboardRef, DashboardTilePlace, { org: string; team: string } | null]>([
    ["team A's file in team B's story workspace", teamA, { storyTeam: storyB }, storyB],
    ["team A's file in a group", teamA, {}, { org: "acme", team: "alpha" }],
    [
      "team A's file beside agents from two teams",
      teamA,
      { tabs: twoTeams },
      { org: "acme", team: "alpha" },
    ],
    [
      "team A's file, story workspace, agents from two teams",
      teamA,
      { storyTeam: storyB, tabs: twoTeams },
      storyB,
    ],
    ["a private page in a group follows the team on screen", privateRef, { tabs: twoTeams }, null],
    ["a built-in page in a group follows the team on screen", builtin, {}, null],
    ["a built-in page in team B's story workspace", builtin, { storyTeam: storyB }, storyB],
  ])("%s", (_, ref, place, team) => {
    expect(dashboardPageTeam(ref, place)).toEqual(team);
  });
});

const pane = (ref: DashboardRef): PaneEntry => ({
  id: ref.id,
  title: ref.id,
  scope: ref.scope === "built-in" ? "private" : ref.scope,
  team: ref.team,
  path: `/home/me/code/panes/${ref.id}.html`,
  panesDir: "/home/me/code/panes",
  panelId: dashboardRefKey(ref),
  dashboardRef: ref,
});

describe("a dashboard tile's pane", () => {
  const teamInbox: DashboardRef = { scope: "team", org: "acme", team: "alpha", id: "inbox" };
  const privateInbox: DashboardRef = { scope: "private", org: "acme", id: "inbox" };

  it("opens a team pane with a built-in's id in place of the built-in", () => {
    const listing = { panes: [pane(teamInbox), pane(privateInbox), pane(builtin)] };
    expect(resolveDashboardTileEntry(listing, builtin)?.dashboardRef).toEqual(teamInbox);
  });

  it("opens a private pane with a built-in's id in place of the built-in", () => {
    const listing = { panes: [pane(privateInbox)] };
    expect(resolveDashboardTileEntry(listing, builtin)?.dashboardRef).toEqual(privateInbox);
  });

  it("opens the built-in when nothing replaces it, and any other ref exactly", () => {
    const listing = { panes: [pane(teamA), pane(builtin)] };
    expect(resolveDashboardTileEntry(listing, builtin)?.dashboardRef).toEqual(builtin);
    expect(resolveDashboardTileEntry(listing, teamA)?.dashboardRef).toEqual(teamA);
    expect(resolveDashboardTileEntry(listing, privateRef)).toBeUndefined();
  });
});

describe("dashboardRefOfKey", () => {
  it.each<DashboardRef>([
    teamA,
    privateRef,
    builtin,
    { scope: "team", org: "demo/context", team: "core", id: "trail" },
  ])("reads back $scope $org $id", (ref) => {
    expect(dashboardRefOfKey(dashboardRefKey(ref))).toEqual(ref);
  });

  it.each([
    "doc:core/a.html",
    "dashboard:team:acme/board",
    "dashboard:other:acme/x",
    "dashboard:private:/x",
  ])("refuses %s", (key) => {
    expect(dashboardRefOfKey(key)).toBeNull();
  });
});

// SPDX-License-Identifier: MIT
/**
 * A tab bar draws each tab's agent face from that tab's own team (one tile can hold tabs of two
 * teams), and commits nothing for another team's packs or looks, an active-team switch, or
 * another agent's start or state change. A `Profiler` around the bar counts its commits, the
 * bar's and every tab's below it.
 */
import { Profiler } from "react";
import { act, render, screen, waitFor } from "@/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const packs = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/tauri/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tauri/commands")>()),
  sessionsRunningProcesses: vi.fn(() => new Promise(() => {})),
  avatarPacksListForTeam: (teamKey: string) => packs.list(teamKey),
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
}));

import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { useAvatarPacksStore } from "@/shared/hooks/use-avatar-packs";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore, type TerminalTab } from "@/shared/stores/viewer-store";
import { installTerminalLayoutHarness, seedTerminalTabs } from "@/test/terminal-layout-harness";
import type { AgentSessionRow } from "@/tauri/commands";

import { TerminalTabBar } from "./terminal-tab-bar";

installTerminalLayoutHarness();

const TEAM_A = "acme:alpha";
const TEAM_B = "acme:beta";
const TEAM_C = "acme:gamma";

/** A team face set with one face, `<team>:face`; only that team can resolve it. */
const faceSetOf = (teamKey: string) => {
  const id = teamKey.split(":")[1];
  return {
    id,
    name: id,
    scope: "team" as const,
    faces: [{ id: "face", ref: `${id}:face`, label: id, src: `data:image/png;base64,${id}` }],
  };
};

const agent = (handle: string, sessionId: string, avatar: string): AgentSessionRow =>
  ({
    handle,
    sessionId,
    kind: "dashboard-launched",
    alive: true,
    backgrounded: false,
    startedWith: null,
    startedAtMs: 1,
    launcher: null,
    lastOutputMs: null,
    displayName: handle,
    avatar,
  }) as AgentSessionRow;

const tab = (sessionId: string): TerminalTab => ({ id: sessionId, name: sessionId, sessionId });

/** Place `sessionId`'s tab in a workspace of `teamKey`, so the tab's team is that team. */
function place(teamKey: string, workspaceId: string, sessionId: string) {
  useViewerStore.setState((st) => ({
    workspaces: {
      ...st.workspaces,
      [teamKey]: [
        ...(st.workspaces[teamKey] ?? []),
        { id: workspaceId, kind: "story", cwd: `/${workspaceId}`, status: "ready" },
      ],
    },
  }));
  seedTerminalTabs(teamKey, workspaceId, [sessionId], { active: sessionId });
}

const faceOf = (tabId: string) =>
  screen.getByTestId(`terminal-tab-${tabId}`).querySelector(".ag-face")?.getAttribute("data-face");

let commits = 0;
function renderBar(tabs: TerminalTab[]) {
  return render(
    <Profiler id="bar" onRender={() => void commits++}>
      <TerminalTabBar
        tabs={tabs}
        activeTabId={tabs[0].id}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onNewShell={vi.fn()}
        onReorderTab={vi.fn()}
        onRenameTab={vi.fn()}
      />
    </Profiler>,
  );
}

/** Render the bar, wait for every team's packs, and start counting from zero. */
async function settle(tabs: TerminalTab[], faces: Record<string, string>) {
  renderBar(tabs);
  await waitFor(() => {
    for (const [tabId, face] of Object.entries(faces)) expect(faceOf(tabId)).toBe(face);
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  commits = 0;
}

beforeEach(() => {
  commits = 0;
  packs.list.mockReset();
  packs.list.mockImplementation((teamKey: string) =>
    Promise.resolve({ packs: [faceSetOf(teamKey)], warnings: [] }),
  );
  useAvatarPacksStore.setState({ byTeam: {} });
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "alpha" });
  useViewerStore.setState({ workspaces: {}, agentIdentity: {} });
  useAgentListProjectionStore.setState({
    sessions: [agent("a#lead", "sa", "alpha:face"), agent("b#lead", "sb", "beta:face")],
    error: null,
  });
  place(TEAM_A, "wa", "sa");
  place(TEAM_B, "wb", "sb");
});

describe("a tab's face comes from its own team", () => {
  it("draws a team B tab with team B's face while team A is active", async () => {
    await settle([tab("sb")], { sb: "beta:face" });
    expect(packs.list).toHaveBeenCalledWith(TEAM_B);
  });

  it("draws an A tab and a B tab in one tile each from its own team", async () => {
    await settle([tab("sa"), tab("sb")], { sa: "alpha:face", sb: "beta:face" });
  });

  it("wears the look a person chose in the tab's own team, not another team's", async () => {
    useViewerStore.setState({
      agentIdentity: {
        [TEAM_A]: { "b#lead": { face: "alpha:face" } },
        [TEAM_B]: { "b#lead": { face: "builtin-funny:yaml-wizard" } },
      },
    });
    await settle([tab("sa"), tab("sb")], { sb: "builtin-funny:yaml-wizard" });
  });
});

describe("the tab bar commits nothing for data its tabs do not show", () => {
  it("another team's packs change", async () => {
    place(TEAM_C, "wc", "sc");
    await settle([tab("sa"), tab("sb")], { sa: "alpha:face", sb: "beta:face" });
    act(() =>
      useAvatarPacksStore.setState((st) => ({
        byTeam: { ...st.byTeam, [TEAM_C]: { ...st.byTeam[TEAM_A]!, warnings: ["changed"] } },
      })),
    );
    expect(commits).toBe(0);
  });

  it("the active team switches", async () => {
    await settle([tab("sb")], { sb: "beta:face" });
    act(() => useOrgStore.setState({ activeTeamName: "gamma" }));
    act(() => useOrgStore.setState({ activeTeamName: "delta" }));
    expect(commits).toBe(0);
  });

  it("another agent starts, or changes state", async () => {
    await settle([tab("sa"), tab("sb")], { sa: "alpha:face", sb: "beta:face" });
    act(() =>
      useAgentListProjectionStore.setState((st) => ({
        sessions: [...(st.sessions ?? []), agent("c#lead", "sc", "gamma:face")],
      })),
    );
    act(() =>
      useAgentListProjectionStore.setState((st) => ({
        sessions: (st.sessions ?? []).map((row) =>
          row.handle === "c#lead" ? { ...row, lastOutputMs: 99 } : { ...row },
        ),
      })),
    );
    expect(commits).toBe(0);
  });

  it("another team changes a look", async () => {
    await settle([tab("sa"), tab("sb")], { sa: "alpha:face", sb: "beta:face" });
    act(() => useViewerStore.getState().setAgentIdentity(TEAM_C, "c#lead", { face: "gamma:face" }));
    expect(commits).toBe(0);
  });

  it("but redraws for its own tab's look", async () => {
    await settle([tab("sa"), tab("sb")], { sa: "alpha:face", sb: "beta:face" });
    act(() =>
      useViewerStore
        .getState()
        .setAgentIdentity(TEAM_B, "b#lead", { face: "builtin-funny:yaml-wizard" }),
    );
    expect(faceOf("sb")).toBe("builtin-funny:yaml-wizard");
    expect(commits).toBeGreaterThan(0);
  });
});

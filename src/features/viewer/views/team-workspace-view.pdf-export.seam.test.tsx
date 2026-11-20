// SPDX-License-Identifier: MIT
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installMockBackend } from "@/app/mock/install";
import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";
import { useOrgStore } from "@/shared/stores/org-store";
import { useConfigStore } from "@/shared/stores/config-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import type { Org } from "@/shared/types/domain";
import { TeamWorkspaceView } from "./team-workspace-view";

const key = "acme/plans:planning";
const root = "/attached/plans/planning/content";
const org: Org = {
  slug: "acme/plans",
  display_name: "Plans",
  created_at: "",
  remote_url: null,
  config_flags: {},
  people: [],
  org_root: "/attached/plans",
  teams: [{ name: "planning", source_repos: [] }],
};
type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

beforeEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  installMockBackend();
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  const original = internals.invoke.bind(internals);
  internals.invoke = async (command, args) => {
    if (command === "scan_pipeline_tree")
      return {
        dirPath: "",
        dirName: "content",
        absoluteDirPath: String(args?.teamContentPath),
        stories: [],
        docs: [
          { fileName: "team-handbook.md", filePath: `${root}/team-handbook.md`, sourceTeam: null },
        ],
        subEpics: [],
        orderError: null,
        mainDoc: null,
      };
    if (command === "read_file") return "# Shared handbook";
    return original(command, args);
  };
  useOrgStore.setState({
    orgs: [org],
    stateLoaded: true,
    activeOrgSlug: org.slug,
    activeTeamName: "planning",
    workspaceRepos: {},
    suspendedWorkspaceRepos: {},
  });
  useConfigStore.setState({ initialized: true, repos: [] });
  useViewerStore.setState({
    stateLoaded: true,
    scopeRecoveryComplete: true,
    openedTeams: [key],
    openTabs: {},
    activeTab: {},
    workspaces: {},
    activeWorkspace: {},
    teamPipelineRepoPath: {},
    layoutMode: "viewer",
    terminalVisible: false,
    rightPaneOpen: false,
    pipelineScope: {},
    drillPaths: {},
    navCollapsed: {},
  });
});
afterEach(async () => {
  cleanup();
  resetPlatformCaps();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
});

async function openNavMenu() {
  render(
    <TooltipProvider>
      <TeamWorkspaceView teamKey={key} />
    </TooltipProvider>,
  );
  fireEvent.contextMenu((await screen.findAllByText("team-handbook"))[0]);
  await screen.findByRole("menu");
}

describe("the nav context menu's Export to PDF", () => {
  it("is offered on a Markdown file with the capability on", async () => {
    setPlatformCaps();
    await openNavMenu();
    expect(screen.getByRole("menuitem", { name: /Export to PDF/ })).toBeInTheDocument();
  });

  it("is absent with the capability off", async () => {
    setPlatformCaps({ "pdf-export": "printing isn't built here" });
    await openNavMenu();
    expect(screen.queryByRole("menuitem", { name: /Export to PDF/ })).toBeNull();
  });
});

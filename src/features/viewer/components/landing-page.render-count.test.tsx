// SPDX-License-Identifier: MIT
import "@/test/prefs-state-fixture";
import { act, render } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The team landing page's menu items, nav mark and Settings row are copy only:
// opening and tiling another team's agent and doc must not render them again.

vi.mock("@/tauri/commands", () => ({
  LOCAL_MACHINE_ID: "local",
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
  listAttachmentsByRemote: vi.fn().mockResolvedValue(new Map()),
  dashboardRegisterSession: vi.fn().mockResolvedValue(undefined),
  resolveTeamLandingPage: vi
    .fn()
    .mockResolvedValue({ kind: "found", path: "/orgs/acme/web/content/README.md" }),
}));
vi.mock("@/shared/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  initLogging: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/features/dashboard/components/attach-repo-dialog", () => ({
  AttachRepoDialog: () => null,
}));

import {
  renderRow,
  type RowInteractionModel,
} from "@/features/dashboard/components/status-nav/rows";
import type { FlatNavItem } from "@/features/dashboard/lib/flatten-nav-tree";
import { TeamTile } from "@/features/settings/components/workspace-section/team-tile";
import { invalidateLandingPages } from "@/features/viewer/lib/team-landing-page";
import { installTerminalLayoutHarness, seedTerminalTabs } from "@/test/terminal-layout-harness";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
import type { Org } from "@/shared/types/domain";

import { StarterPageMenuItems } from "./starter-page-menu-items";

const README = "/orgs/acme/web/content/README.md";
const DOC = "/orgs/acme/platform/content/guide/a.md";
const ORG: Org = {
  slug: "acme",
  display_name: "Acme",
  created_at: "2026-01-01T00:00:00Z",
  remote_url: null,
  config_flags: {},
  people: [],
  teams: [
    { name: "web", source_repos: [] },
    { name: "platform", source_repos: [] },
  ],
  org_root: "/orgs/acme",
};

const fileItem: FlatNavItem = {
  type: "generic-file",
  entry: { name: "README.md", path: README, is_dir: false, extension: "md", size: 1 },
  depth: 0,
};

function rowModel(): RowInteractionModel {
  return {
    teamKey: "acme:web",
    selectedPath: null,
    onFileSelect: vi.fn(),
    onContextMenu: vi.fn(),
    toggleExpand: vi.fn(),
    toggleGenericExpand: vi.fn(),
    statusPopoverOpenMap: new Map(),
    setStatusPopoverOpen: vi.fn(),
    activeTeam: "web",
    onTogglePinnedSection: vi.fn(),
    onPinnedSelect: vi.fn(),
    onPinnedUnpin: vi.fn(),
    onPinnedContextMenu: vi.fn(),
    isStarterPage: (p) => p === README,
  };
}

installTerminalLayoutHarness();

beforeEach(() => {
  invalidateLandingPages();
  useOrgStore.setState({ orgs: [ORG], activeOrgSlug: "acme", activeTeamName: "web" });
  useViewerStore.setState({ foregroundLayout: {}, activeWorkspace: {}, workspaces: {} });
});

describe("the team landing page's copy", () => {
  it("opening and tiling another team's agent and doc renders none of them again", async () => {
    const renders = { menu: 0, mark: 0, settings: 0 };
    const counted = (id: keyof typeof renders, node: ReactNode) => (
      <Profiler id={id} onRender={() => void renders[id]++}>
        {node}
      </Profiler>
    );
    const model = rowModel();
    const { getByTestId, getByText } = render(
      <>
        {counted("menu", <StarterPageMenuItems path={README} onClose={vi.fn()} />)}
        {counted("mark", renderRow(fileItem, model))}
        {counted(
          "settings",
          <TeamTile
            team={ORG.teams[0]}
            org={ORG}
            attachmentsByRemote={new Map()}
            expanded
            trackDialogOpen={false}
            onExpandedChange={vi.fn()}
            onTrackDialogOpenChange={vi.fn()}
          />,
        )}
      </>,
    );
    await act(async () => {});
    expect(getByTestId("starter-page-menu")).toBeInTheDocument();
    expect(getByTestId("starter-page-mark")).toBeInTheDocument();
    expect(
      getByText("Opens when you open this team's folder. Not a group starter."),
    ).toBeInTheDocument();
    const settled = { ...renders };
    expect(settled.menu).toBeGreaterThan(0);
    expect(settled.mark).toBeGreaterThan(0);
    expect(settled.settings).toBeGreaterThan(0);
    const before = useViewerStore.getState();

    await act(async () => {
      seedTerminalTabs("acme:platform", "w1", ["agent", "shell"], { paned: ["agent", "shell"] });
      const viewer = useViewerStore.getState();
      viewer.openFile("acme:platform", "/orgs/acme/platform/content", DOC);
      // Tile the doc: its folder opens as a workspace tile beside the agent's,
      // with the doc's tab pinned.
      viewer.openOrFocusGenericWorkspace("acme:platform", "/orgs/acme/platform/content/guide");
      viewer.pinTab("acme:platform", DOC);
    });

    const after = useViewerStore.getState();
    expect(after).not.toBe(before);
    expect(after.workspaces["acme:platform"]?.length).toBeGreaterThan(0);
    expect(renders).toEqual(settled);
  });
});

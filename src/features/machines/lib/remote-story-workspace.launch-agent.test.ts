// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => ({
  settled: vi.fn(),
}));

vi.mock("@/features/machines/stores/machines-store", () => ({
  ensureTeamMachines: vi.fn(),
  findMachine: () => ({ label: "box", status: { state: "connected" } }),
  getTeamMachines: () => [],
}));

vi.mock("@/features/viewer/lib/remote-tab-open", () => ({
  focusRemoteTab: vi.fn(),
  openRemoteTab: vi.fn(),
  openRemoteTabSettled: open.settled,
  pendingRemoteOpens: vi.fn(),
  refreshLayout: vi.fn(async () => {}),
}));

import { useAgentInboxRailStore } from "@/features/viewer/stores/agent-inbox-rail-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";

import { remoteStoryWorkspaceDriver } from "./remote-story-workspace";

const input = {
  teamKey: "acme:default",
  workspaceId: "ws",
  agentKey: "builtin/claude",
  sessionMode: "new",
  location: { kind: "machine", machineId: "box", handle: "h", cwd: "/work" },
} as unknown as Parameters<typeof remoteStoryWorkspaceDriver.launchAgent>[0];

const pending = (id: string) => !!useAgentInboxRailStore.getState().pending[id];

beforeEach(() => {
  useAgentInboxRailStore.setState({ bySession: {}, pending: {} });
  useAgentStateStore.setState({
    bySession: {},
    activityBySession: {},
    exitBySession: {},
    processAgentBySession: {},
  });
  open.settled.mockReset();
});

describe("a remote agent launch and the chat cover", () => {
  it("marks a freshly opened headed agent tab to open on its chat", async () => {
    open.settled.mockResolvedValue({ status: "opened", session: "r-1" });
    await remoteStoryWorkspaceDriver.launchAgent(input);
    expect(pending("r-1")).toBe(true);
  });

  it("does not mark a headless run", async () => {
    open.settled.mockResolvedValue({ status: "opened", session: "r-2" });
    await remoteStoryWorkspaceDriver.launchAgent({ ...input, headed: false });
    expect(pending("r-2")).toBe(false);
  });

  it("does not mark a refused launch", async () => {
    open.settled.mockResolvedValue({ status: "refused", message: "no" });
    await expect(remoteStoryWorkspaceDriver.launchAgent(input)).rejects.toThrow();
    expect(useAgentInboxRailStore.getState().pending).toEqual({});
  });
});

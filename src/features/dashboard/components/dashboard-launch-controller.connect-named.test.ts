// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prepareAgentLaunch } from "@/app/mock/handlers/agents-launch";
import { useAgentInboxRailStore } from "@/features/viewer/stores/agent-inbox-rail-store";
import type { LaunchDeps } from "@/shared/lib/agent-session-launcher";
import type { agentLaunchPrepare } from "@/tauri/commands";

import { connectNamedAgent } from "./dashboard-launch-controller";

const launchDeps = (): LaunchDeps => ({
  findExisting: vi.fn(async () => undefined),
  provision: vi.fn(async () => {}),
  openTab: vi.fn(async () => {}),
  closeTab: vi.fn(async () => {}),
  launchAgentLine: vi.fn(async () => ({ ok: true }) as const),
  projectScopeConfig: vi.fn(async () => ({ extraArgs: [], environmentBinding: null })),
});

const prepare = (async (p: { sessionId: string }) =>
  prepareAgentLaunch({
    agentKey: "reviewer",
    sessionId: p.sessionId,
  })) as unknown as typeof agentLaunchPrepare;

const adopt = {
  agentRunning: vi.fn(async () => true),
  runningJobs: vi.fn(async () => ({ foreground: null, background: [] })),
  evict: vi.fn(async () => {}),
} as unknown as Parameters<typeof connectNamedAgent>[4];

const target = { teamKey: "acme:default", cwd: "/ctx/root", role: "named", workspaceKey: "named" };

describe("connectNamedAgent forwards headless to the launch", () => {
  beforeEach(() => useAgentInboxRailStore.setState({ bySession: {}, pending: {} }));

  it("a headless agent's tab is not marked to open on its chat", async () => {
    await connectNamedAgent(
      target,
      { agent: "reviewer", headless: true },
      launchDeps(),
      prepare,
      adopt,
    );
    expect(useAgentInboxRailStore.getState().pending).toEqual({});
  });

  it("a headed agent's tab is marked to open on its chat", async () => {
    const { sessionId } = await connectNamedAgent(
      target,
      { agent: "reviewer", headless: false },
      launchDeps(),
      prepare,
      adopt,
    );
    expect(useAgentInboxRailStore.getState().pending[sessionId]).toBe(true);
  });
});

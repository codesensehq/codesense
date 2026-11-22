// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { useAgentInboxRailStore } from "@/features/viewer/stores/agent-inbox-rail-store";
import {
  openWorkspaceTab,
  sendToWorkspaceTab,
  GENERIC_AGENT_ROLE,
  type AgentTabLaunch,
  type AgentTabOpen,
  type OpenWorkspaceTabDeps,
  type SendToWorkspaceTabDeps,
} from "./workspace-tab-verbs";
import type { ScopedExecution } from "@/tauri/commands";

describe("@P1 openWorkspaceTab (SW-GW-2)", () => {
  const EXEC = { argv: ["/opt/bin/claude", "--x"], nativeLaunch: "claude" } as ScopedExecution;
  type Opened = { workspaceId: string; role?: string } & Partial<AgentTabOpen>;

  function makeDeps(overrides?: Partial<OpenWorkspaceTabDeps>): {
    deps: OpenWorkspaceTabDeps;
    order: string[];
    opened: Opened[];
    launched: Array<{ sessionId: string; launch: AgentTabLaunch }>;
    closed: Array<{ workspaceId: string; sessionId: string }>;
  } {
    const order: string[] = [];
    const opened: Opened[] = [];
    const launched: Array<{ sessionId: string; launch: AgentTabLaunch }> = [];
    const closed: Array<{ workspaceId: string; sessionId: string }> = [];
    const deps: OpenWorkspaceTabDeps = {
      workspaceKindOf: () => "generic",
      newSessionId: () => "shell-minted",
      openTab: async (workspaceId, role, launch) => {
        order.push("open");
        opened.push({ workspaceId, role, ...launch });
        return launch?.sessionId ?? "shell-new";
      },
      closeTab: (workspaceId, sessionId) => {
        closed.push({ workspaceId, sessionId });
      },
      prepareAgent: async () => {
        order.push("prepare");
        return { spec: { agentPath: "/opt/bin/claude" }, extraArgs: [] };
      },
      launchAgent: async (sessionId, launch) => {
        order.push("launch");
        launched.push({ sessionId, launch });
      },
      ...overrides,
    };
    return { deps, order, opened, launched, closed };
  }

  it("opens a plain tab in a generic workspace and returns its sessionId", async () => {
    const { deps, opened, launched } = makeDeps();
    const res = await openWorkspaceTab({ workspaceId: "generic:/x" }, deps);
    expect(res).toEqual({ sessionId: "shell-new" });
    expect(opened).toEqual([{ workspaceId: "generic:/x", role: undefined }]);
    expect(launched).toEqual([]); // no agent launched for a plain tab
  });

  it("projects for the minted id, then tags the tab and launches the agent when agent:true", async () => {
    const { deps, order, opened, launched } = makeDeps();
    const res = await openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps);
    expect(res).toEqual({ sessionId: "shell-minted" });
    expect(order).toEqual(["prepare", "open", "launch"]);
    expect(opened).toEqual([
      {
        workspaceId: "generic:/x",
        role: GENERIC_AGENT_ROLE,
        sessionId: "shell-minted",
        environmentBinding: undefined,
        execution: undefined,
      },
    ]);
    expect(launched.map((l) => l.sessionId)).toEqual(["shell-minted"]);
  });

  it("opens the tab with the projection's exec and binding, so the agent is its process", async () => {
    const { deps, opened, launched } = makeDeps({
      prepareAgent: async () => ({
        spec: { agentPath: "/opt/bin/claude" },
        extraArgs: [],
        environmentBinding: "binding-1",
        execution: EXEC,
      }),
    });
    await openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps);
    expect(opened[0]).toMatchObject({ environmentBinding: "binding-1", execution: EXEC });
    expect(launched[0]?.launch.execution).toEqual(EXEC);
  });

  it("a spawn the host refuses is rolled back and its agent never recorded", async () => {
    const { deps, launched, closed } = makeDeps({
      openTab: async () => {
        throw new Error("not an absolute path to an existing .exe");
      },
    });
    await expect(
      openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps),
    ).rejects.toThrow(/existing \.exe/);
    expect(launched).toEqual([]);
    expect(closed).toEqual([{ workspaceId: "generic:/x", sessionId: "shell-minted" }]);
  });

  it("a workspace gone after the preparation ends the session it was prepared for", async () => {
    const { deps, launched, closed } = makeDeps({ openTab: async () => "" });
    await expect(
      openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps),
    ).rejects.toThrow(/unavailable: could not open a tab/);
    expect(launched).toEqual([]);
    expect(closed).toEqual([{ workspaceId: "generic:/x", sessionId: "shell-minted" }]);
  });

  it("marks an agent tab to open on its chat, and a plain tab not", async () => {
    useAgentInboxRailStore.setState({ bySession: {}, pending: {} });
    const { deps } = makeDeps();
    await openWorkspaceTab({ workspaceId: "generic:/x" }, deps);
    expect(useAgentInboxRailStore.getState().pending).toEqual({});
    await openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps);
    expect(useAgentInboxRailStore.getState().pending["shell-minted"]).toBe(true);
  });

  it("an agent tab whose launch fails keeps no mark", async () => {
    useAgentInboxRailStore.setState({ bySession: {}, pending: {} });
    const { deps } = makeDeps({
      launchAgent: async () => {
        throw new Error("unavailable: agent CLI not found on PATH");
      },
    });
    await expect(
      openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps),
    ).rejects.toThrow();
    expect(useAgentInboxRailStore.getState().pending).toEqual({});
  });

  it("rejects a non-generic workspace (never opens a tab)", async () => {
    const { deps, opened } = makeDeps({ workspaceKindOf: () => "story" });
    await expect(openWorkspaceTab({ workspaceId: "story:SW-1" }, deps)).rejects.toThrow(
      /not-allowed: openTab targets generic \(dir\) workspaces only/,
    );
    expect(opened).toEqual([]);
  });

  it("rejects an un-opened workspace with unavailable", async () => {
    const { deps } = makeDeps({ workspaceKindOf: () => null });
    await expect(openWorkspaceTab({ workspaceId: "generic:/gone" }, deps)).rejects.toThrow(
      /unavailable: no open workspace/,
    );
  });

  it("rejects a missing workspaceId", async () => {
    const { deps } = makeDeps();
    await expect(openWorkspaceTab({}, deps)).rejects.toThrow(/must be a non-empty string/);
  });

  it("a failed preparation opens no tab, so there is nothing to roll back", async () => {
    const { deps, opened, closed } = makeDeps({
      prepareAgent: async () => {
        throw new Error("unavailable: agent CLI not found on PATH");
      },
    });
    await expect(
      openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps),
    ).rejects.toThrow(/agent CLI not found/);
    expect(opened).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("rolls back the orphan tab when the agent launch fails (no mislabeled tab left)", async () => {
    const { deps, opened, closed } = makeDeps({
      launchAgent: async () => {
        throw new Error("the shell never reached its prompt");
      },
    });
    await expect(
      openWorkspaceTab({ workspaceId: "generic:/x", agent: true }, deps),
    ).rejects.toThrow(/never reached its prompt/);
    // The tab was opened, then rolled back — same workspace + the minted sessionId.
    expect(opened.map((o) => o.role)).toEqual([GENERIC_AGENT_ROLE]);
    expect(closed).toEqual([{ workspaceId: "generic:/x", sessionId: "shell-minted" }]);
  });

  it("does NOT roll back a plain (non-agent) tab (no launch to fail)", async () => {
    const { deps, closed } = makeDeps();
    await openWorkspaceTab({ workspaceId: "generic:/x" }, deps);
    expect(closed).toEqual([]);
  });
});

describe("@P1 sendToWorkspaceTab (SW-GW-2)", () => {
  function makeDeps(overrides?: Partial<SendToWorkspaceTabDeps>): {
    deps: SendToWorkspaceTabDeps;
    commands: Array<{ sessionId: string; text: string }>;
    prompts: Array<{ sessionId: string; text: string }>;
  } {
    const commands: Array<{ sessionId: string; text: string }> = [];
    const prompts: Array<{ sessionId: string; text: string }> = [];
    const deps: SendToWorkspaceTabDeps = {
      tabInfo: () => ({ kind: "generic", isAgentTab: true }),
      sendCommand: async (sessionId, text) => {
        commands.push({ sessionId, text });
        return { submitted: true };
      },
      agentLive: async () => true,
      sendPrompt: async (sessionId, text) => {
        prompts.push({ sessionId, text });
        return { submitted: true };
      },
      ...overrides,
    };
    return { deps, commands, prompts };
  }

  it("routes a command to the shell submit path", async () => {
    const { deps, commands, prompts } = makeDeps();
    const res = await sendToWorkspaceTab(
      { sessionId: "shell-1", mode: "command", text: "ls -la" },
      deps,
    );
    expect(res).toEqual({ submitted: true });
    expect(commands).toEqual([{ sessionId: "shell-1", text: "ls -la" }]);
    expect(prompts).toEqual([]);
  });

  it("routes a prompt to the agent submit path when the tab hosts a LIVE agent", async () => {
    const { deps, commands, prompts } = makeDeps();
    const res = await sendToWorkspaceTab(
      { sessionId: "shell-1", mode: "prompt", text: "/dev-story" },
      deps,
    );
    expect(res).toEqual({ submitted: true });
    expect(prompts).toEqual([{ sessionId: "shell-1", text: "/dev-story" }]);
    expect(commands).toEqual([]);
  });

  it("refuses a prompt to a tab that was never opened as an agent (no-agent-in-tab)", async () => {
    const { deps, prompts } = makeDeps({ tabInfo: () => ({ kind: "generic", isAgentTab: false }) });
    await expect(
      sendToWorkspaceTab({ sessionId: "shell-1", mode: "prompt", text: "hi" }, deps),
    ).rejects.toThrow(/^no-agent-in-tab$/);
    expect(prompts).toEqual([]); // never pasted into a bare shell
  });

  it("refuses a prompt when the agent is tagged but NOT currently live (no-agent-in-tab)", async () => {
    const { deps, prompts } = makeDeps({ agentLive: async () => false });
    await expect(
      sendToWorkspaceTab({ sessionId: "shell-1", mode: "prompt", text: "hi" }, deps),
    ).rejects.toThrow(/^no-agent-in-tab$/);
    expect(prompts).toEqual([]);
  });

  it("refuses a sessionId that is not a tab of any open workspace (trust boundary)", async () => {
    const { deps } = makeDeps({ tabInfo: () => null });
    await expect(
      sendToWorkspaceTab({ sessionId: "shell-foreign", mode: "command", text: "x" }, deps),
    ).rejects.toThrow(/unavailable: no open workspace tab/);
  });

  it("refuses a tab that belongs to a NON-generic workspace (never a story/branch agent)", async () => {
    const { deps } = makeDeps({ tabInfo: () => ({ kind: "story", isAgentTab: true }) });
    await expect(
      sendToWorkspaceTab({ sessionId: "story-sess", mode: "command", text: "x" }, deps),
    ).rejects.toThrow(
      /not-allowed: sendToWorkspaceTab targets generic \(dir\) workspace tabs only/,
    );
  });

  it("rejects an invalid mode and an empty text", async () => {
    const { deps } = makeDeps();
    await expect(
      sendToWorkspaceTab({ sessionId: "s", mode: "nope", text: "x" }, deps),
    ).rejects.toThrow(/mode.*command.*prompt/);
    await expect(
      sendToWorkspaceTab({ sessionId: "s", mode: "command", text: "" }, deps),
    ).rejects.toThrow(/text.*non-empty/);
  });

  it("surfaces a held/dropped submit honestly as { submitted: false }", async () => {
    const { deps } = makeDeps({ sendCommand: async () => ({ submitted: false }) });
    const res = await sendToWorkspaceTab({ sessionId: "s", mode: "command", text: "x" }, deps);
    expect(res).toEqual({ submitted: false });
  });
});

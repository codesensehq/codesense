// SPDX-License-Identifier: MIT
// One chat entry for every agent runtime: the agent list's Message / Open inbox actions,
// the hosted chat popover and the bridge's openAgentInbox all funnel through
// openAgentInboxForRow, so this table is the entry path the overlay keeps.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_RUNTIMES, REGISTERED_AGENT_CLIS } from "@/shared/lib/agent-runtimes";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import type { AgentSessionRow } from "@/tauri/commands";
import { useAgentInboxRailStore } from "../stores/agent-inbox-rail-store";
import { openAgentInboxForRow } from "./agent-inbox-actions";

const REMOTE_RUNTIMES = REGISTERED_AGENT_CLIS.filter(
  (cli) => cli.listed && cli.supportsRemoteLaunch,
).map((cli) => cli.runtime);

const row = (sessionId: string, over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({
  handle: `work#${sessionId}`,
  sessionId,
  kind: "dashboard-launched",
  alive: true,
  backgrounded: false,
  startedWith: null,
  startedAtMs: null,
  launcher: null,
  lastOutputMs: null,
  ...over,
});

/** A remote tab's agent is known from its host's current activity snapshot. */
function remoteActivity(session: string, provider: string) {
  useAgentStateStore.getState().recordActivity(
    {
      session,
      identity: { hostBootId: "host", sessionIncarnation: "shell", invocationId: "agent" },
      revision: 1,
      turnGeneration: 0,
      provider: provider as never,
      state: "idle",
      observed: true,
      limited: false,
      exit: null,
      asks: [],
    },
    0,
  );
}

beforeEach(() => {
  useAgentInboxRailStore.setState({ bySession: {} });
  useAgentStateStore.setState({
    bySession: {},
    activityBySession: {},
    exitBySession: {},
    processAgentBySession: {},
  });
});

describe("the agent chat entry path", () => {
  it("covers at least the shipped runtimes, and remote rows only where remote launch is supported", () => {
    expect(AGENT_RUNTIMES).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(REMOTE_RUNTIMES.every((r) => AGENT_RUNTIMES.includes(r))).toBe(true);
  });

  it.each(AGENT_RUNTIMES)("opens the chat for a local %s tab, the same way", async (runtime) => {
    const sid = `local-${runtime}`;
    useAgentStateStore.setState({ processAgentBySession: { [sid]: runtime } });
    const reveal = vi.fn();
    await expect(openAgentInboxForRow(row(sid), reveal, { compose: true })).resolves.toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
    expect(useAgentInboxRailStore.getState().bySession[sid]).toBeDefined();
  });

  it.each(REMOTE_RUNTIMES)("opens the chat for a remote %s tab, the same way", async (runtime) => {
    const sid = `remote-shell-box-${runtime}`;
    remoteActivity(sid, runtime);
    const reveal = vi.fn();
    await expect(openAgentInboxForRow(row(sid, { machineId: "box" }), reveal)).resolves.toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
    expect(useAgentInboxRailStore.getState().bySession[sid]).toBeDefined();
  });

  it.each(AGENT_RUNTIMES)(
    "offers no chat for a headless %s run, even one mid-turn through its signals",
    async (runtime) => {
      const sid = `headless-${runtime}`;
      useAgentStateStore.setState({
        bySession: { [sid]: { t1: null, t2: null, state: "working", agent: runtime } },
        launchBySession: { [sid]: { agent: runtime } } as never,
      });
      const reveal = vi.fn();
      await expect(openAgentInboxForRow(row(sid, { kind: "headless" }), reveal)).resolves.toBe(
        false,
      );
      expect(reveal).not.toHaveBeenCalled();
      expect(useAgentInboxRailStore.getState().bySession).toEqual({});
    },
  );

  it("offers no chat for a plain shell or an ended agent", async () => {
    const reveal = vi.fn();
    await expect(openAgentInboxForRow(row("shell"), reveal)).resolves.toBe(false);
    useAgentStateStore.setState({ processAgentBySession: { ended: "claude" } });
    await expect(openAgentInboxForRow(row("ended", { alive: false }), reveal)).resolves.toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });
});

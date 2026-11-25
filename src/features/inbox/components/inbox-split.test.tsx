// SPDX-License-Identifier: MIT
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { AGENT_RUNTIMES, REMOTE_LAUNCH_CLIS } from "@/shared/lib/agent-runtimes";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, render, screen } from "@/test-utils";
import {
  closeAgentInboxRail,
  markOpenedAsAgent,
  openAgentInboxRail,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";

vi.mock("./chat-overlay", () => ({
  ChatOverlay: (p: {
    sessionId: string;
    style: React.CSSProperties;
    size: { width: number; height: number };
  }) => {
    const [selected, setSelected] = useState(false);
    return (
      <aside
        data-testid="chat-overlay"
        data-session-id={p.sessionId}
        data-size={`${p.size.width}x${p.size.height}`}
        style={p.style}
      >
        <button onClick={() => setSelected(true)}>
          {selected ? "Selected conversation" : "Select conversation"}
        </button>
      </aside>
    );
  },
}));

import { InboxSplit } from "./inbox-split";

const mounts = vi.fn();
function Terminal() {
  useEffect(() => {
    mounts();
  }, []);
  return <div data-testid="terminal" />;
}

const TAB = { id: "tab-1", sessionId: "sess-1" };

beforeEach(() => {
  useAgentStateStore.setState({
    bySession: {},
    activityBySession: {},
    exitBySession: {},
    processAgentBySession: { "sess-1": "codex" },
  });
  mounts.mockClear();
  useAgentInboxRailStore.setState({ bySession: {}, pending: {} });
});

describe("InboxSplit", () => {
  it("hides during recovery without remounting the selected conversation", async () => {
    render(
      <div data-surface="terminal">
        <InboxSplit tab={TAB} teamKey="o:t">
          <Terminal />
        </InboxSplit>
      </div>,
    );
    act(() => openAgentInboxRail(TAB.sessionId));
    const rail = await screen.findByTestId("chat-overlay");
    expect(rail.closest("[data-surface]")).toHaveAttribute("data-surface", "canvas");
    expect(screen.getByTestId("terminal").closest("[data-surface]")).toHaveAttribute(
      "data-surface",
      "terminal",
    );
    fireEvent.click(screen.getByText("Select conversation"));
    act(() => useAgentStateStore.getState().activityUnavailable([TAB.sessionId], "recovering"));
    expect(rail).not.toBeVisible();
    act(() =>
      useAgentStateStore.getState().recordActivity(
        {
          session: TAB.sessionId,
          identity: {
            hostBootId: "split-host",
            sessionIncarnation: "split-shell",
            invocationId: crypto.randomUUID(),
          },
          revision: 1,
          turnGeneration: 0,
          provider: "codex",
          state: "idle",
          observed: true,
          limited: false,
          exit: null,
          asks: [],
        },
        0,
      ),
    );
    expect(screen.getByTestId("chat-overlay")).toBe(rail);
    expect(rail).toBeVisible();
    expect(screen.getByText("Selected conversation")).toBeVisible();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it("closes on a real provider exit and only reopens after a relaunch", async () => {
    render(
      <InboxSplit tab={TAB} teamKey="o:t">
        <Terminal />
      </InboxSplit>,
    );
    act(() => openAgentInboxRail(TAB.sessionId));
    await screen.findByTestId("chat-overlay");
    act(() => {
      useAgentStateStore.getState().setProcessAgent(TAB.sessionId, null);
      useAgentStateStore.getState().recordSignal(TAB.sessionId, {
        tier: 1,
        signal: { kind: "claude-hook", event: "SessionEnd" },
      });
    });
    expect(screen.queryByTestId("chat-overlay")).toBeNull();
    expect(useAgentInboxRailStore.getState().bySession[TAB.sessionId]).toBeUndefined();
    act(() => openAgentInboxRail(TAB.sessionId));
    expect(screen.queryByTestId("chat-overlay")).toBeNull();
    act(() => {
      useAgentStateStore.getState().setProcessAgent(TAB.sessionId, "codex");
      openAgentInboxRail(TAB.sessionId);
    });
    await screen.findByTestId("chat-overlay");
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it.each(AGENT_RUNTIMES)(
    "opens the %s chat on its tab without remounting the terminal, and hides it on close",
    async (cli) => {
      useAgentStateStore.getState().setProcessAgent(TAB.sessionId, cli);
      render(
        <InboxSplit tab={TAB} teamKey="o:t">
          <Terminal />
        </InboxSplit>,
      );
      expect(screen.queryByTestId("chat-overlay")).toBeNull();
      act(() => openAgentInboxRail("sess-1"));
      const rail = await screen.findByTestId("chat-overlay");
      expect(rail).toBeVisible();
      expect(rail).toHaveAttribute("data-session-id", "sess-1");
      act(() => closeAgentInboxRail("sess-1"));
      // Closed, the chat stays mounted out of sight, so showing it again is instant.
      expect(screen.getByTestId("chat-overlay")).toBe(rail);
      expect(rail).not.toBeVisible();
      expect(mounts).toHaveBeenCalledTimes(1);
    },
  );

  it.each(REMOTE_LAUNCH_CLIS)(
    "opens a remote %s session's chat on its tab, known from its host's activity",
    async (cli) => {
      // No process on this Mac: a remote tab's agent is known from its host's activity snapshot.
      useAgentStateStore.setState({ processAgentBySession: {} });
      useAgentStateStore.getState().recordActivity(
        {
          session: TAB.sessionId,
          identity: { hostBootId: "box", sessionIncarnation: "shell", invocationId: "agent" },
          revision: 1,
          turnGeneration: 0,
          provider: cli as never,
          state: "idle",
          observed: true,
          limited: false,
          exit: null,
          asks: [],
        },
        0,
      );
      render(
        <InboxSplit tab={TAB} teamKey="o:t">
          <Terminal />
        </InboxSplit>,
      );
      act(() => openAgentInboxRail(TAB.sessionId));
      const rail = await screen.findByTestId("chat-overlay");
      expect(rail).toBeVisible();
      expect(rail).toHaveAttribute("data-session-id", TAB.sessionId);
      expect(mounts).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [900, 600],
    [250, 250],
    [1200, 700],
  ])("covers the whole tab at %i × %i", async (width, height) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          this.cb([{ contentRect: { width, height } } as ResizeObserverEntry], this as never);
        }
        disconnect() {}
      },
    );
    try {
      act(() => openAgentInboxRail("sess-1"));
      render(
        <InboxSplit tab={TAB} teamKey="o:t">
          <Terminal />
        </InboxSplit>,
      );
      const chat = await screen.findByTestId("chat-overlay");
      expect(chat).toHaveAttribute("data-size", `${width}x${height}`);
      expect(chat.style.position).toBe("absolute");
      expect(chat.style.width).toBe("");
      expect(screen.getByTestId("terminal").parentElement).toHaveAttribute("inert");
      expect(mounts).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("takes the covered terminal's keys while the chat covers the tab, and gives them back", async () => {
    render(
      <InboxSplit tab={TAB} teamKey="o:t">
        <Terminal />
      </InboxSplit>,
    );
    const terminal = screen.getByTestId("terminal").parentElement!;
    expect(terminal).not.toHaveAttribute("inert");
    act(() => openAgentInboxRail("sess-1"));
    await screen.findByTestId("chat-overlay");
    expect(terminal).toHaveAttribute("inert");
    act(() => closeAgentInboxRail("sess-1"));
    expect(terminal).not.toHaveAttribute("inert");
  });

  it("a tab launched as an agent opens on its chat once the agent runs", async () => {
    useAgentStateStore.setState({ processAgentBySession: {} });
    render(
      <InboxSplit tab={TAB} teamKey="o:t">
        <Terminal />
      </InboxSplit>,
    );
    act(() => markOpenedAsAgent("sess-1"));
    expect(screen.queryByTestId("chat-overlay")).toBeNull();
    act(() => useAgentStateStore.getState().setProcessAgent("sess-1", "codex"));
    expect(await screen.findByTestId("chat-overlay")).toBeVisible();
    expect(mounts).toHaveBeenCalledTimes(1);
  });

  describe("a CLI started by hand in the tab", () => {
    const hooked = (cli: string | null, state: "working" | "idle" | "done") =>
      useAgentStateStore.setState((s) => ({
        bySession: { ...s.bySession, [TAB.sessionId]: { t1: null, t2: null, state, agent: cli } },
      }));

    it.each(AGENT_RUNTIMES)(
      "%s covers the tab with its chat at its first idle, without remounting the terminal",
      async (cli) => {
        useAgentStateStore.setState({ processAgentBySession: {} });
        render(
          <InboxSplit tab={TAB} teamKey="o:t">
            <Terminal />
          </InboxSplit>,
        );
        act(() => hooked(cli, "working"));
        expect(screen.queryByTestId("chat-overlay")).toBeNull();
        act(() => hooked(cli, "idle"));
        expect(await screen.findByTestId("chat-overlay")).toBeVisible();
        expect(screen.getByTestId("terminal").parentElement).toHaveAttribute("inert");
        // The cover asks nothing of the composer: it never takes the keyboard.
        expect(useAgentInboxRailStore.getState().bySession[TAB.sessionId]?.composeRequest).toBe(0);
        expect(mounts).toHaveBeenCalledTimes(1);
      },
    );

    it.each(AGENT_RUNTIMES)("%s seen only in the process tree stays on the CLI", (cli) => {
      useAgentStateStore.getState().setProcessAgent(TAB.sessionId, cli);
      render(
        <InboxSplit tab={TAB} teamKey="o:t">
          <Terminal />
        </InboxSplit>,
      );
      expect(screen.queryByTestId("chat-overlay")).toBeNull();
      expect(screen.getByTestId("terminal").parentElement).not.toHaveAttribute("inert");
    });

    it("leaves a plain shell once the CLI exits, even with the flip to the CLI held", async () => {
      useAgentStateStore.setState({ processAgentBySession: {} });
      render(
        <InboxSplit tab={TAB} teamKey="o:t">
          <Terminal />
        </InboxSplit>,
      );
      act(() => hooked("claude", "idle"));
      await screen.findByTestId("chat-overlay");
      act(() => closeAgentInboxRail(TAB.sessionId));
      act(() => hooked(null, "done"));
      expect(useAgentInboxRailStore.getState().bySession[TAB.sessionId]?.shown).toBe(false);
      expect(screen.queryByTestId("chat-overlay")).toBeNull();
      expect(screen.getByTestId("terminal").parentElement).not.toHaveAttribute("inert");
      act(() => hooked("claude", "idle"));
      expect(screen.getByTestId("chat-overlay")).not.toBeVisible();
      expect(mounts).toHaveBeenCalledTimes(1);
    });
  });
});

// SPDX-License-Identifier: MIT
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { AGENT_RUNTIMES } from "@/shared/lib/agent-runtimes";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, render, screen } from "@/test-utils";
import {
  closeAgentInboxRail,
  openAgentInboxRail,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";

vi.mock("./chat-overlay", () => ({
  ChatOverlay: (p: {
    sessionId: string;
    style: React.CSSProperties;
    placement: string;
    size: { width: number; height: number };
  }) => {
    const [selected, setSelected] = useState(false);
    return (
      <aside
        data-testid="chat-overlay"
        data-session-id={p.sessionId}
        data-placement={p.placement}
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
  useAgentInboxRailStore.setState({ bySession: {} });
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
    "opens the %s chat on its tab without remounting the terminal",
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
      expect(screen.queryByTestId("chat-overlay")).toBeNull();
      expect(mounts).toHaveBeenCalledTimes(1);
    },
  );

  it("docks the chat at 420 px on a wide tab, and covers a tab under 840 wide", async () => {
    const box = { width: 1200, height: 700 };
    const observers: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe() {
          const fire = () => this.cb([{ contentRect: box } as ResizeObserverEntry], this as never);
          observers.push(fire);
          fire();
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
      expect(chat).toHaveAttribute("data-placement", "dock");
      expect(chat).toHaveAttribute("data-size", "420x700");
      expect(chat.style.width).toBe("420px");
      Object.assign(box, { width: 600, height: 300 });
      act(() => observers.forEach((f) => f()));
      expect(chat).toHaveAttribute("data-placement", "cover");
      expect(chat).toHaveAttribute("data-size", "600x300");
      expect(chat.style.position).toBe("absolute");
      expect(mounts).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

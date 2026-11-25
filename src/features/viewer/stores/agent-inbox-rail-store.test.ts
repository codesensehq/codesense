// SPDX-License-Identifier: MIT
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeAgentInboxRail,
  closeAgentInboxRailToTerminal,
  clearOpenedAsAgent,
  flipAgentView,
  forgetAgentInboxRail,
  markOpenedAsAgent,
  openAgentInboxRail,
  showAgentChat,
  useAgentInboxRailStore,
} from "./agent-inbox-rail-store";

const SID = "sid-triage";

beforeEach(() => {
  useAgentStateStore.setState({
    bySession: {},
    activityBySession: {},
    exitBySession: {},
    processAgentBySession: { "sid-triage": "codex", "sid-a": "codex", "sid-b": "codex" },
  });
  useAgentInboxRailStore.setState({ bySession: {}, pending: {} });
});

describe("agent inbox rail store", () => {
  it("closes an exited agent's rail even while its pane is unmounted", () => {
    useAgentStateStore.getState().setProcessAgent(SID, "claude");
    openAgentInboxRail(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toBeDefined();
    useAgentStateStore
      .getState()
      .recordSignal(SID, { tier: 1, signal: { kind: "claude-hook", event: "SessionEnd" } });
    expect(useAgentInboxRailStore.getState().bySession[SID]).toBeUndefined();
  });

  it("open adds a shown entry with composeRequest 0", () => {
    openAgentInboxRail(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({
      composeRequest: 0,
      shown: true,
    });
  });

  it("open with compose bumps composeRequest each call", () => {
    openAgentInboxRail(SID, { compose: true });
    openAgentInboxRail(SID, { compose: true });
    expect(useAgentInboxRailStore.getState().bySession[SID]?.composeRequest).toBe(2);
  });

  it("plain re-open of an entry is a no-op (identity preserved)", () => {
    openAgentInboxRail(SID);
    const before = useAgentInboxRailStore.getState().bySession[SID];
    openAgentInboxRail(SID);
    const after = useAgentInboxRailStore.getState().bySession[SID];
    expect(after).toBe(before);
  });

  it("close keeps the entry and hides the chat", () => {
    openAgentInboxRail(SID, { compose: true });
    closeAgentInboxRail(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({
      composeRequest: 1,
      shown: false,
    });
  });

  it("open shows a hidden chat again, even with no new compose request", () => {
    openAgentInboxRail(SID);
    closeAgentInboxRail(SID);
    showAgentChat(SID, "keep");
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({
      composeRequest: 0,
      shown: true,
    });
  });

  it("the group chat shortcut shows a hidden chat", () => {
    openAgentInboxRail(SID);
    closeAgentInboxRail(SID);
    useAgentInboxRailStore.getState().openGroup(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toMatchObject({
      shown: true,
      groupRequest: 1,
    });
  });

  it("the flip hides a shown chat and shows a hidden one, asking for the composer", () => {
    flipAgentView(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({
      composeRequest: 1,
      shown: true,
    });
    flipAgentView(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({
      composeRequest: 1,
      shown: false,
    });
    flipAgentView(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({
      composeRequest: 2,
      shown: true,
    });
  });

  it("each session is isolated", () => {
    openAgentInboxRail("sid-a", { compose: true });
    openAgentInboxRail("sid-b");
    expect(useAgentInboxRailStore.getState().bySession["sid-a"]).toEqual({
      composeRequest: 1,
      shown: true,
    });
    expect(useAgentInboxRailStore.getState().bySession["sid-b"]).toEqual({
      composeRequest: 0,
      shown: true,
    });
    closeAgentInboxRail("sid-a");
    expect(useAgentInboxRailStore.getState().bySession["sid-a"]?.shown).toBe(false);
    expect(useAgentInboxRailStore.getState().bySession["sid-b"]).toEqual({
      composeRequest: 0,
      shown: true,
    });
  });

  it("hides the chat, then focuses the pane's terminal once the chat has gone", async () => {
    openAgentInboxRail(SID);
    const pane = document.createElement("div");
    pane.innerHTML = '<div class="xterm"><textarea data-testid="term"></textarea></div>';
    document.body.appendChild(pane);
    closeAgentInboxRailToTerminal(SID, pane);
    expect(useAgentInboxRailStore.getState().bySession[SID]?.shown).toBe(false);
    // A covered terminal is inert until then: focus waits for the next frame.
    expect(document.activeElement).not.toBe(pane.querySelector("textarea"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(pane.querySelector("textarea"));
    pane.remove();
  });

  it("hides the chat and leaves focus alone when there is no pane to hand it to", () => {
    openAgentInboxRail(SID);
    expect(() => closeAgentInboxRailToTerminal(SID, null)).not.toThrow();
    expect(useAgentInboxRailStore.getState().bySession[SID]?.shown).toBe(false);
  });
});

describe("opened as an agent", () => {
  const NEW = "sid-new";
  const open = () => useAgentInboxRailStore.getState().bySession[NEW];
  const becomeAgent = () => useAgentStateStore.getState().setProcessAgent(NEW, "claude");
  const exit = () =>
    useAgentStateStore.getState().recordPtyExit(NEW, { code: 1, signal: null, requested: false });

  it("opens the chat at once when the launched agent already runs", () => {
    becomeAgent();
    markOpenedAsAgent(NEW);
    expect(open()).toEqual({ composeRequest: 0, shown: true });
  });

  it("waits for the agent to become eligible, then covers", () => {
    markOpenedAsAgent(NEW);
    expect(open()).toBeUndefined();
    becomeAgent();
    expect(open()).toEqual({ composeRequest: 0, shown: true });
    expect(useAgentInboxRailStore.getState().pending[NEW]).toBeUndefined();
  });

  it("a failed launch clears the mark, so a CLI started later by hand stays uncovered", () => {
    markOpenedAsAgent(NEW);
    clearOpenedAsAgent(NEW);
    becomeAgent();
    expect(open()).toBeUndefined();
  });

  it("a process that exits before the agent is eligible clears the mark", () => {
    markOpenedAsAgent(NEW);
    exit();
    expect(useAgentInboxRailStore.getState().pending[NEW]).toBeUndefined();
    useAgentStateStore.setState({ exitBySession: {} });
    becomeAgent();
    expect(open()).toBeUndefined();
  });

  it("the person's closed choice holds, even while the mark is still pending", () => {
    markOpenedAsAgent(NEW);
    closeAgentInboxRail(NEW);
    becomeAgent();
    expect(open()?.shown).not.toBe(true);
  });

  it("the person's closed choice holds once the chat has covered the tab", () => {
    markOpenedAsAgent(NEW);
    becomeAgent();
    closeAgentInboxRail(NEW);
    becomeAgent();
    markOpenedAsAgent(NEW);
    expect(open()).toEqual({ composeRequest: 0, shown: false });
  });

  it("an agent that ends is forgotten, and a restart in the tab opens on the CLI", () => {
    markOpenedAsAgent(NEW);
    becomeAgent();
    expect(open()).toBeDefined();
    exit();
    expect(open()).toBeUndefined();
    useAgentStateStore.setState({ exitBySession: {} });
    becomeAgent();
    expect(open()).toBeUndefined();
  });

  it("forget drops the open entry and a pending mark", () => {
    markOpenedAsAgent(NEW);
    forgetAgentInboxRail(NEW);
    becomeAgent();
    expect(open()).toBeUndefined();
    openAgentInboxRail(NEW);
    forgetAgentInboxRail(NEW);
    expect(open()).toBeUndefined();
  });

  it("a hand-started agent gets no mark and so no cover", () => {
    becomeAgent();
    expect(open()).toBeUndefined();
  });
});

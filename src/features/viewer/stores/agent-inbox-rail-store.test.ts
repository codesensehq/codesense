// SPDX-License-Identifier: MIT
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeAgentInboxRail,
  closeAgentInboxRailToTerminal,
  openAgentInboxRail,
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
  useAgentInboxRailStore.setState({ bySession: {} });
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

  it("open adds an entry with composeRequest 0", () => {
    openAgentInboxRail(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toEqual({ composeRequest: 0 });
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

  it("close drops the entry", () => {
    openAgentInboxRail(SID, { compose: true });
    closeAgentInboxRail(SID);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toBeUndefined();
  });

  it("each session is isolated", () => {
    openAgentInboxRail("sid-a", { compose: true });
    openAgentInboxRail("sid-b");
    expect(useAgentInboxRailStore.getState().bySession["sid-a"]).toEqual({ composeRequest: 1 });
    expect(useAgentInboxRailStore.getState().bySession["sid-b"]).toEqual({ composeRequest: 0 });
    closeAgentInboxRail("sid-a");
    expect(useAgentInboxRailStore.getState().bySession["sid-a"]).toBeUndefined();
    expect(useAgentInboxRailStore.getState().bySession["sid-b"]).toEqual({ composeRequest: 0 });
  });

  it("closes the chat, then focuses the pane's terminal once the chat has gone", async () => {
    openAgentInboxRail(SID);
    const pane = document.createElement("div");
    pane.innerHTML = '<div class="xterm"><textarea data-testid="term"></textarea></div>';
    document.body.appendChild(pane);
    closeAgentInboxRailToTerminal(SID, pane);
    expect(useAgentInboxRailStore.getState().bySession[SID]).toBeUndefined();
    // A covered terminal is inert until then: focus waits for the next frame.
    expect(document.activeElement).not.toBe(pane.querySelector("textarea"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(pane.querySelector("textarea"));
    pane.remove();
  });

  it("closes the chat and leaves focus alone when there is no pane to hand it to", () => {
    openAgentInboxRail(SID);
    expect(() => closeAgentInboxRailToTerminal(SID, null)).not.toThrow();
    expect(useAgentInboxRailStore.getState().bySession[SID]).toBeUndefined();
  });
});

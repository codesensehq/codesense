// SPDX-License-Identifier: MIT
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { beforeEach, describe, expect, it } from "vitest";

import {
  closeAgentInboxRail,
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
});

// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import type { ActivitySnapshot, AgentSessionRow } from "@/tauri/commands";
import {
  agentInputSeq,
  getSessionActivityAt,
  resetPrunedAgentSessionsForTests,
  retireAgentSession,
  snapshotAgentSession,
  useAgentStateStore,
} from "./agent-state-store";

const SESSIONS = Array.from({ length: 22 }, (_, i) => `s${i}`);

const snapshot = (session: string, patch: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
  session,
  identity: { hostBootId: "boot", sessionIncarnation: "pty", invocationId: "run" },
  revision: 1,
  turnGeneration: 1,
  provider: "claude",
  state: "working",
  observed: true,
  limited: false,
  exit: null,
  asks: [],
  ...patch,
});

const row = (sessionId: string, lastOutputMs: number): AgentSessionRow =>
  ({
    handle: sessionId,
    sessionId,
    kind: "agent",
    alive: true,
    lastOutputMs,
  }) as AgentSessionRow;

beforeEach(() => {
  resetPrunedAgentSessionsForTests();
  useAgentStateStore.setState({ bySession: {}, activityBySession: {}, exitBySession: {} });
  useAgentListProjectionStore.setState({ sessions: null });
});
afterEach(() => {
  vi.useRealTimers();
  useAgentListProjectionStore.setState({ sessions: null });
});

describe("activity ticks", () => {
  it("22 sessions emitting output for 10 s change bySession identity 0 times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (const id of SESSIONS) useAgentStateStore.getState().recordActivity(snapshot(id), 0);
    let copies = 0;
    const stop = useAgentStateStore.subscribe((state, previous) => {
      if (state.bySession !== previous.bySession) copies++;
    });
    let notifications = 0;
    const stopAll = useAgentStateStore.subscribe(() => notifications++);
    try {
      for (let tick = 1; tick <= 40; tick++) {
        vi.advanceTimersByTime(250);
        const now = Date.now();
        useAgentListProjectionStore.getState().setSessions(SESSIONS.map((id) => row(id, now)));
      }
    } finally {
      stop();
      stopAll();
    }
    expect({ copies, notifications }).toEqual({ copies: 0, notifications: 0 });
    for (const id of SESSIONS) expect(getSessionActivityAt(id)).toBe(1_010_000 - 250 * 3);
  });

  it("output for an unknown session is readable without creating a record", () => {
    const store = useAgentStateStore.getState();
    store.recordOutput("headless", 1000);
    expect(getSessionActivityAt("headless")).toBe(1000);
    expect(useAgentStateStore.getState().bySession.headless).toBeUndefined();
    // Bounded to one update a second.
    store.recordOutput("headless", 1500);
    expect(getSessionActivityAt("headless")).toBe(1000);
    store.recordOutput("headless", 2000);
    expect(getSessionActivityAt("headless")).toBe(2000);
  });

  it("prune, reset, exit and a new life clear or keep the activity time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const store = useAgentStateStore.getState();
    store.recordOutput("pruned", 1000);
    store.remove(["pruned"]);
    expect(getSessionActivityAt("pruned")).toBeUndefined();
    store.recordOutput("pruned", 3000);
    expect(getSessionActivityAt("pruned")).toBeUndefined();

    store.recordOutput("respawn", 1000);
    store.reset("respawn");
    expect(getSessionActivityAt("respawn")).toBeUndefined();

    store.recordOutput("exited", 1000);
    store.recordPtyExit("exited", { code: 0, signal: null, requested: false });
    store.recordOutput("exited", 3000);
    expect(getSessionActivityAt("exited")).toBe(1000);

    store.recordActivity(snapshot("life"), agentInputSeq());
    store.recordOutput("life", 4000);
    expect(getSessionActivityAt("life")).toBe(4000);
    store.recordActivity(
      snapshot("life", { identity: { ...snapshot("life").identity, invocationId: "next" } }),
      agentInputSeq(),
    );
    expect(getSessionActivityAt("life")).toBeUndefined();
  });

  it("a respawn retires the ended life's activity time, but keeps one the new life wrote", () => {
    const store = useAgentStateStore.getState();
    store.recordOutput("old", 1000);
    const old = snapshotAgentSession("old");
    retireAgentSession("old", old);
    expect(getSessionActivityAt("old")).toBeUndefined();

    store.recordOutput("new", 1000);
    const ended = snapshotAgentSession("new");
    store.recordOutput("new", 3000);
    retireAgentSession("new", ended);
    expect(getSessionActivityAt("new")).toBe(3000);
  });
});

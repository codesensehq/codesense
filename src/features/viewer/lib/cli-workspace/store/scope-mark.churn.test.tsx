// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { installTerminalLayoutHarness, seedTerminalTabs } from "@/test/terminal-layout-harness";
import { resetSessionProjection } from "@/test/session-projection-fixture";
import { useViewerStore } from "@/shared/stores/viewer-store";
import {
  resetPrunedAgentSessionsForTests,
  useAgentStateStore,
} from "@/shared/stores/agent-state-store";
import { resetManagedSessionStoreForTests } from "@/shared/stores/use-managed-session-store";
import {
  resetDotSinceForTests,
  useNeedsYouList,
  useScopeMark,
  useStoryMarks,
  useStoryTabs,
} from "./terminal-tab-selectors";

installTerminalLayoutHarness();
const TEAM = "acme:core";
const WS = "ws-1";
const story = { filePath: "/work/one.md", storyId: "one" };
const stories = [story];
const SESSIONS = ["s-ask", "s-a", "s-b"];

const hook = (sessionId: string, event: "UserPromptSubmit" | "PreToolUse") =>
  useAgentStateStore.getState().recordSignal(sessionId, {
    tier: 1,
    signal: { kind: "claude-hook", event },
  });

beforeEach(() => {
  resetSessionProjection();
  resetDotSinceForTests();
  resetPrunedAgentSessionsForTests();
  resetManagedSessionStoreForTests();
  useAgentStateStore.setState({ bySession: {}, exitBySession: {}, stateSince: {}, seenAt: {} });
  useViewerStore.setState({
    activeWorkspace: { [TEAM]: WS },
    workspaces: {
      [TEAM]: [
        {
          id: WS,
          kind: "story",
          cwd: "/wt",
          status: "ready",
          storyId: story.storyId,
          storyFilePath: story.filePath,
        },
      ],
    },
    terminalVisible: true,
    softClosedWorkspaces: {},
    aiStatusBySession: { "s-ask": "needs-permission" },
    progressTickBySession: {},
  });
  seedTerminalTabs(TEAM, WS, SESSIONS, { active: "s-ask" });
  hook("s-a", "UserPromptSubmit");
  hook("s-b", "UserPromptSubmit");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mark selectors on a store change", () => {
  it("scope-mark, story-mark, story-tab and needs-you selectors do no JSON.stringify", () => {
    let needsYouRenders = 0;
    const scope = renderHook(() => useScopeMark({ sessionIds: SESSIONS }));
    const needsYou = renderHook(() => {
      needsYouRenders++;
      return useNeedsYouList(TEAM);
    });
    const marks = renderHook(() => useStoryMarks(TEAM, stories));
    const tabs = renderHook(() => useStoryTabs(TEAM, story));
    expect(needsYou.result.current.map((row) => row.sessionId)).toEqual(["s-ask"]);
    expect(tabs.result.current.map((tab) => tab.sessionId)).toEqual(SESSIONS);
    const list = needsYou.result.current;
    const storyMarks = marks.result.current;
    const storyTabs = tabs.result.current;
    const rendersBefore = needsYouRenders;

    const stringify = vi.spyOn(JSON, "stringify");
    // A record moves without moving its dot, a dot moves, and an unrelated viewer write lands.
    act(() => hook("s-b", "UserPromptSubmit"));
    act(() => hook("s-a", "PreToolUse"));
    act(() =>
      useViewerStore.setState((s) => ({
        progressTickBySession: { ...s.progressTickBySession, "s-b": 1 },
      })),
    );
    const calls = stringify.mock.calls.length;
    stringify.mockRestore();

    expect(calls).toBe(0);
    expect(needsYouRenders).toBe(rendersBefore);
    expect(needsYou.result.current).toBe(list);
    expect(marks.result.current).toBe(storyMarks);
    expect(tabs.result.current).toBe(storyTabs);
    expect(scope.result.current.mark).toBeDefined();
  });

  it("keeps re-rendering when a selector's value changes", () => {
    const needsYou = renderHook(() => useNeedsYouList(TEAM));
    const scope = renderHook(() => useScopeMark({ sessionIds: ["s-a"] }));
    const before = scope.result.current;
    act(() =>
      useViewerStore.setState((s) => ({
        aiStatusBySession: { ...s.aiStatusBySession, "s-b": "needs-permission" },
      })),
    );
    expect(needsYou.result.current.map((row) => row.sessionId).sort()).toEqual(["s-ask", "s-b"]);
    act(() => useAgentStateStore.getState().remove(["s-a"]));
    expect(scope.result.current).not.toEqual(before);
  });
});

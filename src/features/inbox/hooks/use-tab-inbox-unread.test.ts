// SPDX-License-Identifier: MIT
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({ watch: vi.fn(), snapshot: vi.fn(), stop: vi.fn() }));
vi.mock("@/features/dashboard/lib/live-hub", () => ({ liveHub: hub }));

import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import type { AgentSessionRow, SessionListRow } from "@/tauri/commands";

import { joinInboxSessions, type InboxCounts } from "../projection";
import { useInboxProjectionStore } from "./use-inbox-projection";
import { useInboxSessionsStore } from "./use-inbox-sessions";
import { useTabInboxCounts } from "./use-tab-inbox-unread";

const TEAM = { org: "acme", team: "core" };
const OTHER = { org: "acme", team: "ops" };

const session = (handle: string, unread: number, team = TEAM): SessionListRow =>
  ({ id: handle, handle, team, unread, groupUnread: 0 }) as unknown as SessionListRow;

const counts = (
  team: typeof TEAM,
  sessions: Record<string, Partial<SessionListRow>>,
): InboxCounts =>
  ({
    id: `counts:${team.team}`,
    rowType: "counts",
    team,
    humanUnread: 0,
    recipients: {},
    needsYouBySender: {},
    sessions,
  }) as InboxCounts;

beforeEach(() => {
  vi.clearAllMocks();
  hub.watch.mockReturnValue(hub.stop);
  hub.snapshot.mockReturnValue(new Promise(() => {}));
  useAgentListProjectionStore.setState({
    sessions: [
      { handle: "x", sessionId: "sx" },
      { handle: "y", sessionId: "sy" },
    ] as AgentSessionRow[],
  });
  useInboxSessionsStore.setState({
    sessions: [session("x", 1), session("y", 2), session("z", 5, OTHER)],
  });
  useInboxProjectionStore.setState({
    counts: [
      counts(TEAM, { y: { unread: 3, groupUnread: 4 } }),
      counts(OTHER, { x: { unread: 9 } }),
    ],
  });
});

it("reads one handle's counts, equal to that handle's joined row", () => {
  const joined = joinInboxSessions(
    useInboxSessionsStore.getState().sessions!,
    useInboxProjectionStore.getState().counts,
  );
  for (const [sessionId, handle] of [
    ["sx", "x"],
    ["sy", "y"],
  ]) {
    const row = joined.find((r) => r.handle === handle)!;
    const { result } = renderHook(() => useTabInboxCounts(sessionId));
    expect(result.current).toEqual({ direct: row.unread ?? 0, group: row.groupUnread ?? 0 });
  }
  // A tab whose session has no inbox row, or no inbox read yet, counts nothing.
  expect(renderHook(() => useTabInboxCounts("nope")).result.current).toEqual({
    direct: 0,
    group: 0,
  });
  act(() => useInboxSessionsStore.setState({ sessions: null }));
  expect(renderHook(() => useTabInboxCounts("sy")).result.current).toEqual({ direct: 0, group: 0 });
});

it("redraws a tab's counts only when that handle's counts change", () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useTabInboxCounts("sx");
  });
  expect(result.current).toEqual({ direct: 1, group: 0 });
  const before = renders;

  // Another handle's message, in the inbox projection and in the session list.
  act(() =>
    useInboxProjectionStore.setState({
      counts: [
        counts(TEAM, { y: { unread: 7, groupUnread: 4 } }),
        counts(OTHER, { x: { unread: 9 } }),
      ],
    }),
  );
  act(() =>
    useInboxSessionsStore.setState({
      sessions: [session("x", 1), session("y", 8), session("z", 5, OTHER)],
    }),
  );
  // Another agent starts.
  act(() =>
    useAgentListProjectionStore.setState((s) => ({
      sessions: [...(s.sessions ?? []), { handle: "w", sessionId: "sw" } as AgentSessionRow],
    })),
  );
  expect(renders).toBe(before);

  act(() =>
    useInboxProjectionStore.setState({
      counts: [
        counts(TEAM, { x: { unread: 2, groupUnread: 1 }, y: { unread: 7, groupUnread: 4 } }),
      ],
    }),
  );
  expect(result.current).toEqual({ direct: 2, group: 1 });
  expect(renders).toBe(before + 1);
});

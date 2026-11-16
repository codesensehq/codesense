// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { SessionListRow } from "@/tauri/commands";

const h = vi.hoisted(() => ({ sessions: [] as SessionListRow[] | null, agentPins: vi.fn() }));
vi.mock("./use-inbox-sessions", () => ({ useInboxSessions: () => h.sessions }));
vi.mock("@/tauri/commands", async (orig) => ({
  ...(await orig<typeof import("@/tauri/commands")>()),
  agentPins: h.agentPins,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import type { ConversationMessage } from "../api";
import { HUMAN, buildDirectory } from "../model";
import type { InboxView } from "../components/inbox-view-context";
import { useThreadPins } from "./use-thread-pins";

const TEAM = { org: "acme", team: "backend" };
const said = (id: number, from: string) =>
  ({ id, team: TEAM, from, to: HUMAN, text: `m${id}`, createdAtMs: id }) as ConversationMessage;
const view = (me: string, self?: string): InboxView =>
  ({
    me,
    self,
    dir: buildDirectory(h.sessions ?? [], []),
    fallbackTeam: TEAM,
  }) as unknown as InboxView;

beforeEach(() => {
  h.agentPins.mockReset();
  h.agentPins.mockResolvedValue({ status: "pins", ...TEAM, agentId: "a", storyId: "", pins: [] });
});

describe("Inbox pins: only where the conversation maps to one agent thread", () => {
  it("a conversation with a session launched from a saved agent pins into that agent and story", async () => {
    h.sessions = [
      { handle: "BUG-1#lead", agent: "acme/backend/dev", story: "BUG-1" } as SessionListRow,
    ];
    const { result } = renderHook(() =>
      useThreadPins("BUG-1#lead", [said(1, "BUG-1#lead")], view(HUMAN)),
    );
    expect(result.current).not.toBeNull();
    await waitFor(() =>
      expect(h.agentPins).toHaveBeenCalledWith(TEAM, "acme/backend/dev", "BUG-1", { op: "read" }),
    );
  });

  it("pins into the session's own team, not the team of the newest message", async () => {
    const other = { org: "acme", team: "frontend" };
    h.sessions = [
      {
        handle: "BUG-2#lead",
        agent: "acme/frontend/dev",
        story: "BUG-2",
        team: other,
      } as SessionListRow,
    ];
    renderHook(() => useThreadPins("BUG-2#lead", [said(1, "BUG-2#lead")], view(HUMAN)));
    await waitFor(() =>
      expect(h.agentPins).toHaveBeenCalledWith(other, "acme/frontend/dev", "BUG-2", { op: "read" }),
    );
  });

  it("has no Pin for a role, a session from no saved agent, an unknown party, or an agent's own view", () => {
    h.sessions = [{ handle: "adhoc", story: "BUG-1" } as SessionListRow];
    for (const [key, v] of [
      ["#reviewers", view(HUMAN)],
      ["adhoc", view(HUMAN)],
      ["gone", view(HUMAN)],
      ["adhoc", view("worker-1", "worker-1")],
    ] as const) {
      const { result } = renderHook(() => useThreadPins(key, [said(1, key)], v));
      expect(result.current, key).toBeNull();
    }
    expect(h.agentPins).not.toHaveBeenCalled();
  });
});

describe("Inbox pins: a pin is named by what the pins read says its message is", () => {
  it("names a pin of a message outside this conversation (a concurrent seat's) by its text, at the cap too", async () => {
    h.sessions = [
      { handle: "BUG-1#lead", agent: "acme/backend/dev", story: "BUG-1" } as SessionListRow,
    ];
    const pin = (messageId: number, from: string, text: string) => ({
      messageId,
      position: 0,
      pinnedBy: from,
      pinnedAtMs: 1,
      message: { from, createdAtMs: 1, text },
    });
    h.agentPins.mockResolvedValue({
      status: "pins",
      ...TEAM,
      agentId: "acme/backend/dev",
      storyId: "BUG-1",
      pins: [
        pin(1, "BUG-1#lead", "m1"),
        pin(2, "BUG-1#lead", "m2"),
        pin(77, "BUG-1#lead-2", "Tests pass. The rest is cleanup."),
      ],
    });
    const mine = [said(1, "BUG-1#lead"), said(2, "BUG-1#lead"), said(3, "BUG-1#lead")];
    const { result } = renderHook(() => useThreadPins("BUG-1#lead", mine, view(HUMAN)));
    await waitFor(() => expect(result.current?.stateOf(mine[2]!).atCap).toBe(true));
    act(() => result.current!.toggle(mine[2]!));
    const rows = result.current!.chooser!.rows;
    expect(rows.find((r) => r.pin.messageId === 77)!.title).toBe("Tests pass.");
    expect(rows.find((r) => r.pin.messageId === 77)!.own).toBe("quote");
  });
});

describe("Inbox pins: a message this conversation holds is named from its own row", () => {
  it("prefers the conversation's message to the pins read's copy", async () => {
    h.sessions = [
      { handle: "BUG-1#lead", agent: "acme/backend/dev", story: "BUG-1" } as SessionListRow,
    ];
    h.agentPins.mockResolvedValue({
      status: "pins",
      ...TEAM,
      agentId: "acme/backend/dev",
      storyId: "BUG-1",
      pins: [1, 2, 3].map((messageId) => ({
        messageId,
        position: messageId - 1,
        pinnedBy: "BUG-1#lead",
        pinnedAtMs: 1,
        message: { from: "BUG-1#lead", createdAtMs: 1, text: "A shortened copy." },
      })),
    });
    const mine = [1, 2, 3, 4].map((id) => said(id, "BUG-1#lead"));
    const { result } = renderHook(() => useThreadPins("BUG-1#lead", mine, view(HUMAN)));
    await waitFor(() => expect(result.current?.stateOf(mine[3]!).atCap).toBe(true));
    act(() => result.current!.toggle(mine[3]!));
    expect(result.current!.chooser!.rows.map((r) => r.title)).toEqual(["m1", "m2", "m3"]);
  });
});

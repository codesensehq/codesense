// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

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

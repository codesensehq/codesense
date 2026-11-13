// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { AGENT_PINS_CHANGED_EVENT } from "@/tauri/events";
import type { AgentPin } from "@/tauri/commands";

import { useAgentPins } from "./use-agent-pins";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(),
}));
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return Promise.resolve(() => handlers.delete(event));
  }),
}));

const TEAM = { org: "acme", team: "widgets" };
const pin = (messageId: number, position: number): AgentPin => ({
  messageId,
  position,
  pinnedBy: "lead",
  pinnedAtMs: 1,
});
const answer = (pins: AgentPin[]) => ({
  status: "pins",
  ...TEAM,
  agentId: "builtin/claude",
  storyId: "BUG-142",
  pins,
});

beforeEach(() => {
  handlers.clear();
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockClear();
});

describe("useAgentPins", () => {
  it("reads the thread's pins from its team's store", async () => {
    vi.mocked(invoke).mockResolvedValue(answer([pin(7, 0), pin(9, 1)]));
    const { result } = renderHook(() => useAgentPins(TEAM, "builtin/claude", "BUG-142"));
    await waitFor(() => expect(result.current.pins.map((p) => p.messageId)).toEqual([7, 9]));
    expect(invoke).toHaveBeenCalledWith(
      "agent_pins",
      expect.objectContaining({ team: TEAM, agentId: "builtin/claude", storyId: "BUG-142" }),
    );
  });

  it("follows the change event for its own thread only", async () => {
    vi.mocked(invoke).mockResolvedValue(answer([pin(7, 0)]));
    const { result } = renderHook(() => useAgentPins(TEAM, "builtin/claude", "BUG-142"));
    await waitFor(() => expect(result.current.pins).toHaveLength(1));
    await waitFor(() => expect(handlers.has(AGENT_PINS_CHANGED_EVENT)).toBe(true));

    vi.mocked(invoke).mockResolvedValue(answer([pin(7, 0), pin(9, 1)]));
    await act(async () =>
      handlers.get(AGENT_PINS_CHANGED_EVENT)!({
        payload: { ...TEAM, agentId: "builtin/codex", storyId: "BUG-142" },
      }),
    );
    expect(result.current.pins).toHaveLength(1);

    await act(async () =>
      handlers.get(AGENT_PINS_CHANGED_EVENT)!({
        payload: { ...TEAM, agentId: "builtin/claude", storyId: "BUG-142" },
      }),
    );
    await waitFor(() => expect(result.current.pins).toHaveLength(2));
  });

  it("reads nothing for a session launched from no saved agent", async () => {
    const { result } = renderHook(() => useAgentPins(TEAM, null, "BUG-142"));
    expect(result.current.pins).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps no pins when the engine refuses the read", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "invalid", message: "no such team" });
    const { result } = renderHook(() => useAgentPins(TEAM, "builtin/claude", null));
    await waitFor(() => expect(result.current.error).toBe("no such team"));
    expect(result.current.pins).toEqual([]);
  });
});

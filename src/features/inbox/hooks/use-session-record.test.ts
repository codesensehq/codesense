// SPDX-License-Identifier: MIT
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SESSION_RECORD_EVENTS } from "@/features/dashboard/lib/live-hub";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  sessionRecord: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    mocks.handlers.set(event, cb);
    return () => mocks.handlers.delete(event);
  }),
}));
vi.mock("@/tauri/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tauri/commands")>()),
  sessionRecord: mocks.sessionRecord,
}));

import { formatCost, modelLabel, useSessionRecord } from "./use-session-record";

describe("the record's events", () => {
  it("reads the record again on each event in the shared list", async () => {
    mocks.sessionRecord.mockResolvedValue({ sessionIds: ["s1"] });
    renderHook(() => useSessionRecord("h", "s1"));
    await waitFor(() => expect(mocks.handlers.size).toBe(SESSION_RECORD_EVENTS.length));
    await waitFor(() => expect(mocks.sessionRecord).toHaveBeenCalledTimes(1));
    for (const [i, event] of SESSION_RECORD_EVENTS.entries()) {
      mocks.handlers.get(event)!({ payload: { sessionId: "s1", sessionIds: ["s1"] } });
      await waitFor(() => expect(mocks.sessionRecord).toHaveBeenCalledTimes(i + 2));
    }
  });
});

describe("the record line's words", () => {
  it("says a model as people do, and any other id as it is", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5-5-20261101")).toBe("Sonnet 5.5");
    expect(modelLabel("gpt-5.5-codex")).toBe("gpt-5.5-codex");
  });
  it("says a cost to the cent, and a fraction of a cent as under one", () => {
    expect(formatCost(1.255)).toBe("$1.25");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.003)).toBe("<$0.01");
    expect(formatCost(20.7)).toBe("$20.70");
  });
});

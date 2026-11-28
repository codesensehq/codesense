// SPDX-License-Identifier: MIT
/** A satellite's registry client mounts its move listeners before it reports ready, and
 *  its slice source follows the registry's slices. */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@/shared/lib/current-window", () => ({
  currentWindowLabel: () => "pane-x",
  currentWebviewWindow: () => ({
    listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
      calls.push(`listen ${event}`);
      handlers.set(event, handler);
      return () => {};
    }),
  }),
}));

vi.mock("@/tauri/commands", () => ({
  windowGetSlice: vi.fn(async (label: string) => {
    calls.push(`get ${label}`);
    return {
      label,
      kind: "satellite",
      number: 2,
      version: 1,
      layoutRef: null,
      items: [],
      pending: true,
    };
  }),
  windowReady: vi.fn(async () => {
    calls.push("ready");
  }),
  windowHandOffAck: vi.fn(async () => "committed"),
}));

import { startSatelliteRegistry } from "./satellite-registry";

describe("a satellite's registry client", () => {
  it("listens for its moves and slices, pulls, then reports ready", async () => {
    const { source } = startSatelliteRegistry();
    await vi.waitFor(() => expect(calls).toContain("ready"));
    expect(calls).toEqual([
      "listen window:hand-off",
      "listen window:move-aborted",
      "listen window:slice",
      "get pane-x",
      "ready",
    ]);
    expect(source.current()?.items).toEqual([]);

    const seen = vi.fn();
    source.subscribe(seen);
    const item = { kind: "tab", team: "acme:general", id: "/acme/a.md" };
    const next = {
      label: "pane-x",
      kind: "satellite",
      number: 2,
      version: 2,
      layoutRef: null,
      items: [item],
      pending: false,
    };
    handlers.get("window:slice")?.({ payload: next });
    expect(seen).toHaveBeenCalledOnce();
    expect(source.current()).toEqual(next);
    handlers.get("window:slice")?.({ payload: { ...next, version: 1 } });
    expect(source.current()).toEqual(next);
  });
});

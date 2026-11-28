// SPDX-License-Identifier: MIT
/**
 * A terminal's signals stay with `main` when a satellite holds its tile. Only render
 * output goes to the attached window; a needs-you status still sets the session's dot in
 * `main`, where the attention alerts and the badge read it through `selectNeedsYouKind`.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  main: true,
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/current-window")>()),
  isMainWindow: () => h.main,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => h.handlers.delete(name);
  }),
}));

import { selectNeedsYouKind } from "@/features/viewer/lib/session-status-signals";
import { useTerminalStatusEvents } from "@/shared/hooks/use-terminal-status-events";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { canonicalItemKey, type ItemKey } from "./item-key";
import { applyOwnerMap, ownerOfItem, resetOwnerMapForTests } from "./owner-map";

const tile: ItemKey = { kind: "tile", team: "acme", id: "shell-1" };

function emit(name: string, payload: unknown) {
  const cb = h.handlers.get(name);
  if (!cb) throw new Error(`no handler registered for ${name}`);
  cb({ payload });
}

function needsYou(sessionId: string) {
  return selectNeedsYouKind(
    { ...useViewerStore.getState(), agentDots: {}, pendingAsks: {} },
    sessionId,
  );
}

beforeEach(() => {
  h.main = true;
  h.handlers.clear();
  useViewerStore.setState({ aiStatusBySession: {}, progressBySession: {} });
  applyOwnerMap({ [canonicalItemKey(tile)]: "pane-2" });
});

afterEach(() => {
  resetOwnerMapForTests();
});

describe("terminal signals with the tile in a satellite", () => {
  it("a needs-you status still sets attention and the badge in main", async () => {
    expect(ownerOfItem(tile)).toBe("pane-2");
    renderHook(() => useTerminalStatusEvents());
    await vi.waitFor(() => expect(h.handlers.has("terminal-status-update")).toBe(true));
    emit("terminal-status-update", { tab_session_id: "shell-1", status: "needs-permission" });
    expect(useViewerStore.getState().aiStatusBySession["shell-1"]).toBe("needs-permission");
    expect(needsYou("shell-1")).toBe("permission");
  });
});

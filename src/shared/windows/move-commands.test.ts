// SPDX-License-Identifier: MIT
/**
 * The shared move commands (`move-commands.ts`): the one `tiles` flag check, the two moves
 * through `window_move_item`, the abort toast, and a refusal shown on the entry, in the
 * palette and as the toast, with no `window_move_item` call after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tiles: true,
  main: true,
  aborted: null as ((event: { payload: unknown }) => void) | null,
  listen: vi.fn(),
}));

vi.mock("@/tauri/commands", () => ({
  getTilesEnabled: vi.fn(async () => h.tiles),
  windowMoveItem: vi.fn(),
  windowFocusOwner: vi.fn(),
}));
vi.mock("@/shared/lib/current-window", () => ({
  isMainWindow: () => h.main,
  currentWebviewWindow: () => ({ listen: h.listen }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import { resetTilesEnabledForTests } from "@/shared/lib/tiles-enabled";
import { windowFocusOwner, windowMoveItem } from "@/tauri/commands";

import type { ItemKey } from "./item-key";
import {
  MOVE_INTO_MAIN_WINDOW,
  MOVE_TO_NEW_WINDOW,
  moveEntries,
  moveItemToMain,
  moveItemToNewWindow,
  resetMoveCommandsForTests,
  type CanMoveResult,
} from "./move-commands";
import { MOVE_ABORTED_EVENT } from "./window-slice";

const tab: ItemKey = { kind: "tab", team: "acme", id: "docs/mockups.html" };
const moveItem = vi.mocked(windowMoveItem);
const toastError = vi.mocked(toast.error);

const OTHER_MACHINE =
  "Terminals on other Machines can’t move to another window yet. devbox has terminals here.";
const OLD_SERVER = "Update the terminal server to move terminals between windows";

/** A `window_can_move_bodies` answer for each of `keys`, refusing the ones in `refused`. */
function canMove(keys: ItemKey[], refused: Map<ItemKey, CanMoveResult>): CanMoveResult[] {
  return keys.map((key) => refused.get(key) ?? { key, ok: true });
}

beforeEach(() => {
  h.tiles = true;
  h.main = true;
  h.aborted = null;
  h.listen.mockImplementation(async (event: string, handler: typeof h.aborted) => {
    if (event === MOVE_ABORTED_EVENT) h.aborted = handler;
    return () => {};
  });
  moveItem.mockResolvedValue({ status: "started", moveId: "m1", target: "pane-1" });
  resetTilesEnabledForTests();
  resetMoveCommandsForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the tiles flag", () => {
  it("with the flag off, offers no new-window entry and a direct call makes no move", async () => {
    h.tiles = false;
    expect(await moveEntries(tab)).toEqual([]);
    expect(await moveItemToNewWindow(tab)).toBeNull();
    expect(moveItem).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("with the flag on, offers Move to New Window in main", async () => {
    const entries = await moveEntries(tab);
    expect(entries.map((e) => e.label)).toEqual([MOVE_TO_NEW_WINDOW]);
    expect(entries[0].disabledReason).toBeUndefined();
  });

  it("in a satellite, offers Move into Main Window beside it", async () => {
    h.main = false;
    const entries = await moveEntries(tab);
    expect(entries.map((e) => e.label)).toEqual([MOVE_TO_NEW_WINDOW, MOVE_INTO_MAIN_WINDOW]);
  });

  it("reads the flag once", async () => {
    await moveEntries(tab);
    await moveItemToNewWindow(tab);
    const { getTilesEnabled } = await import("@/tauri/commands");
    expect(vi.mocked(getTilesEnabled)).toHaveBeenCalledTimes(1);
  });
});

describe("the moves", () => {
  it("moveItemToNewWindow calls window_move_item with to new and no from", async () => {
    expect(await moveItemToNewWindow(tab)).toEqual({
      status: "started",
      moveId: "m1",
      target: "pane-1",
    });
    expect(moveItem).toHaveBeenCalledExactlyOnceWith(tab, "new");
  });

  it("moveItemToMain calls window_move_item with to main", async () => {
    h.main = false;
    await moveItemToMain(tab);
    expect(moveItem).toHaveBeenCalledExactlyOnceWith(tab, "main");
  });

  it("an entry runs its move", async () => {
    h.main = false;
    const [toNew, toMain] = await moveEntries(tab);
    await toNew.run();
    await toMain.run();
    expect(moveItem.mock.calls).toEqual([
      [tab, "new"],
      [tab, "main"],
    ]);
  });

  it("listens for aborts before the move starts", async () => {
    let listening = false;
    h.listen.mockImplementation(async (_event: string, handler: typeof h.aborted) => {
      h.aborted = handler;
      listening = true;
      return () => {};
    });
    moveItem.mockImplementation(async () => {
      expect(listening).toBe(true);
      return { status: "started", moveId: "m1", target: "pane-1" };
    });
    await moveItemToNewWindow(tab);
    await moveItemToNewWindow(tab);
    expect(h.listen).toHaveBeenCalledOnce();
  });

  it("a commit leaves raising and focusing the target to the registry", async () => {
    // The registry focuses the target once the move commits (`moves.rs`); a second focus
    // from here could take focus back from a window the person moved to since.
    expect(await moveItemToNewWindow(tab)).toMatchObject({ target: "pane-1" });
    expect(windowFocusOwner).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("aborts", () => {
  it("an injected create failure aborts with the toast and leaves the source unchanged", async () => {
    await moveItemToNewWindow(tab);
    h.aborted?.({ payload: { key: tab, moveId: "m1", reason: "window_failed" } });
    expect(toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t move mockups.html: the new window didn’t open",
    );
    // The source keeps its item through `hand-off.ts`; the commands start nothing more.
    expect(moveItem).toHaveBeenCalledOnce();
  });

  it.each([
    ["dirty", "mockups.html has an unsaved edit; finish or discard it first"],
    ["no_ack", "Couldn’t move mockups.html: the other window didn’t answer"],
    ["timeout", "Couldn’t move mockups.html: the new window didn’t open"],
    ["gone", "Couldn’t move mockups.html: the other window closed"],
    ["quit", "Couldn’t move mockups.html"],
  ])("an abort for %s shows its reason", async (reason, text) => {
    await moveItemToNewWindow(tab);
    h.aborted?.({ payload: { key: tab, moveId: "m1", reason } });
    expect(toastError).toHaveBeenCalledExactlyOnceWith(text);
  });
});

describe("refusals", () => {
  const shell: ItemKey = { kind: "tile", team: "acme", id: "shell-1" };
  const agent: ItemKey = { kind: "tile", team: "acme", id: "agent-1" };
  const group: ItemKey = { kind: "group", team: "acme", id: "release-prep" };

  it("a refused tile's entry is disabled with the reason", async () => {
    const check = canMove(
      [shell],
      new Map([[shell, { key: shell, ok: false, reason: "old_server", text: OLD_SERVER }]]),
    );
    const [entry] = await moveEntries(shell, { check });
    expect(entry.disabledReason).toBe(OLD_SERVER);
  });

  it("a group is refused when one of its tiles is, with that tile's text", async () => {
    const check = canMove(
      [shell, agent],
      new Map([[agent, { key: agent, ok: false, reason: "other_machine", text: OTHER_MACHINE }]]),
    );
    const [entry] = await moveEntries(group, { check });
    expect(entry.disabledReason).toBe(OTHER_MACHINE);
  });

  it("a group whose tiles all pass is offered", async () => {
    const [entry] = await moveEntries(group, { check: canMove([shell, agent], new Map()) });
    expect(entry.disabledReason).toBeUndefined();
  });

  it("a refusal for a move reason shows that reason's text", async () => {
    const check = [{ key: shell, ok: false, reason: "moving" }];
    const [entry] = await moveEntries(shell, { check });
    expect(entry.disabledReason).toBe("shell-1 is already moving");
  });

  it("a refused entry run from the palette shows the toast and makes no move", async () => {
    const check = [{ key: shell, ok: false, reason: "other_machine", text: OTHER_MACHINE }];
    const [entry] = await moveEntries(shell, { check });
    await entry.run();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(OTHER_MACHINE);
    expect(moveItem).not.toHaveBeenCalled();
  });

  it("a direct call with a refused check makes no move", async () => {
    const check = [{ key: shell, ok: false, reason: "old_server", text: OLD_SERVER }];
    expect(await moveItemToNewWindow(shell, { check })).toBeNull();
    expect(moveItem).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(OLD_SERVER);
  });

  it("a refusal at move time shows as the toast", async () => {
    moveItem.mockResolvedValue({ status: "refused", reason: "moving" });
    expect(await moveItemToNewWindow(tab)).toEqual({ status: "refused", reason: "moving" });
    expect(toastError).toHaveBeenCalledExactlyOnceWith("mockups.html is already moving");
  });

  it("a move to the window it is in already shows nothing", async () => {
    moveItem.mockResolvedValue({ status: "refused", reason: "self" });
    await moveItemToMain(tab);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a failed call shows the generic toast", async () => {
    moveItem.mockRejectedValue(new Error("ipc down"));
    expect(await moveItemToNewWindow(tab)).toBeNull();
    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn’t move mockups.html");
  });
});

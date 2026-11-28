// SPDX-License-Identifier: MIT
/**
 * The source's side of a move (`hand-off.ts`): `main` flushes a tab's frames, closes it
 * through `closeTab` and acks; a satellite flushes, hands its renderer `handed-off` and
 * acks. A dirty item is never let go, an abort during the flush stops the close, and an
 * abort after it takes the item back where it was. The renderer rows run the real
 * `satellite-root.tsx` with its boot rows stubbed.
 */
import "@/test/prefs-state-fixture";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@/tauri/commands", () => ({
  saveAppState: vi.fn().mockResolvedValue(undefined),
  loadAppState: vi.fn().mockResolvedValue("{}"),
  pushViewerState: vi.fn().mockResolvedValue(undefined),
  checkPathExists: vi.fn().mockResolvedValue(true),
  windowGetSlice: vi.fn().mockRejectedValue(new Error("no registry")),
  windowFocusOwner: vi.fn().mockResolvedValue(null),
  windowHandOffAck: vi.fn(),
}));

const closeCurrentWindow = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/current-window", () => ({ closeCurrentWindow }));
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/logger", () => ({
  logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// The real root, without the satellite's boot rows.
vi.mock("./boot-inventory", () => ({
  BOOT_EXPORTS: {},
  BootRows: () => null,
  SATELLITE_ROWS: [],
}));

// The tab body: one iframe, as a dashboard tab mounts.
vi.mock("@/shared/lib/render-viewer", async () => {
  const { createElement: h } = await import("react");
  return {
    renderViewer: (common: { filePath: string }) =>
      h("iframe", { "data-testid": `viewer ${common.filePath}` }),
  };
});

import {
  acknowledgeFlush,
  registerFrame,
  type LiveFrame,
} from "@/features/dashboard/lib/frame-lifecycle";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";

import { createHandOff, createReleasedItems, mainTabSide } from "./hand-off";
import { resetWaitingItemsForTests } from "./items-returned";
import { markRefusalShown, takeRefusalShown } from "./shown-refusals";
import { itemKeyForTab, type ItemKey } from "./item-key";
import {
  SatelliteRoot,
  defaultSatelliteRenderer,
  satelliteContent,
  satelliteRenderer,
  type SatelliteContent,
} from "./satellite-root";
import type { SliceSource, SliceView } from "./slice";
import type { AbortReason, AckOutcome, HandOffAck, MoveRefusal, MoveStart } from "./window-slice";

const TEAM = "acme:general";
const A = "/acme/a.md";
const K = "/acme/k.html";
const B = "/acme/b.md";
const STORY = "/acme/notes/s-1.md";
const K_KEY = itemKeyForTab(TEAM, { path: K });

const tab = (path: string) => ({ path, name: path.slice(path.lastIndexOf("/") + 1) });
const paths = () => (useViewerStore.getState().openTabs[TEAM] ?? []).map((t) => t.path);
const active = () => useViewerStore.getState().activeTab[TEAM];
const open = (path = K) => paths().includes(path);

const cleanups: (() => void)[] = [];
let log: string[] = [];

/** A live frame mounted inside the `[data-viewer-path]` element of `path`. `onFlush`
 *  runs when the frame is asked to flush; by default it answers at once. */
function frameIn(
  path: string,
  opts: { team?: string; documentPath?: string; onFlush?: (id: unknown) => void } = {},
): LiveFrame & { post: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  host.setAttribute("data-viewer-path", path);
  const element = document.createElement("iframe");
  host.append(element);
  document.body.append(host);
  const frame = {
    frameId: `frame ${path}`,
    dashboard: path,
    documentPath: opts.documentPath ?? path,
    slotId: "centre",
    teamKey: opts.team ?? TEAM,
    element,
    hide: vi.fn(),
    post: vi.fn((message: Record<string, unknown>) => {
      if (message.type !== "codesense:flush") return;
      log.push(`flush ${path}${open(path) ? " (open)" : ""}`);
      (opts.onFlush ?? ((id) => acknowledgeFlush(frame.frameId, id)))(message.id);
    }),
  };
  cleanups.push(registerFrame(frame), () => host.remove());
  return frame;
}

function acker(outcome: AckOutcome = "committed") {
  return vi.fn(async (reply: HandOffAck) => {
    log.push(`ack ${reply.ok ? "ok" : reply.reason}${open() ? " (open)" : ""}`);
    return outcome;
  });
}

const request = (key: ItemKey, moveId = "mv-1") => ({ key, moveId, budgetMs: 200 });

beforeEach(() => {
  log = [];
  resetWaitingItemsForTests();
  useOrgStore.setState({
    orgs: [
      {
        slug: "acme",
        display_name: "Acme",
        created_at: new Date(0).toISOString(),
        remote_url: null,
        config_flags: {},
        people: [],
        teams: [{ name: "general", source_repos: [] }],
        org_root: "/acme",
      },
    ],
    discoveryComplete: true,
  });
  useViewerStore.setState({
    openTabs: { [TEAM]: [tab(A), tab(K), tab(B)] },
    activeTab: { [TEAM]: K },
    editingDirtyPaths: {},
  });
});

afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((off) => off());
  vi.restoreAllMocks();
});

describe("main as the source", () => {
  it("flushes the tab's frame, then closes it through closeTab, then acks", async () => {
    frameIn(K);
    const closeTab = vi.spyOn(useViewerStore.getState(), "closeTab");
    const ack = acker();
    await createHandOff(mainTabSide(), ack).onHandOff(request(K_KEY));
    expect(log).toEqual([`flush ${K} (open)`, "ack ok"]);
    expect(closeTab).toHaveBeenCalledWith(TEAM, "team:acme:general", K);
    expect(ack).toHaveBeenCalledWith({ moveId: "mv-1", ok: true });
    expect(paths()).toEqual([A, B]);
  });

  it("flushes a story md's story page frame", async () => {
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(STORY)] }, activeTab: { [TEAM]: STORY } });
    const page = frameIn(STORY, { documentPath: "/acme/notes/pipeline.html" });
    const other = frameIn(A);
    await createHandOff(mainTabSide(), acker()).onHandOff(
      request(itemKeyForTab(TEAM, { path: STORY })),
    );
    expect(page.post).toHaveBeenCalledWith(expect.objectContaining({ type: "codesense:flush" }));
    expect(other.post).not.toHaveBeenCalled();
  });

  it("never flushes another team's frame for the same path", async () => {
    const other = frameIn(K, { team: "acme:other" });
    await createHandOff(mainTabSide(), acker()).onHandOff(request(K_KEY));
    expect(other.post).not.toHaveBeenCalled();
  });

  it("does not close a dirty tab, and the ack says dirty", async () => {
    useViewerStore.setState({ editingDirtyPaths: { [TEAM]: [K] } });
    const frame = frameIn(K);
    const ack = acker();
    await createHandOff(mainTabSide(), ack).onHandOff(request(K_KEY));
    expect(ack).toHaveBeenCalledWith({ moveId: "mv-1", ok: false, reason: "dirty" });
    expect(frame.post).not.toHaveBeenCalled();
    expect(paths()).toEqual([A, K, B]);
    // No toast was shown here, so the abort shows one.
    expect(takeRefusalShown(K_KEY)).toBe(false);
  });

  it("clears an earlier move's shown refusal when a new hand-off arrives", async () => {
    markRefusalShown(K_KEY);
    useViewerStore.setState({ editingDirtyPaths: { [TEAM]: [K] } });
    await createHandOff(mainTabSide(), acker()).onHandOff(request(K_KEY));
    expect(takeRefusalShown(K_KEY)).toBe(false);
  });

  it("acks dirty when an edit starts during the flush and closeTab refuses", async () => {
    const frame = frameIn(K, {
      onFlush: (id) => {
        useViewerStore.setState({ editingDirtyPaths: { [TEAM]: [K] } });
        acknowledgeFlush(frame.frameId, id);
      },
    });
    const ack = acker();
    await createHandOff(mainTabSide(), ack).onHandOff(request(K_KEY));
    expect(ack).toHaveBeenCalledWith({ moveId: "mv-1", ok: false, reason: "dirty" });
    expect(log).toEqual([`flush ${K} (open)`, "ack dirty (open)"]);
    expect(paths()).toEqual([A, K, B]);
    // closeTab showed its toast, so the abort shows none.
    expect(takeRefusalShown(K_KEY)).toBe(true);
  });

  it("never closes the tab when the move aborts during the flush", async () => {
    const ack = acker();
    const handOff = createHandOff(mainTabSide(), ack);
    const frame = frameIn(K, {
      onFlush: (id) => {
        handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" });
        acknowledgeFlush(frame.frameId, id);
      },
    });
    await handOff.onHandOff(request(K_KEY));
    expect(ack).not.toHaveBeenCalled();
    expect(paths()).toEqual([A, K, B]);
    expect(active()).toBe(K);
  });

  it("reopens the tab at its old position, active, on an abort after the close", async () => {
    frameIn(K);
    const handOff = createHandOff(mainTabSide(), acker("ignored"));
    await handOff.onHandOff(request(K_KEY));
    expect(paths()).toEqual([A, B]);
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" }));
    expect(paths()).toEqual([A, K, B]);
    expect(active()).toBe(K);
  });

  it("reopens an inactive tab at its old position and keeps the active tab", async () => {
    useViewerStore.setState({ activeTab: { [TEAM]: B } });
    const handOff = createHandOff(mainTabSide(), acker("ignored"));
    await handOff.onHandOff(request(K_KEY));
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "timeout" }));
    expect(paths()).toEqual([A, K, B]);
    expect(active()).toBe(B);
  });

  const READY_ORGS = () => useOrgStore.getState().orgs;

  it("reopens the tab through the repo recorded at hand-off when its team stops being ready", async () => {
    const handOff = createHandOff(mainTabSide(), acker("ignored"));
    await handOff.onHandOff(request(K_KEY));
    useOrgStore.setState({ orgs: [], discoveryComplete: false });
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" }));
    expect(paths()).toEqual([A, K, B]);
  });

  it("queues the reopen of a tab whose team was never ready, then opens it", async () => {
    const orgs = READY_ORGS();
    useOrgStore.setState({ orgs: [], discoveryComplete: false });
    const handOff = createHandOff(mainTabSide(), acker("ignored"));
    await handOff.onHandOff(request(K_KEY));
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" }));
    expect(open()).toBe(false);
    act(() => useOrgStore.setState({ orgs, discoveryComplete: true }));
    expect(open()).toBe(true);
  });

  it("reopens nothing on an abort when the tab was not open at hand-off", async () => {
    useViewerStore.setState({ openTabs: { [TEAM]: [tab(A), tab(B)] }, activeTab: { [TEAM]: A } });
    const handOff = createHandOff(mainTabSide(), acker("ignored"));
    await handOff.onHandOff(request(K_KEY));
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" }));
    expect(paths()).toEqual([A, B]);
  });

  it("keeps the preview flag when it reopens a preview tab", async () => {
    useViewerStore.setState({
      openTabs: { [TEAM]: [tab(A), { ...tab(K), preview: true }, tab(B)] },
    });
    const handOff = createHandOff(mainTabSide(), acker("ignored"));
    await handOff.onHandOff(request(K_KEY));
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" }));
    expect(paths()).toEqual([A, K, B]);
    expect(useViewerStore.getState().openTabs[TEAM]?.find((t) => t.path === K)?.preview).toBe(true);
  });

  it("ignores an abort for a move it is not the source of, or after the commit", async () => {
    const handOff = createHandOff(mainTabSide(), acker("committed"));
    await handOff.onHandOff(request(K_KEY));
    handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "gone" });
    handOff.onAborted({ key: K_KEY, moveId: "mv-9", reason: "gone" });
    expect(paths()).toEqual([A, B]);
  });
});

/** A slice source a test drives. */
function stubSource(initial: SliceView | null) {
  let slice = initial;
  const listeners = new Set<() => void>();
  const source: SliceSource = {
    current: () => slice,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    source,
    set(next: SliceView | null) {
      slice = next;
      for (const listener of listeners) listener();
    },
  };
}

const view = (extra: Partial<SliceView> = {}): SliceView => ({
  label: "pane-x",
  layoutRef: null,
  items: [K_KEY],
  number: 2,
  ...extra,
});

describe("a satellite as the source", () => {
  function satellite() {
    const released = createReleasedItems();
    const stub = stubSource(view());
    const seen: SatelliteContent[] = [];
    const draw = satelliteRenderer({ closeWindow: vi.fn() });
    const renderer = (content: SatelliteContent) => {
      seen.push(content);
      return draw(content);
    };
    render(createElement(SatelliteRoot, { source: stub.source, renderer, released }));
    const element = screen.getByTestId(`viewer ${K}`) as HTMLIFrameElement;
    const post = vi.fn((message: Record<string, unknown>) => {
      log.push(String(message.type));
      if (message.type === "codesense:flush") acknowledgeFlush(frame.frameId, message.id);
    });
    const frame: LiveFrame = {
      frameId: "satellite frame",
      dashboard: K,
      slotId: "centre",
      teamKey: TEAM,
      element,
      hide: vi.fn(() => log.push("hide")),
      post,
    };
    cleanups.push(registerFrame(frame));
    return { released, stub, seen, frame, post };
  }

  it("flushes, hands the renderer handed-off so the frame retires, then acks", async () => {
    // A satellite's store holds no tab: the item renders from its slice.
    useViewerStore.setState({ openTabs: {}, activeTab: {} });
    const { released, seen } = satellite();
    const ack = vi.fn(async (reply: HandOffAck) => {
      log.push(`ack ${reply.ok ? "ok" : reply.reason}`);
      return "committed" as const;
    });
    await act(() => createHandOff(released.side, ack).onHandOff(request(K_KEY)));
    expect(seen.at(-1)).toEqual({ state: "handed-off" });
    expect(log.slice(0, 2)).toEqual(["codesense:flush", "ack ok"]);
    await act(async () => {});
    expect(log).toContain("hide");
    expect(log.at(-1)).toBe("codesense:teardown");
    expect(screen.queryByTestId(`viewer ${K}`)).toBeNull();
  });

  it("refuses a dirty item: no flush, the item stays", async () => {
    useViewerStore.setState({ openTabs: {}, activeTab: {}, editingDirtyPaths: { [TEAM]: [K] } });
    const { released, seen, post } = satellite();
    const ack = acker();
    await act(() => createHandOff(released.side, ack).onHandOff(request(K_KEY)));
    expect(ack).toHaveBeenCalledWith({ moveId: "mv-1", ok: false, reason: "dirty" });
    expect(post).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ item: K_KEY });
  });

  it("renders the item again on an abort after it let go", async () => {
    useViewerStore.setState({ openTabs: {}, activeTab: {} });
    const { released, seen } = satellite();
    const handOff = createHandOff(released.side, acker("ignored"));
    await act(() => handOff.onHandOff(request(K_KEY)));
    expect(seen.at(-1)).toEqual({ state: "handed-off" });
    act(() => handOff.onAborted({ key: K_KEY, moveId: "mv-1", reason: "no_ack" }));
    expect(seen.at(-1)).toEqual({ item: K_KEY });
  });

  it("is empty once the committed slice no longer holds the item", async () => {
    useViewerStore.setState({ openTabs: {}, activeTab: {} });
    const { released, stub, seen } = satellite();
    await act(() => createHandOff(released.side, acker()).onHandOff(request(K_KEY)));
    act(() => {
      released.keepOnly([]);
      stub.set(view({ items: [] }));
    });
    expect(seen.at(-1)).toEqual({ state: "empty", windowNumber: 2 });
    expect(released.has(K_KEY)).toBe(false);
  });
});

describe("the move states a satellite's renderer gets", () => {
  const pending = view({
    items: [],
    pending: true,
    incoming: { key: K_KEY, fromNumber: 1 },
  });

  it("hands a pending target its caption and no item, so no frame mounts", () => {
    const renderer = vi.fn((_content: SatelliteContent) => null);
    render(createElement(SatelliteRoot, { source: stubSource(pending).source, renderer }));
    expect(renderer.mock.calls.map(([content]) => content)).toEqual([
      { state: "pending", caption: { name: "k.html", sourceWindowN: 1 } },
    ]);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("draws the pending caption, with no frame until the commit", () => {
    const stub = stubSource(pending);
    const renderer = satelliteRenderer({ closeWindow: vi.fn() });
    render(createElement(SatelliteRoot, { source: stub.source, renderer }));
    expect(screen.getByRole("status").textContent).toBe(
      "Moving k.html… It opens here when window 1 lets go.",
    );
    expect(document.querySelector("iframe")).toBeNull();
    act(() => stub.set(view()));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId(`viewer ${K}`)).toBeTruthy();
  });

  it("draws the empty placeholder with Close window alone without a focus-main action", () => {
    const closeWindow = vi.fn();
    const renderer = satelliteRenderer({ closeWindow });
    render(
      createElement(SatelliteRoot, { source: stubSource(view({ items: [] })).source, renderer }),
    );
    expect(screen.getByText("Nothing in this window")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to main window" })).toBeNull();
    screen.getByRole("button", { name: "Close window" }).click();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it("closes the window through the current window, and logs a close that fails", async () => {
    closeCurrentWindow.mockRejectedValueOnce(new Error("close not allowed"));
    render(
      createElement(SatelliteRoot, {
        source: stubSource(view({ items: [] })).source,
        renderer: defaultSatelliteRenderer,
      }),
    );
    screen.getByRole("button", { name: "Close window" }).click();
    expect(closeCurrentWindow).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("windows", expect.stringContaining("close not allowed")),
    );
  });

  it("draws Go to main window when a focus-main action is passed", () => {
    const focusMain = vi.fn();
    const renderer = satelliteRenderer({ closeWindow: vi.fn(), focusMain });
    render(
      createElement(SatelliteRoot, { source: stubSource(view({ items: [] })).source, renderer }),
    );
    screen.getByRole("button", { name: "Go to main window" }).click();
    expect(focusMain).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
  });

  it("maps each slice to one content", () => {
    const released = createReleasedItems();
    expect(satelliteContent(null, released)).toBeNull();
    expect(satelliteContent(view({ items: [], pending: true }), released)).toBeNull();
    expect(satelliteContent(view({ layoutRef: "group-1" }), released)).toEqual({
      layoutRef: "group-1",
    });
    expect(satelliteContent(view(), released)).toEqual({ item: K_KEY });
    released.side.letGo(K_KEY);
    expect(satelliteContent(view(), released)).toEqual({ state: "handed-off" });
  });
});

describe("the move reason codes", () => {
  // `Extract` keeps only the named literals, so the open tail cannot hide a missing code.
  it("name occupied among the refusals, beside an open tail for a kind check's own", () => {
    const refused: MoveStart = { status: "refused", reason: "occupied" };
    expect(refused).toEqual({ status: "refused", reason: "occupied" });
    expectTypeOf<Extract<MoveRefusal, "occupied" | "stale">>().toEqualTypeOf<
      "occupied" | "stale"
    >();
    expectTypeOf<"tab_refused">().toExtend<MoveRefusal>();
  });

  it("name the four abort reasons, beside an open tail for abort_all_moves' own", () => {
    expectTypeOf<Extract<AbortReason, "dirty" | "gone" | "timeout" | "no_ack">>().toEqualTypeOf<
      "dirty" | "gone" | "timeout" | "no_ack"
    >();
    expectTypeOf<"quit">().toExtend<AbortReason>();
  });
});

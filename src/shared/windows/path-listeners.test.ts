// SPDX-License-Identifier: MIT
import { render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ main: false }));
const bus = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());

vi.mock("@/shared/lib/current-window", async (importActual) => ({
  ...(await importActual<typeof import("@/shared/lib/current-window")>()),
  isMainWindow: () => host.main,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = bus.get(event) ?? new Set();
    handlers.add(handler);
    bus.set(event, handlers);
    return () => handlers.delete(handler);
  }),
}));

// The satellite's real root and viewer, with its boot rows stubbed, a counted read and a
// plain editor.
vi.mock("./boot-inventory", () => ({ BOOT_EXPORTS: {}, BootRows: () => null, SATELLITE_ROWS: [] }));

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/tauri/commands", async (importActual) => ({
  ...(await importActual<typeof import("@/tauri/commands")>()),
  readFile: vi.fn(async () => `read ${++reads.count}`),
}));

vi.mock("@/shared/components/code-editor", async (importActual) => {
  const { createElement: h } = await import("react");
  return {
    ...(await importActual<typeof import("@/shared/components/code-editor")>()),
    CodeEditor: ({ value }: { value: string }) => h("pre", null, value),
  };
});

import { fileContentCache } from "@/shared/lib/file-content-cache";
import { useFileRefreshStore } from "@/shared/stores/file-refresh-store";
import { useOrgStore } from "@/shared/stores/org-store";
import type { Org } from "@/shared/types/domain";
import { CONTEXT_FILE_CHANGE_EVENT, type ContextFileChangePayload } from "@/tauri/events";

import type { ItemKey } from "./item-key";
import { ownsPathEvent, refreshItem, useSatellitePathRefresh } from "./path-listeners";
import { SatelliteRoot } from "./satellite-root";
import { installSliceSource, type SliceSource } from "./slice";

const tab = (id: string): ItemKey => ({ kind: "tab", team: "acme:docs", id });

let uninstall = () => {};

function holding(...items: ItemKey[]) {
  uninstall();
  uninstall = installSliceSource({
    current: () => ({ label: "sat-1", kind: "satellite", version: 1, layoutRef: null, items }),
    subscribe: () => () => {},
  });
}

const change = (file_path?: string, repo_path = "/repo"): ContextFileChangePayload => ({
  repo_path,
  file_path,
});

function deliver(payload: ContextFileChangePayload) {
  for (const handler of bus.get(CONTEXT_FILE_CHANGE_EVENT) ?? []) handler({ payload });
}

const refreshes = () => useFileRefreshStore.getState().contentRefreshKeys["/repo"] ?? 0;

beforeEach(() => {
  host.main = false;
  bus.clear();
  useFileRefreshStore.setState({
    fileRefreshKeys: {},
    lastChangedContextFile: {},
    contentRefreshKeys: {},
  });
});

afterEach(() => {
  uninstall();
  uninstall = () => {};
});

describe("ownsPathEvent", () => {
  it("owns a change to a held tab's path, or to a directory or root that holds it", () => {
    holding(tab("/repo/notes/a.md"));
    for (const path of ["/repo/notes/a.md", "/repo/notes", "/repo", "/repo/notes/"]) {
      expect(ownsPathEvent(change(path)), path).toBe(true);
    }
  });

  it("does not own a sibling, a prefix that is not a directory, or another file", () => {
    holding(tab("/repo/notes/a.md"));
    for (const path of ["/repo/notes/b.md", "/repo/note", "/repo/notes/a.md.bak", "/other"]) {
      expect(ownsPathEvent(change(path)), path).toBe(false);
    }
  });

  it("matches a query tab on its path alone", () => {
    holding(tab("/repo/notes/a.md?x=1"));
    expect(ownsPathEvent(change("/repo/notes/a.md"))).toBe(true);
  });

  it("owns nothing with no path, no slice, or no tab item", () => {
    holding(tab("/repo/notes/a.md"));
    expect(ownsPathEvent(change(undefined))).toBe(false);
    holding({ kind: "workspace", team: "acme:docs", id: "/repo/notes/a.md" });
    expect(ownsPathEvent(change("/repo/notes/a.md"))).toBe(false);
    uninstall();
    expect(ownsPathEvent(change("/repo/notes/a.md"))).toBe(false);
  });
});

describe("refreshItem", () => {
  it("bumps the change's repo with the changed path", () => {
    refreshItem({ event: CONTEXT_FILE_CHANGE_EVENT, id: 1, payload: change("/repo/notes/a.md") });
    const state = useFileRefreshStore.getState();
    expect(state.contentRefreshKeys["/repo"]).toBe(1);
    expect(state.lastChangedContextFile["/repo"]).toEqual(new Set(["/repo/notes/a.md"]));
  });

  it("bumps nothing when the change resolves to no key", () => {
    refreshItem({ event: CONTEXT_FILE_CHANGE_EVENT, id: 1, payload: change(undefined, "") });
    expect(useFileRefreshStore.getState().contentRefreshKeys).toEqual({});
  });
});

describe("useSatellitePathRefresh in a satellite", () => {
  it("refreshes on a change to the held tab, and not on another file's", async () => {
    holding(tab("/repo/notes/a.md"));
    const { unmount } = renderHook(() => useSatellitePathRefresh());
    await vi.waitFor(() => expect(bus.get(CONTEXT_FILE_CHANGE_EVENT)?.size).toBe(1));

    deliver(change("/repo/notes/b.md"));
    expect(refreshes()).toBe(0);
    deliver(change("/repo/notes/a.md"));
    expect(refreshes()).toBe(1);
    deliver(change("/repo"));
    expect(refreshes()).toBe(2);

    unmount();
    await vi.waitFor(() => expect(bus.get(CONTEXT_FILE_CHANGE_EVENT)?.size).toBe(0));
  });

  it("drops a registration that resolves after unmount", async () => {
    const { unmount } = renderHook(() => useSatellitePathRefresh());
    unmount();
    await vi.waitFor(() => expect(bus.get(CONTEXT_FILE_CHANGE_EVENT)?.size ?? 0).toBe(0));
    holding(tab("/repo/notes/a.md"));
    deliver(change("/repo/notes/a.md"));
    expect(refreshes()).toBe(0);
  });
});

describe("a satellite's viewer", () => {
  const FILE = "/orgs/acme/docs/content/a.ts";

  it("re-reads its held file when that file changes, on the key main's viewer reads", async () => {
    useOrgStore.setState({
      orgs: [
        {
          slug: "acme",
          display_name: "Acme",
          org_root: "/orgs/acme",
          teams: [{ name: "docs", source_repos: [] }],
        } as unknown as Org,
      ],
      discoveryComplete: true,
    });
    fileContentCache.clear();
    reads.count = 0;
    const slice = {
      label: "sat-1",
      kind: "satellite",
      version: 1,
      layoutRef: null,
      items: [tab(FILE)],
    };
    const source: SliceSource = { current: () => slice, subscribe: () => () => {} };
    const { unmount } = render(createElement(SatelliteRoot, { source }));
    await screen.findByText("read 1");
    await vi.waitFor(() => expect(bus.get(CONTEXT_FILE_CHANGE_EVENT)?.size).toBe(1));

    deliver(change("/orgs/acme/docs/content/b.ts", ""));
    deliver(change(FILE, ""));
    await screen.findByText("read 2");
    expect(reads.count).toBe(2);
    expect(useFileRefreshStore.getState().contentRefreshKeys["team:acme:docs"]).toBe(1);
    unmount();
  });
});

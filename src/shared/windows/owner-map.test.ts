// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalItemKey, itemKeyForTab } from "./item-key";
import {
  applyOwnerMap,
  mainSlice as main,
  onOwnerMapChange,
  ownerMapSize,
  ownerOfItem,
  pullMainSlice,
  resetOwnerMapForTests,
  satelliteOwnedTabs,
} from "./owner-map";
import type { WindowSlice } from "./window-slice";

const K = itemKeyForTab("acme:docs", { path: "a.md" });

function mainSlice(version: number, owners: Record<string, string>): WindowSlice {
  return {
    label: "main",
    kind: "main",
    version,
    layoutRef: null,
    items: [],
    pending: false,
    owners,
  };
}

afterEach(() => resetOwnerMapForTests());

describe("owner-map", () => {
  it("starts empty: main owns every key", () => {
    expect(ownerMapSize()).toBe(0);
    expect(ownerOfItem(K)).toBe("main");
    expect(satelliteOwnedTabs().size).toBe(0);
  });

  it("indexes tab keys by bucket and answers the owner synchronously", () => {
    applyOwnerMap({
      [canonicalItemKey(K)]: "sat-1",
      [canonicalItemKey({ kind: "other", team: "acme:docs", id: "b" })]: "sat-2",
    });
    expect(ownerMapSize()).toBe(2);
    expect(ownerOfItem(K)).toBe("sat-1");
    expect(ownerOfItem({ kind: "other", team: "acme:docs", id: "b" })).toBe("sat-2");
    expect(ownerOfItem(itemKeyForTab("acme:other", { path: "a.md" }))).toBe("main");
    expect([...(satelliteOwnedTabs().get("acme:docs") ?? [])]).toEqual(["a.md"]);
    expect(satelliteOwnedTabs().has("acme:other")).toBe(false);
  });

  it("tells listeners after every update", () => {
    const listener = vi.fn(() => expect(ownerMapSize()).toBe(1));
    const off = onOwnerMapChange(listener);
    applyOwnerMap({ [canonicalItemKey(K)]: "sat-1" });
    off();
    applyOwnerMap({});
    expect(listener).toHaveBeenCalledOnce();
  });

  it("skips a malformed key", () => {
    applyOwnerMap({ "not-a-key": "sat-1" });
    expect(ownerMapSize()).toBe(0);
  });

  it("takes a newer slice of main's and ignores an older one", () => {
    expect(main.offer(mainSlice(2, { [canonicalItemKey(K)]: "sat-1" }))).toBe(true);
    expect(main.offer(mainSlice(1, {}))).toBe(false);
    expect(ownerOfItem(K)).toBe("sat-1");
  });

  it("pulls main's slice, and keeps the map when the pull fails", async () => {
    const getSlice = vi.fn(async () => mainSlice(3, { [canonicalItemKey(K)]: "sat-1" }));
    await pullMainSlice(getSlice);
    expect(getSlice).toHaveBeenCalledWith("main");
    expect(ownerOfItem(K)).toBe("sat-1");
    await pullMainSlice(async () => {
      throw new Error("not in the app");
    });
    expect(ownerOfItem(K)).toBe("sat-1");
  });

  it("ignores a hydrate pull older than a pushed slice", async () => {
    main.offer(mainSlice(4, {}));
    await pullMainSlice(async () => mainSlice(3, { [canonicalItemKey(K)]: "sat-1" }));
    expect(ownerMapSize()).toBe(0);
  });
});

// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { createSliceHolder, startRegistryClient, type RegistryClientDeps } from "./registry-client";
import type { WindowSlice } from "./window-slice";

function slice(version: number, extra: Partial<WindowSlice> = {}): WindowSlice {
  return {
    label: "sat-1",
    kind: "satellite",
    number: 2,
    version,
    layoutRef: null,
    items: [],
    pending: false,
    ...extra,
  };
}

function harness(pulled: WindowSlice) {
  const calls: string[] = [];
  let push: ((s: WindowSlice) => void) | null = null;
  const unlisten = vi.fn();
  const deps: RegistryClientDeps = {
    label: "sat-1",
    listen: async (handler) => {
      calls.push("listen");
      push = handler;
      return unlisten;
    },
    getSlice: async (label) => {
      calls.push(`get:${label}`);
      return pulled;
    },
    ready: async () => {
      calls.push("ready");
    },
  };
  return { calls, deps, unlisten, push: (s: WindowSlice) => push?.(s) };
}

describe("createSliceHolder", () => {
  it("keeps the newest slice and ignores an older or equal one", () => {
    const seen: number[] = [];
    const holder = createSliceHolder((s) => seen.push(s.version));
    expect(holder.offer(slice(2))).toBe(true);
    expect(holder.offer(slice(1))).toBe(false);
    expect(holder.offer(slice(2))).toBe(false);
    expect(holder.offer(slice(3))).toBe(true);
    expect(seen).toEqual([2, 3]);
    expect(holder.current()?.version).toBe(3);
  });
});

describe("startRegistryClient", () => {
  it("mounts the listener, then pulls its own slice, then reports ready", async () => {
    const h = harness(slice(1));
    const holder = createSliceHolder(() => {});
    await startRegistryClient(h.deps, holder);
    expect(h.calls).toEqual(["listen", "get:sat-1", "ready"]);
    expect(holder.current()?.version).toBe(1);
  });

  it("drops a pulled slice older than one pushed while the pull was in flight", async () => {
    const h = harness(slice(1));
    const holder = createSliceHolder(() => {});
    h.deps.getSlice = async () => {
      h.push(slice(2, { layoutRef: "grp_a" }));
      return slice(1);
    };
    await startRegistryClient(h.deps, holder);
    expect(holder.current()).toEqual(slice(2, { layoutRef: "grp_a" }));
  });

  it("takes pushes after ready, and ignores another window's slice", async () => {
    const h = harness(slice(1));
    const holder = createSliceHolder(() => {});
    await startRegistryClient(h.deps, holder);
    h.push(slice(5, { label: "sat-2" }));
    expect(holder.current()?.version).toBe(1);
    h.push(slice(2));
    expect(holder.current()?.version).toBe(2);
  });

  it("unlistens and rethrows when the pull fails, and never reports ready", async () => {
    const h = harness(slice(1));
    h.deps.getSlice = async () => {
      throw new Error("no window");
    };
    await expect(
      startRegistryClient(
        h.deps,
        createSliceHolder(() => {}),
      ),
    ).rejects.toThrow("no window");
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(h.calls).not.toContain("ready");
  });
});

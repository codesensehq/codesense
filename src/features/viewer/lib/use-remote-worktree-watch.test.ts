// SPDX-License-Identifier: MIT
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { logger } from "@/shared/lib/logger";

const startMock = vi.fn();
const stopMock = vi.fn();
const trackedCountMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@/tauri/commands", () => ({
  sourceRemoteWatchStart: (...args: unknown[]) => startMock(...args),
  sourceRemoteWatchStop: (...args: unknown[]) => stopMock(...args),
  sourceRemoteTrackedCount: (...args: unknown[]) => trackedCountMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  useRemoteWorktreeWatch,
  useRemoteWatchNonce,
  __fireRemoteWatchTickForTests,
  __resetRemoteWorktreeWatch,
  __remoteWorktreeWatchPollMs,
  __remoteWorktreeWatchRefCount,
} from "./use-remote-worktree-watch";

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/** Make every call to `mock` return its own pending promise, settled by hand
 *  through the returned list (one entry per call, in call order). */
function deferCalls<T>(mock: Mock): Deferred<T>[] {
  const calls: Deferred<T>[] = [];
  mock.mockImplementation(
    () => new Promise<T>((resolve, reject) => calls.push({ resolve, reject })),
  );
  return calls;
}

/** Drain the microtasks a settle chains (start/listen `.then`, React updates). */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const mountWatch = (pollMs = 5000) =>
  renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, pollMs));
const mountNonce = () => renderHook(() => useRemoteWatchNonce("m-1", "h-A"));
const stopped = () => stopMock.mock.calls.map((c) => c[0]);

/**
 * DESIGN-remote-source.md §3.3 / AD-2 — the ref-counted watcher lifecycle. Two
 * consumers on the same (machineId, handle) share ONE poll task on the host;
 * out-of-order attach/detach cannot strand the subscriber watcher-dead.
 */
describe("useRemoteWorktreeWatch — ref-counted lifecycle", () => {
  beforeEach(() => {
    __resetRemoteWorktreeWatch();
    vi.clearAllMocks();
    stopMock.mockResolvedValue(undefined);
    // The watcher now listens for per-handle events; the test's mocked listen
    // returns a Promise so attach can proceed without a real Tauri bridge.
    listenMock.mockResolvedValue(() => {});
    // The tracked-count probe fires on attach; a never-resolving Promise keeps
    // the probe inert and prevents setRemoteTrackedCount side effects from
    // leaking into other suites (the cadence module has its own tests).
    trackedCountMock.mockReturnValue(new Promise(() => {}));
  });

  it("first consumer on a (machineId, handle) attaches once with the passed pollMs; count goes to 1", () => {
    startMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { unmount } = renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    // DESIGN-remote-phase-2.md B-2 — pollMs is threaded through so the Rust
    // task uses the §0 remote cadence instead of the 2 s default.
    expect(startMock).toHaveBeenCalledWith("m-1", "h-A", 5000);
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(1);
    unmount();
  });

  it("omitted pollMs falls back to the remoteSmall preset (B-2 regression gate)", () => {
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-9", "h-9", true));
    // Default = CADENCE_PRESETS.remoteSmall.watcherMs = 5000.
    expect(startMock).toHaveBeenCalledWith("m-9", "h-9", 5000);
  });

  it("second consumer on the same key does NOT re-attach; count goes to 2", () => {
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(2);
  });

  it("different keys get independent attaches", () => {
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    renderHook(() => useRemoteWorktreeWatch("m-1", "h-B", true, 5000));
    renderHook(() => useRemoteWorktreeWatch("m-2", "h-A", true, 5000));
    expect(startMock).toHaveBeenCalledTimes(3);
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(1);
    expect(__remoteWorktreeWatchRefCount("m-1", "h-B")).toBe(1);
    expect(__remoteWorktreeWatchRefCount("m-2", "h-A")).toBe(1);
  });

  it("last consumer release detaches via the attach token", async () => {
    startMock.mockResolvedValue(42);
    const { unmount } = renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    // Let the attach promise resolve so the token is stored.
    await Promise.resolve();
    await Promise.resolve();
    unmount();
    expect(stopMock).toHaveBeenCalledWith(42);
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(0);
  });

  it("released-before-attach-resolves still cleans up (ordering safe)", async () => {
    let resolveAttach!: (token: number) => void;
    startMock.mockReturnValue(new Promise((r) => (resolveAttach = r)));
    const { unmount } = renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    // Release while the attach is in flight.
    unmount();
    // Now resolve — the module must detach immediately.
    resolveAttach(99);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopMock).toHaveBeenCalledWith(99);
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(0);
  });

  it("disabled hook is a no-op (no attach, no refcount)", () => {
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", false, 5000));
    expect(startMock).not.toHaveBeenCalled();
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(0);
  });

  it("null machineId / handle is a no-op (used for local tabs)", () => {
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch(null, null, true, 5000));
    renderHook(() => useRemoteWorktreeWatch("m-1", null, true, 5000));
    renderHook(() => useRemoteWorktreeWatch(null, "h-A", true, 5000));
    expect(startMock).not.toHaveBeenCalled();
  });

  it("an attach failure doesn't block the mount or future acquires", async () => {
    startMock.mockRejectedValueOnce(new Error("transport failure"));
    const { unmount } = renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000));
    // Give the rejection a tick to log and settle.
    await Promise.resolve();
    await Promise.resolve();
    // A refcount entry stays (so repeated mounts don't spin on the hard fail).
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(1);
    unmount();
    // After unmount, the count is 0 and stop is NOT called (no token to detach).
    expect(stopMock).not.toHaveBeenCalled();
    expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(0);
  });
});

// DESIGN-remote-phase-2.md B-4 — the nonce hook attaches a listener via
// `ensureEntry`, so a sibling-component mount OR a hook declared BEFORE
// `useRemoteWorktreeWatch` still receives ticks once the watcher attaches.
describe("useRemoteWatchNonce — B-4 ensure-entry defensive attach", () => {
  beforeEach(() => {
    __resetRemoteWorktreeWatch();
    vi.clearAllMocks();
    stopMock.mockResolvedValue(undefined);
    listenMock.mockResolvedValue(() => {});
    trackedCountMock.mockReturnValue(new Promise(() => {}));
  });

  it("nonce hook called BEFORE the watcher still receives subsequent ticks", async () => {
    const { useRemoteWatchNonce, __fireRemoteWatchTickForTests } =
      await import("./use-remote-worktree-watch");
    // Mount nonce FIRST (the broken order the review flagged for B-4).
    const { result: nonceResult } = renderHook(() => useRemoteWatchNonce("m-x", "h-x"));
    expect(nonceResult.current).toBe(0);
    // Now mount the watch. The nonce listener's entry pre-exists via
    // `ensureEntry`, so acquire upgrades the SAME entry — listeners survive.
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-x", "h-x", true, 5000));
    // Simulate a watcher tick (bypasses the Tauri event bridge).
    act(() => {
      __fireRemoteWatchTickForTests("m-x", "h-x");
    });
    // The nonce listener MUST have been notified.
    expect(nonceResult.current).toBe(1);
  });

  it("a view mounted over a watch that already ticked starts at its nonce (no step)", async () => {
    const { useRemoteWatchNonce, __fireRemoteWatchTickForTests } =
      await import("./use-remote-worktree-watch");
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-y", "h-y", true, 5000));
    act(() => {
      __fireRemoteWatchTickForTests("m-y", "h-y");
      __fireRemoteWatchTickForTests("m-y", "h-y");
    });
    const seen: number[] = [];
    renderHook(() => {
      const n = useRemoteWatchNonce("m-y", "h-y");
      seen.push(n);
      return n;
    });
    expect(seen.every((n) => n === 2)).toBe(true);
  });

  it("switching a mounted hook to another watch re-bases on that watch's nonce in the same render", async () => {
    const { useRemoteWatchNonce, __fireRemoteWatchTickForTests } =
      await import("./use-remote-worktree-watch");
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() => useRemoteWorktreeWatch("m-z", "h-b", true, 5000));
    act(() => {
      for (let i = 0; i < 3; i++) __fireRemoteWatchTickForTests("m-z", "h-b");
    });
    const seen: number[] = [];
    const { rerender } = renderHook(
      ({ h }) => {
        const n = useRemoteWatchNonce("m-z", h);
        seen.push(n);
        return n;
      },
      { initialProps: { h: "h-a" } },
    );
    seen.length = 0;
    rerender({ h: "h-b" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 3)).toBe(true);
  });

  it("tracked-count probe fires on first attach and feeds setRemoteTrackedCount", async () => {
    const resolveToken = Promise.resolve(7);
    startMock.mockReturnValue(resolveToken);
    const resolveCount = Promise.resolve(42);
    trackedCountMock.mockReturnValue(resolveCount);
    renderHook(() => useRemoteWorktreeWatch("m-probe", "h-probe", true, 5000));
    // Drain microtasks for both the attach promise AND the probe promise.
    await resolveToken;
    await resolveCount;
    expect(trackedCountMock).toHaveBeenCalledWith("m-probe", "h-probe");
  });

  it("pollMs flows through useRepoWorktreeWatch for a remote repo", async () => {
    const { useRepoWorktreeWatch } = await import("./use-repo-worktree-watch");
    const { setRemoteTrackedCount, LARGE_REPO_THRESHOLD, __resetRemoteCadence } =
      await import("./use-remote-cadence");
    __resetRemoteCadence();
    startMock.mockReturnValue(new Promise(() => {}));
    renderHook(() =>
      useRepoWorktreeWatch("ws-1", { kind: "remote", machineId: "m-r", handle: "h-r" }, true),
    );
    // Default (small-repo) preset's watcherMs = 5000.
    expect(startMock).toHaveBeenCalledWith("m-r", "h-r", 5000);
    // After a large-repo probe, the loosened cadence governs the NEXT attach;
    // the current one keeps the window it was started with (documented in
    // the hook — thrash protection).
    setRemoteTrackedCount("m-r", "h-r", LARGE_REPO_THRESHOLD + 1);
  });
});

// A release to 0 and a re-acquire while the start or the event listen is still
// in flight: one start and one listen per entry lifecycle, every token stopped
// exactly once, and an entry left at count 0 with nothing in flight retired.
describe("useRemoteWorktreeWatch — re-open while the attach is in flight", () => {
  let unlisten: Mock;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetRemoteWorktreeWatch();
    vi.clearAllMocks();
    stopMock.mockResolvedValue(undefined);
    unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    trackedCountMock.mockReturnValue(new Promise(() => {}));
    warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe("a quick re-open leaks no poll task", () => {
    it("one re-open: one start, its token stopped once", async () => {
      const starts = deferCalls<number>(startMock);
      mountWatch().unmount();
      const b = mountWatch();
      starts.forEach((d, i) => d.resolve(i + 1));
      await flush();
      b.unmount();
      await flush();
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(stopped()).toEqual([1]);
    });

    it("three cycles: the token lives while the last consumer is mounted", async () => {
      const starts = deferCalls<number>(startMock);
      mountWatch().unmount();
      mountWatch().unmount();
      const c = mountWatch();
      starts.forEach((d, i) => d.resolve(i + 1));
      await flush();
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(stopMock).not.toHaveBeenCalled();
      c.unmount();
      await flush();
      expect(stopped()).toEqual([1]);
    });

    it("StrictMode mount, unmount, mount: one start, its token stopped once", async () => {
      const starts = deferCalls<number>(startMock);
      const view = renderHook(() => useRemoteWorktreeWatch("m-1", "h-A", true, 5000), {
        wrapper: StrictMode,
      });
      starts.forEach((d, i) => d.resolve(i + 1));
      await flush();
      view.unmount();
      await flush();
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(stopped()).toEqual([1]);
    });
  });

  describe("a start that resolves at count 0 retires the entry", () => {
    it("with no nonce listener: stops, unlistens and drops the entry", async () => {
      const starts = deferCalls<number>(startMock);
      const a = mountWatch();
      await flush();
      act(() => __fireRemoteWatchTickForTests("m-1", "h-A"));
      a.unmount();
      starts[0].resolve(1);
      await flush();
      expect(stopped()).toEqual([1]);
      expect(unlisten).toHaveBeenCalledTimes(1);
      mountWatch();
      expect(startMock).toHaveBeenCalledTimes(2);
      expect(listenMock).toHaveBeenCalledTimes(2);
      expect(mountNonce().result.current).toBe(0);
    });

    it("with a nonce listener: stops and unlistens, the entry keeps ticking", async () => {
      const starts = deferCalls<number>(startMock);
      const nonce = mountNonce();
      const a = mountWatch();
      await flush();
      act(() => __fireRemoteWatchTickForTests("m-1", "h-A"));
      a.unmount();
      starts[0].resolve(1);
      await flush();
      expect(stopped()).toEqual([1]);
      expect(unlisten).toHaveBeenCalledTimes(1);
      act(() => __fireRemoteWatchTickForTests("m-1", "h-A"));
      expect(nonce.result.current).toBe(2);
      mountWatch();
      expect(startMock).toHaveBeenCalledTimes(2);
      expect(listenMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("a rejected start leaves nothing pending", () => {
    it("rejects after the release to 0", async () => {
      const starts = deferCalls<number>(startMock);
      const a = mountWatch();
      await flush();
      a.unmount();
      starts[0].reject(new Error("transport failure"));
      await flush();
      expect(warn).toHaveBeenCalled();
      expect(stopMock).not.toHaveBeenCalled();
      expect(unlisten).toHaveBeenCalledTimes(1);
      mountWatch();
      expect(startMock).toHaveBeenCalledTimes(2);
      expect(listenMock).toHaveBeenCalledTimes(2);
    });

    it("rejects after a re-open joined it", async () => {
      const starts = deferCalls<number>(startMock);
      const a = mountWatch();
      await flush();
      a.unmount();
      const b = mountWatch();
      starts[0].reject(new Error("transport failure"));
      await flush();
      b.unmount();
      await flush();
      expect(warn).toHaveBeenCalled();
      expect(stopMock).not.toHaveBeenCalled();
      expect(unlisten).toHaveBeenCalledTimes(1);
      mountWatch();
      expect(startMock).toHaveBeenCalledTimes(2);
      expect(listenMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["rejects", false],
      ["resolves", true],
    ])(
      "a start that %s after its entry was replaced leaves the new entry alone",
      async (_name, resolves) => {
        const starts = deferCalls<number>(startMock);
        listenMock.mockRejectedValue(new Error("no event bridge"));
        const nonce = mountNonce();
        const a = mountWatch();
        await flush();
        a.unmount();
        nonce.unmount(); // nothing holds the entry any more: the nonce GC drops it
        const b = mountWatch();
        expect(startMock).toHaveBeenCalledTimes(2);
        if (resolves) starts[0].resolve(1);
        else starts[0].reject(new Error("transport failure"));
        await flush();
        expect(stopped()).toEqual(resolves ? [1] : []);
        expect(__remoteWorktreeWatchRefCount("m-1", "h-A")).toBe(1);
        starts[1].resolve(2);
        await flush();
        b.unmount();
        await flush();
        expect(stopped().filter((t) => t === 2)).toEqual([2]);
        expect(stopped().filter((t) => t === 1)).toEqual(resolves ? [1] : []);
      },
    );
  });

  it("a failed stop is logged, not thrown", async () => {
    startMock.mockResolvedValue(1);
    stopMock.mockRejectedValue(new Error("connection lost"));
    const a = mountWatch();
    await flush();
    a.unmount();
    await flush();
    expect(stopped()).toEqual([1]);
    expect(warn).toHaveBeenCalledWith(
      "useRemoteWorktreeWatch",
      expect.stringContaining("stop failed"),
    );
  });

  describe("pollMs follows the start it belongs to", () => {
    it("a joined start keeps the first pollMs", () => {
      deferCalls<number>(startMock);
      mountWatch(5000).unmount();
      mountWatch(10000);
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(startMock).toHaveBeenCalledWith("m-1", "h-A", 5000);
      expect(__remoteWorktreeWatchPollMs("m-1", "h-A")).toBe(5000);
    });

    it("a fresh start on a kept entry uses the new pollMs", async () => {
      const starts = deferCalls<number>(startMock);
      mountNonce();
      const a = mountWatch(5000);
      starts[0].resolve(1);
      await flush();
      a.unmount();
      mountWatch(10000);
      expect(startMock).toHaveBeenCalledTimes(2);
      expect(startMock).toHaveBeenLastCalledWith("m-1", "h-A", 10000);
      expect(__remoteWorktreeWatchPollMs("m-1", "h-A")).toBe(10000);
    });
  });

  describe("one listener per entry lifecycle", () => {
    it("a re-open while the listen is pending starts no second listen", async () => {
      const starts = deferCalls<number>(startMock);
      const listens = deferCalls<Mock>(listenMock);
      mountWatch().unmount();
      const b = mountWatch();
      listens.forEach((d) => d.resolve(unlisten));
      starts.forEach((d, i) => d.resolve(i + 1));
      await flush();
      expect(listenMock).toHaveBeenCalledTimes(1);
      b.unmount();
      await flush();
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    it("a listen that resolves at count 0 on a kept entry is unlistened at once", async () => {
      const starts = deferCalls<number>(startMock);
      const listens = deferCalls<Mock>(listenMock);
      mountNonce();
      mountWatch().unmount();
      starts[0].resolve(1);
      listens[0].resolve(unlisten);
      await flush();
      expect(unlisten).toHaveBeenCalledTimes(1);
      mountWatch();
      expect(listenMock).toHaveBeenCalledTimes(2);
    });

    it("a rejected listen lets the next attach listen again", async () => {
      const starts = deferCalls<number>(startMock);
      const listens = deferCalls<Mock>(listenMock);
      mountNonce();
      const a = mountWatch();
      listens[0].reject(new Error("no event bridge"));
      await flush();
      a.unmount();
      starts[0].resolve(1);
      await flush();
      mountWatch();
      expect(listenMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["resolved", true],
      ["rejected", false],
    ])(
      "a join after the listen %s at count 0 listens again and ticks once",
      async (_name, resolves) => {
        deferCalls<number>(startMock);
        const listens = deferCalls<() => void>(listenMock);
        // The event bridge: a handler is installed once its listen resolves
        // and stays installed until its unlisten runs. A tick reaches all.
        const installed = new Set<() => void>();
        const install = (i: number) => {
          const handler = listenMock.mock.calls[i][1] as () => void;
          installed.add(handler);
          listens[i].resolve(() => {
            unlisten();
            installed.delete(handler);
          });
        };
        mountWatch().unmount();
        if (resolves) install(0);
        else listens[0].reject(new Error("no event bridge"));
        await flush();
        expect(unlisten).toHaveBeenCalledTimes(resolves ? 1 : 0);
        mountWatch();
        expect(startMock).toHaveBeenCalledTimes(1);
        expect(listenMock).toHaveBeenCalledTimes(2);
        install(1);
        await flush();
        expect(installed.size).toBe(1);
        const nonce = mountNonce();
        const before = nonce.result.current;
        act(() => installed.forEach((handler) => handler()));
        expect(nonce.result.current).toBe(before + 1);
      },
    );
  });
});

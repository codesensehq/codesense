// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { warmScopes } from "@/shared/lib/warm-scopes";
import { useViewerStore } from "@/shared/stores/viewer-store";

const { mockAttach, mockDetach } = vi.hoisted(() => ({
  mockAttach: vi.fn(),
  mockDetach: vi.fn(),
}));

vi.mock("@/tauri/commands", () => ({
  lazyAttachWorktreeWatch: mockAttach,
  detachWorktreeWatch: mockDetach,
}));
vi.mock("@/shared/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { logger } from "@/shared/lib/logger";
import {
  useWorktreeWatch,
  __resetWorktreeWatch,
  WATCH_OP_SETTLE_BOUND_MS,
} from "./use-worktree-watch";

beforeEach(() => {
  __resetWorktreeWatch();
  mockAttach.mockReset().mockResolvedValue(7);
  mockDetach.mockReset().mockResolvedValue(undefined);
});

describe("useWorktreeWatch — ref-counted shared watch (RD-13)", () => {
  it("attaches once for two consumers of the same wsId", async () => {
    const a = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    const b = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));
    a.unmount();
    b.unmount();
    await waitFor(() => expect(mockDetach).toHaveBeenCalledTimes(1));
    expect(mockDetach).toHaveBeenCalledWith("ws1", 7);
  });

  it("keeps the watch alive when only ONE of two consumers unmounts (no strand)", async () => {
    const a = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    const b = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));

    a.unmount(); // inset closes; overlay (b) still open
    // The watch must NOT be detached while b holds a reference.
    expect(mockDetach).not.toHaveBeenCalled();

    b.unmount();
    await waitFor(() => expect(mockDetach).toHaveBeenCalledTimes(1));
  });

  it("does not attach when disabled", () => {
    renderHook(() => useWorktreeWatch("ws1", "/wt", false));
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("detaches immediately if released before the in-flight attach resolves", async () => {
    let resolveAttach!: (t: number) => void;
    mockAttach.mockReturnValueOnce(new Promise<number>((r) => (resolveAttach = r)));
    const a = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    a.unmount(); // release before attach resolves
    resolveAttach(9);
    await waitFor(() => expect(mockDetach).toHaveBeenCalledWith("ws1", 9));
  });
});

describe("useWorktreeWatch — hidden warm teams", () => {
  it("attaches the shown team's worktree when a retained team repeats the workspace id", async () => {
    act(() => warmScopes.activate("org/a"));
    renderHook(() => useWorktreeWatch("ws1", "/team-a/wt", true, "org/a"));
    // A's attach is still in flight when the switch lands.
    act(() => warmScopes.activate("org/b"));
    renderHook(() => useWorktreeWatch("ws1", "/team-b/wt", true, "org/b"));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledWith("ws1", "/team-b/wt"));
    // The retained team's watch never outlives the switch: its token is detached, the shown
    // team's stays.
    await waitFor(() => expect(mockDetach).toHaveBeenCalledTimes(1));
    warmScopes.forget("org/a");
    warmScopes.forget("org/b");
  });
});

describe("useWorktreeWatch — resume signal", () => {
  const nonce = () => useViewerStore.getState().worktreeChangedPath["ws1"]?.nonce ?? 0;

  it("bumps the shared change nonce once when a hidden team is shown again, not on first mount", async () => {
    useViewerStore.setState({ worktreeChangedPath: {} });
    act(() => warmScopes.activate("org/a"));
    renderHook(() => useWorktreeWatch("ws1", "/wt", true, "org/a"));
    await waitFor(() => expect(mockAttach).toHaveBeenCalledTimes(1));
    expect(nonce()).toBe(0);
    act(() => warmScopes.activate("org/b"));
    expect(nonce()).toBe(0);
    act(() => warmScopes.activate("org/a"));
    expect(nonce()).toBe(1);
    expect(useViewerStore.getState().worktreeChangedPath["ws1"]?.resumed).toBe(1);
    warmScopes.forget("org/a");
    warmScopes.forget("org/b");
  });
});

/**
 * A backend with one watch slot per key. An attach *applies* (mints the next token and replaces
 * the slot) and *replies* (resolves the invoke) as separate steps, so a test can land attaches on
 * the backend in one order and deliver their replies in another. A detach clears the slot only
 * on a token match.
 */
function fakeBackend() {
  interface Call {
    cwd: string;
    token: number | null;
    resolve: (token: number) => void;
    reject: (err: Error) => void;
  }
  const calls: Call[] = [];
  const log: string[] = [];
  let slot: number | null = null;
  let minted = 0;
  mockAttach.mockImplementation(
    (_wsId: string, cwd: string) =>
      new Promise<number>((resolve, reject) => {
        calls.push({ cwd, token: null, resolve, reject });
        log.push(`attach ${cwd}`);
      }),
  );
  mockDetach.mockImplementation(async (_wsId: string, token: number) => {
    log.push(`detach ${token}`);
    if (slot === token) slot = null;
  });
  const apply = (i: number) => {
    const call = calls[i];
    call.token = ++minted;
    slot = call.token;
    log.push(`applied ${call.cwd} as ${call.token}`);
  };
  const reply = (i: number) => calls[i].resolve(calls[i].token!);
  return {
    calls,
    log,
    slot: () => slot,
    apply,
    reply,
    /** Apply and reply in one step: the attach lands and resolves together. */
    resolve: (i: number) => {
      apply(i);
      reply(i);
    },
    reject: (i: number) => calls[i].reject(new Error("watch failed")),
  };
}

/** Let promise chains run (the per-key queue hops several microtasks per operation). */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("useWorktreeWatch — attach and detach run in order per key", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logger.warn).mockClear();
    useViewerStore.setState({ worktreeChangedPath: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const nonce = () => useViewerStore.getState().worktreeChangedPath["ws1"]?.nonce ?? 0;

  /** Acquire A, release A with its attach pending, acquire B. */
  async function overlap() {
    const fake = fakeBackend();
    const a = renderHook(() => useWorktreeWatch("ws1", "/a", true));
    await flush();
    a.unmount();
    const b = renderHook(() => useWorktreeWatch("ws1", "/b", true));
    await flush();
    return { fake, b };
  }

  it("a released attach that lands after the next one can't leave the key unwatched", async () => {
    const { fake } = await overlap();
    // Resolve every pending attach but A's (B's, if it was issued), then A's.
    for (let i = 1; i < fake.calls.length; i++) fake.resolve(i);
    fake.resolve(0);
    await flush();
    for (let i = 1; i < fake.calls.length; i++) if (fake.calls[i].token === null) fake.resolve(i);
    await flush();

    const bTokens = fake.calls.filter((c) => c.cwd === "/b").map((c) => c.token);
    expect(fake.slot()).not.toBeNull();
    expect(bTokens).toContain(fake.slot());
    for (const token of bTokens) expect(mockDetach).not.toHaveBeenCalledWith("ws1", token);
    const applied = fake.log.filter((l) => l.startsWith("applied") || l.startsWith("detach"));
    expect(applied.at(-1)).toBe(`applied /b as ${fake.slot()}`);
  });

  it("an attach released before its turn is skipped", async () => {
    const fake = fakeBackend();
    const a = renderHook(() => useWorktreeWatch("ws1", "/a", true));
    await flush();
    a.unmount();
    const b = renderHook(() => useWorktreeWatch("ws1", "/b", true));
    await flush();
    b.unmount();
    renderHook(() => useWorktreeWatch("ws1", "/c", true));
    await flush();
    fake.resolve(0);
    await flush();
    expect(fake.calls.map((c) => c.cwd)).toEqual(["/a", "/c"]);
    fake.resolve(1);
    await flush();
    expect(fake.slot()).toBe(2);
    expect(fake.log).toEqual([
      "attach /a",
      "applied /a as 1",
      "detach 1",
      "attach /c",
      "applied /c as 2",
    ]);
  });

  it("two consumers share one attach and the last release detaches it", async () => {
    const fake = fakeBackend();
    const a = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    const b = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    await flush();
    expect(mockAttach).toHaveBeenCalledTimes(1);
    fake.resolve(0);
    await flush();
    a.unmount();
    await flush();
    expect(mockDetach).not.toHaveBeenCalled();
    expect(fake.slot()).toBe(1);
    b.unmount();
    await flush();
    expect(mockDetach).toHaveBeenCalledWith("ws1", 1);
    expect(fake.slot()).toBeNull();
  });

  it("a release during the attach detaches once it resolves", async () => {
    const fake = fakeBackend();
    const a = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    await flush();
    a.unmount();
    fake.resolve(0);
    await flush();
    expect(mockDetach).toHaveBeenCalledWith("ws1", 1);
    expect(fake.slot()).toBeNull();
  });

  it("a rejected attach logs, and a later acquire still attaches", async () => {
    const fake = fakeBackend();
    const a = renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    await flush();
    fake.reject(0);
    await flush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    a.unmount();
    renderHook(() => useWorktreeWatch("ws1", "/wt", true));
    await flush();
    expect(mockAttach).toHaveBeenCalledTimes(2);
    fake.resolve(1);
    await flush();
    expect(fake.slot()).toBe(1);
    expect(mockDetach).not.toHaveBeenCalled();
  });

  it("an attach that never settles stops holding the key after the bound", async () => {
    const { fake } = await overlap();
    expect(mockAttach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WATCH_OP_SETTLE_BOUND_MS - 1);
    expect(mockAttach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockAttach).toHaveBeenCalledTimes(2);
    expect(fake.calls[1].cwd).toBe("/b");
    fake.resolve(1);
    await flush();
    expect(fake.slot()).toBe(1);
  });

  /** Overlap, then let the bound pass so B's attach is issued beside A's hung one. */
  async function lateOverlap() {
    const ctx = await overlap();
    await vi.advanceTimersByTimeAsync(WATCH_OP_SETTLE_BOUND_MS);
    expect(mockAttach).toHaveBeenCalledTimes(2);
    return ctx;
  }

  it("a late attach that replaced the live watch is detached and the live entry re-attached", async () => {
    const { fake } = await lateOverlap();
    fake.apply(1); // B lands: 1
    fake.apply(0); // A lands after it: 2, replacing B's watch
    fake.reply(1);
    await flush();
    fake.reply(0);
    await flush();
    expect(mockDetach).toHaveBeenCalledWith("ws1", 2);
    expect(mockAttach).toHaveBeenCalledTimes(3);
    expect(fake.calls[2].cwd).toBe("/b");
    expect(nonce()).toBe(0);
    fake.resolve(2);
    await flush();
    expect(fake.slot()).toBe(3);
    expect(nonce()).toBe(1);
  });

  it("a late higher token that replies first is held until the live attach settles", async () => {
    const { fake } = await lateOverlap();
    fake.apply(1); // B: 1
    fake.apply(0); // A: 2
    fake.reply(0);
    await flush();
    // B is still pending: nothing is detached or re-attached yet.
    expect(mockDetach).not.toHaveBeenCalled();
    expect(mockAttach).toHaveBeenCalledTimes(2);
    fake.reply(1);
    await flush();
    expect(fake.log.slice(-2)).toEqual(["detach 2", "attach /b"]);
    fake.resolve(2);
    await flush();
    expect(fake.slot()).toBe(3);
    expect(mockAttach).toHaveBeenCalledTimes(3);
    expect(nonce()).toBe(1);
  });

  it("a re-attach for an entry released before its turn is skipped", async () => {
    const { fake, b } = await lateOverlap();
    fake.apply(1); // B: 1
    fake.apply(0); // A: 2
    fake.reply(1);
    await flush();
    let releaseDetach!: () => void;
    mockDetach.mockImplementationOnce((_wsId: string, token: number) => {
      fake.log.push(`detach ${token}`);
      return new Promise<void>((r) => (releaseDetach = r));
    });
    fake.reply(0);
    await flush();
    // The late token's detach holds the key; the re-attach is queued behind it.
    expect(fake.log.at(-1)).toBe("detach 2");
    b.unmount();
    releaseDetach();
    await flush();
    expect(mockAttach).toHaveBeenCalledTimes(2);
    expect(nonce()).toBe(0);
  });

  it("a late lower token is detached and the live watch kept", async () => {
    const { fake } = await lateOverlap();
    fake.apply(0); // A: 1
    fake.apply(1); // B: 2, replacing A's watch
    fake.reply(1);
    await flush();
    fake.reply(0);
    await flush();
    expect(mockDetach).toHaveBeenCalledWith("ws1", 1);
    expect(mockAttach).toHaveBeenCalledTimes(2);
    expect(fake.slot()).toBe(2);
    expect(nonce()).toBe(0);
  });

  it("a held late token is detached, with no re-attach, when the live attach rejects", async () => {
    const { fake } = await lateOverlap();
    fake.apply(0); // A: 1
    fake.reply(0);
    await flush();
    expect(mockDetach).not.toHaveBeenCalled();
    fake.reject(1);
    await flush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(mockDetach).toHaveBeenCalledWith("ws1", 1);
    expect(fake.slot()).toBeNull();
    expect(mockAttach).toHaveBeenCalledTimes(2);
  });

  it("a held late token is detached when the live entry is released", async () => {
    const { fake, b } = await lateOverlap();
    fake.apply(1); // B: 1
    fake.apply(0); // A: 2
    fake.reply(0);
    await flush();
    b.unmount();
    await flush();
    // Queued behind B's attach, which still holds the key.
    expect(mockDetach).not.toHaveBeenCalled();
    fake.reply(1);
    await flush();
    expect(fake.log.slice(-2)).toEqual(["detach 1", "detach 2"]);
    expect(fake.slot()).toBeNull();
    expect(mockAttach).toHaveBeenCalledTimes(2);
  });
});

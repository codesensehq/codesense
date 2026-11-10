// SPDX-License-Identifier: MIT
import { registerFrame, acknowledgeFlush } from "../lib/frame-lifecycle";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useFrameRecord } from "./use-frame-record";
import { mintFrame, releaseFrame, revalidateFrame } from "@/tauri/commands";
import { frameFixture } from "../../../../tests/support/fixtures/frame";
vi.mock("@/tauri/commands", () => ({
  mintFrame: vi.fn(),
  revalidateFrame: vi.fn(),
  releaseFrame: vi.fn(async () => {}),
}));
const first = { documentPath: "/ctx/a.html", contentRoot: "/ctx", slot: "centre" };
const second = { ...first, documentPath: "/ctx/b.html" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(revalidateFrame).mockReset().mockResolvedValue("unchanged");
});
it("approves an ordinary save without reminting or releasing the retained identity", async () => {
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(first));
  const { result, rerender, unmount } = renderHook(
    ({ revision }) => useFrameRecord(9123, first, undefined, revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.approvedRevision).toBe(1));
  const retained = result.current.frameRecord;
  let finish!: (value: "unchanged") => void;
  vi.mocked(revalidateFrame).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  rerender({ revision: 2 });
  expect(result.current.frameRecord).toBe(retained);
  expect(result.current.approvedRevision).toBe(1);
  await act(async () => finish("unchanged"));
  expect(result.current.approvedRevision).toBe(2);
  expect(result.current.frameRecord).toBe(retained);
  expect(revalidateFrame).toHaveBeenCalledWith(retained!.frameId, retained!.token);
  expect(mintFrame).toHaveBeenCalledTimes(1);
  expect(releaseFrame).not.toHaveBeenCalled();
  unmount();
  expect(releaseFrame).toHaveBeenCalledExactlyOnceWith("test");
});
it("remints changed authority, retires invalid authority and retries its correction", async () => {
  vi.mocked(mintFrame)
    .mockResolvedValueOnce(frameFixture(first))
    .mockResolvedValueOnce({ ...frameFixture(first), frameId: "changed" })
    .mockResolvedValueOnce({ ...frameFixture(first), frameId: "corrected" });
  const { result, rerender, unmount } = renderHook(
    ({ revision }) => useFrameRecord(9123, first, undefined, revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.approvedRevision).toBe(1));
  vi.mocked(revalidateFrame).mockResolvedValueOnce("remint-required");
  rerender({ revision: 2 });
  await waitFor(() => expect(result.current.frameRecord?.frameId).toBe("changed"));
  expect(result.current.approvedRevision).toBe(2);
  expect(releaseFrame).toHaveBeenCalledWith("test");
  vi.mocked(revalidateFrame).mockRejectedValueOnce(new Error("invalid declaration"));
  rerender({ revision: 3 });
  await waitFor(() => expect(result.current.frameError).toContain("invalid declaration"));
  expect(result.current.frameRecord).toBeNull();
  expect(releaseFrame).toHaveBeenCalledWith("changed");
  rerender({ revision: 4 });
  await waitFor(() => expect(result.current.frameRecord?.frameId).toBe("corrected"));
  expect(result.current.approvedRevision).toBe(4);
  expect(mintFrame).toHaveBeenCalledTimes(3);
  unmount();
});
it("retires a deleted document's authority without an error or a remint", async () => {
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(first));
  const { result, rerender, unmount } = renderHook(
    ({ revision }) => useFrameRecord(9123, first, undefined, revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.approvedRevision).toBe(1));
  vi.mocked(revalidateFrame).mockResolvedValueOnce("missing");
  rerender({ revision: 2 });
  await waitFor(() => expect(result.current.documentMissing).toBe(true));
  expect(result.current.frameRecord).toBeNull();
  expect(result.current.frameError).toBeNull();
  expect(releaseFrame).toHaveBeenCalledExactlyOnceWith("test");
  expect(mintFrame).toHaveBeenCalledTimes(1);
  unmount();
});
const MISSING = "missing: the document no longer exists";
it("keeps a deleted document missing through later refreshes until it is recreated", async () => {
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(first));
  const { result, rerender, unmount } = renderHook(
    ({ revision }) => useFrameRecord(9123, first, undefined, revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.approvedRevision).toBe(1));
  vi.mocked(revalidateFrame).mockResolvedValueOnce("missing");
  rerender({ revision: 2 });
  await waitFor(() => expect(result.current.documentMissing).toBe(true));
  // A declaration or source refresh while the file is absent remints and is refused natively.
  vi.mocked(mintFrame).mockRejectedValueOnce(MISSING);
  rerender({ revision: 3 });
  await waitFor(() => expect(mintFrame).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(result.current.documentMissing).toBe(true);
  expect(result.current.frameError).toBeNull();
  vi.mocked(mintFrame).mockResolvedValueOnce({ ...frameFixture(first), frameId: "recreated" });
  rerender({ revision: 4 });
  await waitFor(() => expect(result.current.frameRecord?.frameId).toBe("recreated"));
  expect(result.current.documentMissing).toBe(false);
  expect(result.current.approvedRevision).toBe(4);
  unmount();
});
it("keeps a deleted document missing when a retry remints it", async () => {
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(first));
  const { result, rerender, unmount } = renderHook(
    ({ revision }) => useFrameRecord(9123, first, undefined, revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.approvedRevision).toBe(1));
  vi.mocked(revalidateFrame).mockResolvedValueOnce("missing");
  rerender({ revision: 2 });
  await waitFor(() => expect(result.current.documentMissing).toBe(true));
  vi.mocked(mintFrame).mockRejectedValueOnce(MISSING);
  act(() => result.current.remintFrame());
  await waitFor(() => expect(mintFrame).toHaveBeenCalledTimes(2));
  await act(async () => {});
  expect(result.current.documentMissing).toBe(true);
  expect(result.current.frameError).toBeNull();
  unmount();
});
it("shows a missing document when its first mint or a team remint is refused", async () => {
  const initial = { ...first, slot: "dock", contentRoot: "/ctx/team-a/content" };
  vi.mocked(mintFrame).mockRejectedValueOnce(MISSING);
  const { result, rerender, unmount } = renderHook(({ args }) => useFrameRecord(9123, args), {
    initialProps: { args: first },
  });
  await waitFor(() => expect(result.current.documentMissing).toBe(true));
  expect(result.current.frameError).toBeNull();
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(initial));
  rerender({ args: initial });
  await waitFor(() => expect(result.current.frameRecord).not.toBeNull());
  vi.mocked(mintFrame).mockRejectedValueOnce(MISSING);
  rerender({ args: { ...initial, contentRoot: "/ctx/team-b/content" } });
  await waitFor(() => expect(result.current.documentMissing).toBe(true));
  expect(result.current.frameRecord).toBeNull();
  expect(result.current.frameError).toBeNull();
  unmount();
});
it("ignores stale comparisons without releasing a reused frame", async () => {
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(first));
  const { result, rerender, unmount } = renderHook(
    ({ revision }) => useFrameRecord(9123, first, undefined, revision),
    { initialProps: { revision: 1 } },
  );
  await waitFor(() => expect(result.current.approvedRevision).toBe(1));
  const finish: ((value: "unchanged" | "remint-required") => void)[] = [];
  vi.mocked(revalidateFrame).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(resolve);
      }),
  );
  rerender({ revision: 2 });
  rerender({ revision: 3 });
  await act(async () => finish[1]("unchanged"));
  await act(async () => finish[0]("remint-required"));
  expect(result.current.approvedRevision).toBe(3);
  expect(mintFrame).toHaveBeenCalledTimes(1);
  expect(releaseFrame).not.toHaveBeenCalled();
  rerender({ revision: 4 });
  unmount();
  await act(async () => finish[2]("unchanged"));
  expect(releaseFrame).toHaveBeenCalledExactlyOnceWith("test");
});
it("revokes a follows-context frame and mints a fresh grant when its team changes", async () => {
  const initial = { ...first, slot: "dock", contentRoot: "/ctx/team-a/content" };
  const next = { ...initial, contentRoot: "/ctx/team-b/content" };
  vi.mocked(mintFrame).mockImplementation(async (args) => ({
    ...frameFixture(args),
    frameId: args.contentRoot,
    token: args.contentRoot,
  }));
  const { result, rerender, unmount } = renderHook(({ args }) => useFrameRecord(9123, args), {
    initialProps: { args: initial },
  });
  await waitFor(() => expect(result.current.frameRecord?.frameId).toBe(initial.contentRoot));
  rerender({ args: next });
  expect(result.current.frameRecord).toBeNull();
  expect(releaseFrame).toHaveBeenCalledWith(initial.contentRoot);
  await waitFor(() => expect(result.current.frameRecord?.token).toBe(next.contentRoot));
  expect(mintFrame).toHaveBeenLastCalledWith(expect.objectContaining(next));
  unmount();
});
it("releases a frame whose mint completes after teardown", async () => {
  let finish!: (frame: ReturnType<typeof frameFixture>) => void;
  vi.mocked(mintFrame).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = renderHook(() => useFrameRecord(9123, first));
  unmount();
  await act(async () => finish(frameFixture(first)));
  expect(releaseFrame).toHaveBeenCalledExactlyOnceWith("test");
});
it("a changed document cannot reuse the previous frame while the next mint is pending", async () => {
  vi.mocked(mintFrame).mockResolvedValueOnce(frameFixture(first));
  const { result, rerender, unmount } = renderHook(({ args }) => useFrameRecord(9123, args), {
    initialProps: { args: first },
  });
  await waitFor(() => expect(result.current.frameRecord?.documentPath).toBe(first.documentPath));
  let finish!: (frame: ReturnType<typeof frameFixture>) => void;
  vi.mocked(mintFrame).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  rerender({ args: second });
  expect(result.current.frameRecord).toBeNull();
  expect(releaseFrame).toHaveBeenCalledExactlyOnceWith("test");
  await act(async () => finish({ ...frameFixture(second), frameId: "next" }));
  expect(result.current.frameRecord?.documentPath).toBe(second.documentPath);
  unmount();
  expect(releaseFrame).toHaveBeenLastCalledWith("next");
});

vi.mock("@/shared/lib/viewer-perf-config", () => ({ VIEWER_PERF: { maxBridgedFrames: 1 } }));
it("flushes and releases a hidden frame at the cap, then re-mints when shown", async () => {
  let count = 0;
  vi.mocked(mintFrame).mockImplementation(async (args) => ({
    ...frameFixture(args),
    kind: "team",
    frameId: `budget-${++count}`,
    token: `token-${count}`,
  }));
  const flush = vi.fn();
  const hidden = renderHook(
    ({ visible }) => useFrameRecord(9123, first, { visible, unsaved: false }),
    {
      initialProps: { visible: false },
    },
  );
  await waitFor(() => expect(hidden.result.current.frameRecord?.frameId).toBe("budget-1"));
  const off = registerFrame({ frameId: "budget-1", dashboard: "Test", post: flush, hide: vi.fn() });
  const shown = renderHook(() => useFrameRecord(9123, second, { visible: true, unsaved: false }));
  await waitFor(() => expect(flush).toHaveBeenCalledOnce());
  expect(releaseFrame).not.toHaveBeenCalledWith("budget-1");
  await act(async () => acknowledgeFlush("budget-1", flush.mock.calls[0][0].id));
  await waitFor(() => expect(shown.result.current.frameRecord?.frameId).toBe("budget-2"));
  await waitFor(() => expect(hidden.result.current.frameRecord).toBeNull());
  expect(flush).toHaveBeenCalledTimes(2);
  expect(releaseFrame).toHaveBeenCalledWith("budget-1");
  expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(releaseFrame).mock.invocationCallOrder[0],
  );
  hidden.rerender({ visible: true });
  await waitFor(() => expect(hidden.result.current.frameRecord?.frameId).toBe("budget-3"));
  hidden.unmount();
  shown.unmount();
  off?.();
});

it("remints a bundled reader's team grant when its local asset root stays the same", async () => {
  const initial = {
    documentPath: "/user/builtin-panes/panes/inbox.html",
    contentRoot: "/user/builtin-panes/panes",
    slot: "right-pane",
    builtinTeam: { org: "acme/api", team: "a" },
  };
  const next = { ...initial, builtinTeam: { org: "acme/api", team: "b" } };
  vi.mocked(mintFrame).mockImplementation(async (args) => ({
    ...frameFixture(args),
    frameId: args.builtinTeam!.team,
  }));
  const { result, rerender, unmount } = renderHook(({ args }) => useFrameRecord(9123, args), {
    initialProps: { args: initial },
  });
  await waitFor(() => expect(result.current.frameRecord?.grant.team?.team).toBe("a"));
  rerender({ args: next });
  expect(result.current.frameRecord).toBeNull();
  expect(releaseFrame).toHaveBeenCalledWith("a");
  await waitFor(() => expect(result.current.frameRecord?.grant.team?.team).toBe("b"));
  expect(mintFrame).toHaveBeenLastCalledWith(
    expect.objectContaining({ builtinTeam: next.builtinTeam }),
  );
  unmount();
});

// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("@/features/git-sync/lib/source-redline-source", () => ({
  sourceFileImageSides: vi.fn(),
}));

import { sourceFileImageSides } from "@/features/git-sync/lib/source-redline-source";
import { useSourceImageSides } from "./use-source-image-sides";

const read = vi.mocked(sourceFileImageSides);
const LOCAL = { kind: "local", cwd: "/wt/story" } as const;

beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue({ before: "QkVGT1JF", after: "QUZURVI=", tooLarge: false });
});

describe("useSourceImageSides", () => {
  it("reads a local raster file's sides at the working tree, then at a commit", async () => {
    const { result, rerender } = renderHook(
      ({ sha }: { sha: string | null }) =>
        useSourceImageSides(LOCAL, sha, "art/logo.png", "art/old.png", "main"),
      { initialProps: { sha: null as string | null } },
    );
    await waitFor(() => expect(result.current).toEqual({ before: "QkVGT1JF", after: "QUZURVI=" }));
    expect(read).toHaveBeenCalledWith("/wt/story", "art/logo.png", {
      oldPath: "art/old.png",
      baseRef: "main",
    });
    rerender({ sha: "abc123" });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenLastCalledWith("/wt/story", "art/logo.png", {
      oldPath: "art/old.png",
      sha: "abc123",
    });
  });

  it("an absent side stays absent", async () => {
    read.mockResolvedValue({ before: null, after: "QUZURVI=", tooLarge: false });
    const { result } = renderHook(() =>
      useSourceImageSides("/wt/story", null, "new.webp", undefined, undefined),
    );
    await waitFor(() => expect(result.current).toEqual({ after: "QUZURVI=" }));
  });

  it("has no bytes past the size cap or when the read fails, so the diff stays Source only", async () => {
    read.mockResolvedValue({ before: "QkVGT1JF", after: null, tooLarge: true });
    const big = renderHook(() => useSourceImageSides(LOCAL, null, "big.png", undefined, undefined));
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(big.result.current).toBeUndefined();
    read.mockRejectedValue(new Error("Access denied"));
    const denied = renderHook(() =>
      useSourceImageSides(LOCAL, null, "x.png", undefined, undefined),
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(denied.result.current).toBeUndefined();
  });

  it("reads nothing for an SVG, a text file, no selection or a remote worktree", () => {
    for (const path of ["logo.svg", "page.html", "a.ts", null])
      renderHook(() => useSourceImageSides(LOCAL, null, path, undefined, undefined));
    renderHook(() =>
      useSourceImageSides(
        { kind: "remote", machineId: "m1", handle: "ws-1" },
        null,
        "logo.png",
        undefined,
        undefined,
      ),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("drops the previous file's sides on a file switch", async () => {
    let resolve: (v: Awaited<ReturnType<typeof sourceFileImageSides>>) => void = () => {};
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSourceImageSides(LOCAL, null, path, undefined, undefined),
      { initialProps: { path: "a.png" } },
    );
    await waitFor(() => expect(result.current).toBeDefined());
    read.mockImplementation(() => new Promise((ok) => (resolve = ok)));
    rerender({ path: "b.png" });
    expect(result.current).toBeUndefined();
    resolve({ before: "Qg==", after: "Qg==", tooLarge: false });
    await waitFor(() => expect(result.current).toEqual({ before: "Qg==", after: "Qg==" }));
  });
});

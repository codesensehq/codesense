// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("@/features/git-sync/lib/source-redline-source", () => ({
  sourceFileImageSides: vi.fn(),
  sourceRemoteImageSides: vi.fn(),
}));

import {
  sourceFileImageSides,
  sourceRemoteImageSides,
} from "@/features/git-sync/lib/source-redline-source";
import { IMAGE_UNAVAILABLE } from "@/shared/lib/render-file-diff";
import { useSourceImageSides } from "./use-source-image-sides";

const read = vi.mocked(sourceFileImageSides);
const readRemote = vi.mocked(sourceRemoteImageSides);
const REMOTE = { kind: "remote", machineId: "m1", handle: "ws-1" } as const;
const LOCAL = { kind: "local", cwd: "/wt/story" } as const;

beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue({ before: "QkVGT1JF", after: "QUZURVI=", tooLarge: false });
  readRemote.mockReset();
  readRemote.mockResolvedValue({ before: "QkVGT1JF", after: "QUZURVI=", tooLarge: false });
});

describe("useSourceImageSides", () => {
  const ready = (imageBytes: object) => ({ imageBytes });
  it("reads a local raster file's sides at the working tree, then at a commit", async () => {
    const { result, rerender } = renderHook(
      ({ sha }: { sha: string | null }) =>
        useSourceImageSides(LOCAL, sha, "art/logo.png", "art/old.png", "main"),
      { initialProps: { sha: null as string | null } },
    );
    expect(result.current).toEqual({ imageState: { kind: "reading" } });
    await waitFor(() =>
      expect(result.current).toEqual(ready({ before: "QkVGT1JF", after: "QUZURVI=" })),
    );
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
    await waitFor(() => expect(result.current).toEqual(ready({ after: "QUZURVI=" })));
  });

  it("reads a remote worktree's raster sides through its machine, at the working tree only", async () => {
    const { result } = renderHook(() =>
      useSourceImageSides(REMOTE, null, "art/logo.png", "art/old.png", "main"),
    );
    expect(result.current).toEqual({ imageState: { kind: "reading" } });
    await waitFor(() =>
      expect(result.current).toEqual(ready({ before: "QkVGT1JF", after: "QUZURVI=" })),
    );
    expect(readRemote).toHaveBeenCalledWith(REMOTE, "art/logo.png", {
      oldPath: "art/old.png",
      baseRef: "main",
    });
    expect(read).not.toHaveBeenCalled();
    // Past the cap, or a read the machine refused, says why, as a local read does.
    readRemote.mockResolvedValue({ before: null, after: null, tooLarge: true });
    const big = renderHook(() =>
      useSourceImageSides(REMOTE, null, "big.png", undefined, undefined),
    );
    await waitFor(() =>
      expect(big.result.current).toEqual({
        imageState: { kind: "unavailable", reason: IMAGE_UNAVAILABLE.tooLarge },
      }),
    );
    readRemote.mockRejectedValue({ kind: "transportFailure", message: "not a raster image" });
    const refused = renderHook(() =>
      useSourceImageSides(REMOTE, null, "fake.png", undefined, undefined),
    );
    await waitFor(() =>
      expect(refused.result.current).toEqual({
        imageState: { kind: "unavailable", reason: IMAGE_UNAVAILABLE.failed },
      }),
    );
    // A remote worktree has no commit view to read an image at.
    readRemote.mockClear();
    const atCommit = renderHook(() =>
      useSourceImageSides(REMOTE, "abc123", "logo.png", undefined, undefined),
    );
    expect(atCommit.result.current).toEqual({
      imageState: { kind: "unavailable", reason: IMAGE_UNAVAILABLE.remote },
    });
    expect(readRemote).not.toHaveBeenCalled();
  });

  it("says why there are no bytes: past the size cap or a failed read", async () => {
    read.mockResolvedValue({ before: "QkVGT1JF", after: null, tooLarge: true });
    const big = renderHook(() => useSourceImageSides(LOCAL, null, "big.png", undefined, undefined));
    await waitFor(() =>
      expect(big.result.current).toEqual({
        imageState: { kind: "unavailable", reason: IMAGE_UNAVAILABLE.tooLarge },
      }),
    );
    read.mockRejectedValue(new Error("Access denied"));
    const denied = renderHook(() =>
      useSourceImageSides(LOCAL, null, "x.png", undefined, undefined),
    );
    await waitFor(() =>
      expect(denied.result.current).toEqual({
        imageState: { kind: "unavailable", reason: IMAGE_UNAVAILABLE.failed },
      }),
    );
  });

  it("reads nothing, and says nothing, for an SVG, a text file or no selection", () => {
    for (const path of ["logo.svg", "page.html", "a.ts", null]) {
      const { result } = renderHook(() =>
        useSourceImageSides(LOCAL, null, path, undefined, undefined),
      );
      expect(result.current).toEqual({});
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("drops the previous file's sides on a file switch, reading again", async () => {
    let resolve: (v: Awaited<ReturnType<typeof sourceFileImageSides>>) => void = () => {};
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useSourceImageSides(LOCAL, null, path, undefined, undefined),
      { initialProps: { path: "a.png" } },
    );
    await waitFor(() => expect(result.current.imageBytes).toBeDefined());
    read.mockImplementation(() => new Promise((ok) => (resolve = ok)));
    rerender({ path: "b.png" });
    expect(result.current).toEqual({ imageState: { kind: "reading" } });
    resolve({ before: "Qg==", after: "Qg==", tooLarge: false });
    await waitFor(() => expect(result.current).toEqual(ready({ before: "Qg==", after: "Qg==" })));
  });
});

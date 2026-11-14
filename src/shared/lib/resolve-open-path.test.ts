// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { resolveOpenPath } from "./resolve-open-path";

describe("resolveOpenPath", () => {
  it("keeps an admitted literal path, '#' and all", async () => {
    const resolve = vi.fn(async (p: string) => p);
    expect(await resolveOpenPath("notes/a#b.md", resolve)).toEqual({ target: "notes/a#b.md" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("retries the part before '#' and returns the rest as the hash", async () => {
    const resolve = vi.fn(async (p: string) => {
      if (p.includes("#")) throw new Error("not-found: notes/plan.md#goals");
      return p;
    });
    expect(await resolveOpenPath("notes/plan.md#goals", resolve)).toEqual({
      target: "notes/plan.md",
      hash: "#goals",
    });
  });

  it("rethrows the refusal of a path with no '#'", async () => {
    await expect(
      resolveOpenPath("x.md", () => Promise.reject(new Error("refused: x.md"))),
    ).rejects.toThrow("refused: x.md");
  });
});

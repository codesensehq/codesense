// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { rootWatchKey } from "./worktree-watch-key";

describe("rootWatchKey", () => {
  it("keys the root apart from the workspace id", () => {
    expect(rootWatchKey("w1")).toBe("w1|root");
    expect(rootWatchKey("w1")).not.toBe("w1");
  });
});

// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { recordInvokes } from "./mock-backend";

describe("recordInvokes", () => {
  it("logs each command name in order and still answers through the router", async () => {
    const router = vi.fn(async (cmd: string) => `${cmd}:ok`);
    const log: string[] = [];
    const recorded = recordInvokes(router, log);

    await expect(recorded("load_app_state", { a: 1 })).resolves.toBe("load_app_state:ok");
    await recorded("save_app_state");

    expect(log).toEqual(["load_app_state", "save_app_state"]);
    expect(router).toHaveBeenCalledWith("load_app_state", { a: 1 });
  });

  it("logs a command the router rejects", async () => {
    const log: string[] = [];
    const recorded = recordInvokes(() => Promise.reject(new Error("not mocked")), log);
    await expect(recorded("push_viewer_state")).rejects.toThrow("not mocked");
    expect(log).toEqual(["push_viewer_state"]);
  });
});

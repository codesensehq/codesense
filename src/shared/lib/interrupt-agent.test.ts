// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentSessionRow } from "@/tauri/commands";

const writePty = vi.hoisted(() => vi.fn(async (_session: string, _data: string) => {}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/tauri/commands", () => ({ LOCAL_MACHINE_ID: "local", writePty }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { hasInterrupt, interruptAgent } from "./interrupt-agent";

type Row = Pick<AgentSessionRow, "kind" | "sessionId" | "alive" | "hasAgent" | "machineId">;
const live: Row = {
  kind: "dashboard-launched",
  sessionId: "s1",
  alive: true,
  hasAgent: true,
  machineId: null,
};

beforeEach(() => {
  writePty.mockClear();
  toastError.mockClear();
});

describe("interruptAgent", () => {
  it.each<[string, Row, AgentRuntime, boolean]>([
    ["live claude", live, "claude", true],
    ["live codex", live, "codex", true],
    ["opencode", live, "opencode", false],
    ["hermes", live, "hermes", false],
    ["headless claude", { ...live, kind: "headless" }, "claude", false],
    ["no session", { ...live, sessionId: null }, "claude", false],
    ["ended", { ...live, alive: false }, "claude", false],
    ["registered claude", { ...live, kind: "registered" }, "claude", true],
    ["this Mac by id", { ...live, machineId: "local" }, "claude", true],
    ["remote machine", { ...live, machineId: "m-1" }, "claude", false],
    ["shell", { ...live, hasAgent: false }, "claude", false],
    ["hasAgent absent", { ...live, hasAgent: undefined }, "claude", false],
  ])("%s", (_name, row, runtime, expected) => {
    expect(hasInterrupt(row, runtime)).toBe(expected);
    interruptAgent(row, runtime);
    if (expected) {
      expect(writePty).toHaveBeenCalledTimes(1);
      expect(writePty).toHaveBeenCalledWith("s1", "\x1b");
    } else {
      expect(writePty).not.toHaveBeenCalled();
    }
  });

  it("tells the person when the write fails, and never throws", async () => {
    writePty.mockRejectedValueOnce(new Error("gone"));
    interruptAgent(live, "claude");
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't interrupt the agent"));
  });
});

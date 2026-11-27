// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, AgentSessionRow } from "@/tauri/commands";

const writePty = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/tauri/commands", () => ({ writePty }));

import { hasInterrupt, interruptAgent } from "./interrupt-agent";

type Row = Pick<AgentSessionRow, "kind" | "sessionId" | "alive" | "hasAgent">;
const live: Row = { kind: "terminal", sessionId: "s1", alive: true, hasAgent: true };

beforeEach(() => writePty.mockClear());

describe("interruptAgent", () => {
  it.each<[string, Row, AgentRuntime, boolean]>([
    ["live claude", live, "claude", true],
    ["live codex", live, "codex", true],
    ["opencode", live, "opencode", false],
    ["hermes", live, "hermes", false],
    ["headless claude", { ...live, kind: "headless" }, "claude", false],
    ["no session", { ...live, sessionId: null }, "claude", false],
    ["ended", { ...live, alive: false }, "claude", false],
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
});

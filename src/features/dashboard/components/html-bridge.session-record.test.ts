// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn().mockResolvedValue({ handle: "agent-1", sessionId: "s1" }));
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  sessionRecord: read,
}));
import { HTML_BRIDGE_ALLOWLIST as bridge } from "./html-bridge";
it("sessionRecord forwards the handle and frame identity to the Tauri reader", async () => {
  const result = await bridge.sessionRecord({ handle: " agent-1 " }, {
    docPath: "/team/page.html",
    frame: { frameId: "child" },
  } as never);
  expect(read).toHaveBeenCalledWith({ handle: "agent-1" }, "child", "/team/page.html");
  expect(result).toEqual({ handle: "agent-1", sessionId: "s1" });
});
it("sessionRecord refuses a missing handle and unknown fields", () => {
  expect(() => bridge.sessionRecord({})).toThrow(/handle/);
  expect(() => bridge.sessionRecord({ handle: "" })).toThrow(/handle/);
  expect(() => bridge.sessionRecord({ handle: 7 })).toThrow(/handle/);
  expect(() => bridge.sessionRecord({ handle: "a", limit: 5 })).toThrow(
    "sessionRecord: unknown field",
  );
});

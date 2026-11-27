// SPDX-License-Identifier: MIT
import { beforeEach, expect, it, vi } from "vitest";
const reads = vi.hoisted(() => ({
  count: vi.fn().mockResolvedValue({ count: 2 }),
  list: vi.fn().mockResolvedValue({ messages: [], humanUnread: 0 }),
}));
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  agentReadNeedsYouCount: reads.count,
  agentReadInbox: reads.list,
}));
import { HTML_BRIDGE_ALLOWLIST as bridge } from "./html-bridge";

const team = { org: "acme", team: "core" };

beforeEach(() => {
  reads.count.mockClear();
  reads.list.mockClear();
});

it("countOnly calls agent_read_needs_you_count and refuses list arguments", async () => {
  await expect(bridge.inbox({ ...team, kind: "needs-you", countOnly: true })).resolves.toEqual({
    count: 2,
  });
  expect(reads.count).toHaveBeenCalledWith(team);
  expect(reads.list).not.toHaveBeenCalled();

  for (const [extra, refused] of [
    [{ before: 5 }, "before"],
    [{ limit: 10 }, "limit"],
    [{ conversation: "worker" }, "conversation"],
    [{ agentId: "a", storyId: "" }, "storyId, agentId"],
    [{ story: "S" }, "story"],
    [{ sessionId: "s" }, "sessionId"],
    [{ role: "qa" }, "role"],
    [{ scope: "all" }, "scope"],
  ] as const) {
    await expect(
      bridge.inbox({ ...team, kind: "needs-you", countOnly: true, ...extra }),
    ).rejects.toThrow(`inbox: countOnly takes no ${refused}`);
  }
  await expect(bridge.inbox({ ...team, countOnly: true })).rejects.toThrow(
    'inbox: countOnly needs kind: "needs-you"',
  );
  await expect(bridge.inbox({ ...team, kind: "update", countOnly: true })).rejects.toThrow(
    'inbox: countOnly needs kind: "needs-you"',
  );
  await expect(bridge.inbox({ ...team, kind: "needs-you", countOnly: false })).rejects.toThrow(
    "inbox: countOnly must be true",
  );
  expect(reads.count).toHaveBeenCalledTimes(1);
  expect(reads.list).not.toHaveBeenCalled();

  // Without countOnly the verb lists, as before.
  await bridge.inbox({ ...team, kind: "needs-you", limit: 3 });
  expect(reads.list).toHaveBeenCalledWith(team, { kind: "needs-you", limit: 3 });
});

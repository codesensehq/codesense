// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockEventBus } from "../mock-events";
import { CHAT_MEDIA_WS } from "../chat-media-fixtures";
import { workspaceChatMediaHandlers } from "./workspace-chat-media";
import type { WorkspaceChatReadResult } from "@/tauri/commands";

describe("workspaceChatMediaHandlers load", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const row = (h: ReturnType<typeof workspaceChatMediaHandlers>, id: number) =>
    (
      h.workspace_chat_read({ workspaceId: CHAT_MEDIA_WS, since: 0 }) as WorkspaceChatReadResult
    ).messages.find((m) => m.messageId === id)!;

  it("holds the row at tap to load while it fetches, then caches it, emits once and resolves", async () => {
    const events = new MockEventBus();
    const seen: unknown[] = [];
    events.observe("codesense:workspace-chat-media", (p) => seen.push(p));
    const h = workspaceChatMediaHandlers(events);
    let done = false;
    const load = Promise.resolve(
      h.load_workspace_chat_media({ workspaceId: CHAT_MEDIA_WS, messageId: 4 }),
    ).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(row(h, 4).mediaState).toBe("tapToLoad");
    expect(seen).toEqual([]);
    await vi.runAllTimersAsync();
    await load;
    expect(row(h, 4).mediaState).toBe("cached");
    expect(row(h, 4).attachments?.[0]).toMatchObject({ state: "cached", width: 480 });
    expect(seen).toEqual([{ workspaceId: CHAT_MEDIA_WS, messageId: 4 }]);
  });
});

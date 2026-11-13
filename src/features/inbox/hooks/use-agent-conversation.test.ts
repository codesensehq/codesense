// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { renderHook } from "@/test-utils";
import type { ConversationMessage } from "@/tauri/commands";

import type { SessionInboxDto } from "../api";
import { useAgentConversation } from "./use-agent-conversation";

vi.mock("@/shared/lib/get-current-user", () => ({ useCurrentUser: () => null }));
vi.mock("./use-inbox-sessions", () => ({ useInboxSessions: () => null }));

const HANDLE = "BUG-1#lead";
const WIDGETS = { org: "acme", team: "widgets" };
const CORE = { org: "acme", team: "core" };

const msg = (id: number, team: typeof WIDGETS, from: string, to: string, at: number) =>
  ({
    id,
    team,
    from,
    fromName: from,
    to,
    toName: to,
    toRole: null,
    text: `message ${id}`,
    contentType: null,
    createdAtMs: at,
    archivedAtMs: null,
    inReplyTo: null,
    via: null,
    replyTo: null,
    summary: null,
    unread: false,
    delivery: null,
    kind: "update",
  }) as ConversationMessage;

const read = (...messages: ConversationMessage[]): SessionInboxDto => ({
  handle: HANDLE,
  roles: [],
  messages,
});

const props = (data: SessionInboxDto | null, chatKey = "chat-a") => ({
  data,
  source: "live" as const,
  handle: HANDLE,
  teamKey: "acme:widgets",
  chatKey,
});

describe("useAgentConversation", () => {
  it("keeps the first read's team while the chat shows the same agent", () => {
    const first = read(msg(1, WIDGETS, HANDLE, "human", 1));
    const { result, rerender } = renderHook((p) => useAgentConversation(p), {
      initialProps: props(first),
    });
    expect(result.current.team).toEqual(WIDGETS);
    // The agent writes in another team later: the chat, and where a send goes, stay put.
    rerender(props(read(msg(1, WIDGETS, HANDLE, "human", 1), msg(2, CORE, HANDLE, "human", 9))));
    expect(result.current.team).toEqual(WIDGETS);
    expect(result.current.teamMessages.map((m) => m.id)).toEqual([1]);
    expect(result.current.conversation.map((m) => m.id)).toEqual([1]);
  });

  it("settles on the other team again for another chat", () => {
    const both = read(msg(1, WIDGETS, HANDLE, "human", 1), msg(2, CORE, HANDLE, "human", 9));
    const { result, rerender } = renderHook((p) => useAgentConversation(p), {
      initialProps: props(read(msg(1, WIDGETS, HANDLE, "human", 1))),
    });
    expect(result.current.team).toEqual(WIDGETS);
    rerender({ ...props(both, "chat-b"), teamKey: "acme:other" });
    // `acme:other` wrote nothing: the agent's latest team is the one the new chat settles on.
    expect(result.current.team).toEqual(CORE);
  });

  it("has no team before anything is read, and falls back to the pane's", () => {
    const { result } = renderHook((p) => useAgentConversation(p), { initialProps: props(null) });
    expect(result.current.team).toEqual(WIDGETS);
    expect(result.current.home).toEqual(WIDGETS);
    expect(result.current.conversation).toEqual([]);
  });
});

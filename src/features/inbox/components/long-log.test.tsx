// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, render, screen, waitFor, within } from "@/test-utils";
import { invoke } from "@tauri-apps/api/core";
import { useAgentInboxRailStore } from "@/features/viewer/stores/agent-inbox-rail-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { AGENT_INBOX_CHANGED_EVENT } from "@/tauri/events";
import type { AgentSessionRow, ConversationMessage } from "@/tauri/commands";

import type { SessionInboxDto } from "../api";
import { useInboxSessionsStore } from "../hooks/use-inbox-sessions";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => undefined),
}));
const events = vi.hoisted(() => new Map<string, ((event: { payload: unknown }) => void)[]>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.set(name, [...(events.get(name) ?? []), handler]);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

const api = vi.hoisted(() => ({
  loadSessionInbox: vi.fn(),
  loadInboxSessions: vi.fn(),
  sendAsHuman: vi.fn(),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), ...api }));

vi.mock("@/features/shell/slots/reveal-slot", async (orig) => ({
  ...(await orig<typeof import("@/features/shell/slots/reveal-slot")>()),
  useSlotTarget: () => ({ activate: () => {} }),
}));

import { ChatOverlay } from "./chat-overlay";
import { clearInboxDrafts } from "./inbox-view-context";

// Long logs: the agent's chat (a tab's overlay and its quick popover share the Conversation)
// opens at its newest message, follows new mail while you are at the bottom, keeps a reader
// who scrolled up in place, and offers "Jump to latest" when mail lands below them.

/**
 * happy-dom lays nothing out, so give the conversation scroller a 100px viewport, a content
 * height, and a scrollTop that clamps and fires `scroll` the way a browser does.
 */
const VIEW = 100;
const top = new WeakMap<Element, number>();
const isScroller = (el: Element) => el.classList?.contains("ibx-msgs");
const contentHeight = (el: Element) => Math.max(VIEW, el.children.length * 40);
const maxTop = (el: Element) => contentHeight(el) - VIEW;
function setTop(el: Element, v: number) {
  top.set(el, Math.max(0, Math.min(v, maxTop(el))));
  el.dispatchEvent(new Event("scroll"));
}
const saved: [string, PropertyDescriptor | undefined][] = [];
beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const orig = (k: string) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, k) ??
    Object.getOwnPropertyDescriptor(Element.prototype, k);
  const define = (k: string, d: PropertyDescriptor) => {
    saved.push([k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)]);
    Object.defineProperty(proto, k, { configurable: true, ...d });
  };
  const st = orig("scrollTop");
  define("scrollTop", {
    get(this: HTMLElement) {
      return isScroller(this) ? (top.get(this) ?? 0) : st?.get?.call(this);
    },
    set(this: HTMLElement, v: number) {
      if (isScroller(this)) setTop(this, v);
      else st?.set?.call(this, v);
    },
  });
  const sh = orig("scrollHeight");
  define("scrollHeight", {
    get(this: HTMLElement) {
      return isScroller(this) ? contentHeight(this) : sh?.get?.call(this);
    },
  });
  const ch = orig("clientHeight");
  define("clientHeight", {
    get(this: HTMLElement) {
      return isScroller(this) ? VIEW : ch?.get?.call(this);
    },
  });
  // A conversation's children sit 40px apart; its own top is 0.
  const rect = orig("getBoundingClientRect") ?? {
    value: Element.prototype.getBoundingClientRect,
  };
  define("getBoundingClientRect", {
    value(this: HTMLElement) {
      const parent = this.parentElement;
      if (this.classList.contains("ibx-msgs")) return new DOMRect(0, 0, 300, VIEW);
      if (parent?.classList.contains("ibx-msgs")) {
        const i = Array.prototype.indexOf.call(parent.children, this);
        return new DOMRect(0, i * 40 - parent.scrollTop, 300, 40);
      }
      return (rect.value as () => DOMRect).call(this);
    },
    writable: true,
  });
  const scrollTo = proto.scrollTo as ((...a: unknown[]) => void) | undefined;
  define("scrollTo", {
    value(this: HTMLElement, a: ScrollToOptions | number, b?: number) {
      if (!isScroller(this)) return scrollTo?.call(this, a, b);
      setTop(this, typeof a === "number" ? (b ?? 0) : (a.top ?? top.get(this) ?? 0));
    },
    writable: true,
  });
});
afterAll(() => {
  for (const [k, d] of saved.reverse()) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

const TEAM = { org: "acme", team: "widgets" };
const TEAM_KEY = "acme:widgets";
const LEAD = "BUG-142#lead";
const SESSION = "sess-login-lead";

/** `n` lines from the agent to you, fifteen minutes apart, ending now. */
function longInbox(n: number, now = Date.now()): SessionInboxDto {
  const messages = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    team: TEAM,
    from: LEAD,
    fromName: "Login timeout lead",
    to: "human",
    toName: "You",
    toRole: null,
    text: `line ${i + 1}`,
    contentType: null,
    createdAtMs: now - (n - 1 - i) * 15 * 60_000,
    archivedAtMs: null,
    inReplyTo: null,
    via: null,
    replyTo: null,
    summary: null,
    unread: false,
    delivery: null,
    kind: "update",
  })) as ConversationMessage[];
  return { handle: LEAD, roles: [], messages };
}

function more(dto: SessionInboxDto, ...lines: Partial<ConversationMessage>[]): SessionInboxDto {
  const last = dto.messages.at(-1)!;
  return {
    ...dto,
    messages: [
      ...dto.messages,
      ...lines.map((l, i) => ({
        ...last,
        id: last.id + i + 1,
        text: `new ${i + 1}`,
        createdAtMs: last.createdAtMs + (i + 1) * 1000,
        unread: true,
        ...l,
      })),
    ],
  };
}

function inbox(dto: SessionInboxDto) {
  api.loadSessionInbox.mockResolvedValue({ dto, source: "live" });
}

/** Fire the inbox-changed event the overlay listens for, as the backend would. */
async function refresh() {
  await act(async () => {
    for (const handler of events.get(AGENT_INBOX_CHANGED_EVENT) ?? []) handler({ payload: {} });
  });
}

async function renderOverlay() {
  render(
    <ChatOverlay
      tabId="tab-1"
      sessionId={SESSION}
      teamKey={TEAM_KEY}
      composeRequest={0}
      size={{ width: 420, height: 700 }}
      placement="dock"
    />,
  );
  return screen.findByTestId("ibx-msgs");
}

const atEnd = (el: Element) => el.scrollTop === maxTop(el);

beforeEach(() => {
  clearInboxDrafts();
  vi.clearAllMocks();
  events.clear();
  useInboxSessionsStore.setState({ sessions: null });
  useAgentInboxRailStore.setState({ bySession: {} });
  useAgentStateStore.setState({
    bySession: {},
    activityBySession: {},
    exitBySession: {},
    processAgentBySession: { [SESSION]: "claude" },
  });
  useAgentListProjectionStore.setState({
    sessions: [
      {
        handle: LEAD,
        sessionId: SESSION,
        kind: "claude",
        alive: true,
        displayName: "Login timeout lead",
        agentRevision: "builtin/claude@13",
        story: "BUG-142",
        role: "story lead",
        startedAtMs: Date.now() - 41 * 60_000,
      } as AgentSessionRow,
    ],
  });
  api.loadInboxSessions.mockResolvedValue([]);
  api.sendAsHuman.mockResolvedValue({ status: "sent", messageId: 99 });
  vi.mocked(invoke).mockImplementation(async () => undefined);
});

describe("ChatOverlay on a long log", () => {
  it("opens at the newest message and offers Jump to latest when mail lands below a reader", async () => {
    const dto = longInbox(30);
    inbox(dto);
    const msgs = await renderOverlay();
    await waitFor(() => expect(msgs.querySelectorAll(".ibx-m").length).toBe(30));
    expect(atEnd(msgs)).toBe(true);
    act(() => setTop(msgs, 0));
    inbox(more(dto, {}));
    await refresh();
    const jump = await screen.findByRole("button", { name: /Jump to latest/ });
    expect(jump).toHaveTextContent("1 new");
    expect(msgs.scrollTop).toBe(0);
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId("ibx-arrivals")).getByText(/New message from/),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
    fireEvent.click(jump);
    await waitFor(() => expect(atEnd(msgs)).toBe(true));
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
    // Focus lands on the conversation, not the page body, as the pill goes.
    expect(msgs).toHaveFocus();
  });

  it("opens 500 messages at the newest, and follows at the cap, where one arrives as the oldest leaves", async () => {
    const dto = longInbox(500);
    inbox(dto);
    const msgs = await renderOverlay();
    await waitFor(() => expect(atEnd(msgs)).toBe(true));
    expect(msgs.querySelector('[data-mid="acme/widgets#500"]')).not.toBeNull();
    const next = more(dto, {});
    inbox({ ...next, messages: next.messages.slice(1) });
    await refresh();
    await waitFor(() => expect(msgs.querySelector('[data-mid="acme/widgets#501"]')).not.toBeNull());
    expect(atEnd(msgs)).toBe(true);
  });

  it.each([
    {
      name: "a day divider leads the viewport at 04:22",
      now: new Date(2026, 9, 10, 4, 22).getTime(),
      expectedKind: ".ibx-day",
      expectedTop: 40,
    },
    {
      name: "a message leads the viewport at noon",
      now: new Date(2026, 9, 10, 12, 0).getTime(),
      expectedKind: "[data-mid]",
      expectedTop: 0,
    },
  ])(
    "keeps a scrolled-up reader's message in place when the oldest is trimmed (no CSS anchoring): $name",
    async ({ now, expectedKind, expectedTop }) => {
      const dto = longInbox(500, now);
      inbox(dto);
      const msgs = await renderOverlay();
      await waitFor(() => expect(atEnd(msgs)).toBe(true));
      act(() => setTop(msgs, 4000));
      expect(msgs.children[100]!.matches(expectedKind)).toBe(true);
      const topOf = (mid: string) =>
        msgs.querySelector(`[data-mid="${mid}"]`)!.getBoundingClientRect().top;
      const viewport = msgs.getBoundingClientRect();
      const visibleMessage = [...msgs.querySelectorAll("[data-mid]")].find((message) => {
        const rect = message.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      expect(visibleMessage).toBeDefined();
      const visibleRect = visibleMessage!.getBoundingClientRect();
      expect(visibleRect.top - viewport.top).toBe(expectedTop);
      const reading = visibleMessage!.getAttribute("data-mid");
      expect(reading).not.toBeNull();
      const at = topOf(reading!);
      const next = more(dto, {});
      inbox({ ...next, messages: next.messages.slice(1) });
      await refresh();
      await waitFor(() =>
        expect(msgs.querySelector('[data-mid="acme/widgets#501"]')).not.toBeNull(),
      );
      expect(msgs.querySelector('[data-mid="acme/widgets#1"]')).toBeNull();
      expect(topOf(reading!)).toBe(at);
      expect(await screen.findByRole("button", { name: /Jump to latest/ })).toHaveTextContent(
        "1 new",
      );
    },
  );

  it("shows what you just sent even when you had scrolled up", async () => {
    const dto = longInbox(30);
    inbox(dto);
    const msgs = await renderOverlay();
    await waitFor(() => expect(atEnd(msgs)).toBe(true));
    act(() => setTop(msgs, 0));
    inbox(more(dto, { from: "human", fromName: "You", to: LEAD, toName: "Login timeout lead" }));
    await refresh();
    await waitFor(() => expect(atEnd(msgs)).toBe(true));
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  });
});

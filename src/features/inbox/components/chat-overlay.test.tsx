// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, render, screen, waitFor, within } from "@/test-utils";
import { invoke } from "@tauri-apps/api/core";
import {
  openAgentInboxRail,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { AGENT_RUNTIMES } from "@/shared/lib/agent-runtimes";
import { AGENT_PINS_CHANGED_EVENT } from "@/tauri/events";
import type { AgentPin, AgentSessionRow, ConversationMessage } from "@/tauri/commands";

import { useInboxSessionsStore } from "../hooks/use-inbox-sessions";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => undefined),
}));
const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.set(name, handler);
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

const opened = vi.hoisted(() => vi.fn());
vi.mock("@/features/shell/slots/reveal-slot", async (orig) => ({
  ...(await orig<typeof import("@/features/shell/slots/reveal-slot")>()),
  useSlotTarget: (_slot: string, options: unknown) => ({ activate: () => opened(options) }),
}));

vi.mock("./group-chat", async (orig) => ({
  ...(await orig<typeof import("./group-chat")>()),
  GroupChatPane: (p: {
    room: { workspaceId: string };
    onBack?: () => void;
    focusRequest?: number;
  }) => (
    <div data-testid="group-pane" data-room={p.room.workspaceId} data-focus={p.focusRequest}>
      <button onClick={p.onBack}>Back to the inbox</button>
    </div>
  ),
}));

import { ChatOverlay } from "./chat-overlay";
import { clearInboxDrafts } from "./inbox-view-context";

const TEAM = { org: "acme", team: "widgets" };
const TEAM_KEY = "acme:widgets";
const LEAD = "BUG-142#lead";
const SESSION = "sess-login-lead";
const NOW = new Date("2026-11-12T15:00:00Z").getTime();

const msg = (id: number, from: string, to: string, text: string, extra = {}): ConversationMessage =>
  ({
    id,
    team: TEAM,
    from,
    fromName: from === "human" ? "You" : "Login timeout lead",
    to,
    toName: to,
    toRole: null,
    text,
    contentType: null,
    createdAtMs: NOW - (100 - id) * 60_000,
    archivedAtMs: null,
    inReplyTo: null,
    via: null,
    replyTo: null,
    summary: null,
    unread: false,
    delivery: null,
    kind: "update",
    ...extra,
  }) as ConversationMessage;

const MESSAGES = [
  msg(1, LEAD, "human", "Starting on the refresh timeout."),
  msg(2, "human", LEAD, "Thanks, keep me posted."),
  msg(3, LEAD, "human", "QA: 5 of 5 ACs traced", { summary: "QA trace" }),
  msg(4, LEAD, "human", "Review is clean; merge card is next."),
];

const PINS: AgentPin[] = [
  {
    messageId: 3,
    position: 0,
    pinnedBy: LEAD,
    pinnedAtMs: NOW,
    preview: {
      shortName: "QA",
      value: "5 of 5",
      unit: "ACs",
      status: "on-track",
      lines: ["R2 clean"],
    },
    previewAtMs: NOW,
  },
  {
    messageId: 1,
    position: 1,
    pinnedBy: LEAD,
    pinnedAtMs: NOW,
    preview: { shortName: "Tests", value: "48", status: "not-updating" },
    previewAtMs: new Date(2026, 10, 12, 14, 5).getTime(),
  },
];

function roster(extra: Partial<AgentSessionRow> = {}) {
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
        startedAtMs: NOW - 41 * 60_000,
        ...extra,
      } as AgentSessionRow,
    ],
  });
}

async function renderOverlay(width: number, height: number, placement: "dock" | "cover" = "cover") {
  const utils = render(
    <ChatOverlay
      tabId="tab-1"
      sessionId={SESSION}
      teamKey={TEAM_KEY}
      composeRequest={0}
      size={{ width, height }}
      placement={placement}
    />,
  );
  await screen.findByText("Review is clean; merge card is next.");
  return utils;
}

beforeEach(() => {
  clearInboxDrafts();
  vi.clearAllMocks();
  events.clear();
  useInboxSessionsStore.setState({ sessions: null });
  useAgentInboxRailStore.setState({ bySession: {} });
  // The chat opens only on a running agent.
  useAgentStateStore.setState({
    bySession: {},
    activityBySession: {},
    exitBySession: {},
    processAgentBySession: { [SESSION]: "claude" },
  });
  roster();
  api.loadSessionInbox.mockResolvedValue({
    dto: { handle: LEAD, roles: [], messages: MESSAGES },
    source: "live",
  });
  api.loadInboxSessions.mockResolvedValue([]);
  api.sendAsHuman.mockResolvedValue({ status: "sent", messageId: 99 });
  vi.mocked(invoke).mockImplementation(async (cmd: string) =>
    cmd === "agent_pins"
      ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: PINS }
      : undefined,
  );
});

describe("ChatOverlay", () => {
  it("shows that agent's chat at its newest message, and sends to the agent from its composer", async () => {
    await renderOverlay(420, 700, "dock");
    const msgs = screen.getByTestId("ibx-msgs");
    // The thread reads oldest to newest, and the last line is the agent's newest message.
    const shown = Array.from(msgs.querySelectorAll(".ibx-m"));
    expect(shown.length).toBeGreaterThanOrEqual(3);
    expect(shown.at(-1)).toHaveTextContent("Review is clean; merge card is next.");
    expect(shown[0]).toHaveTextContent("Starting on the refresh timeout.");
    const box = screen.getByRole("textbox");
    expect(box).toBeEnabled();
    fireEvent.change(box, { target: { value: "Ship it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.sendAsHuman).toHaveBeenCalled());
    expect(api.sendAsHuman.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining(TEAM), LEAD, "Ship it"]),
    );
  });

  it("reads the pins of its saved agent and story", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    expect(invoke).toHaveBeenCalledWith(
      "agent_pins",
      expect.objectContaining({ team: TEAM, agentId: "builtin/claude", storyId: "BUG-142" }),
    );
  });

  it.each([
    [
      250,
      250,
      { width: "XS", height: "short", head: "one-line", pins: "line", record: "own-line" },
    ],
    [300, 700, { width: "XS", height: "tall", head: "two-line", pins: "rows", record: "own-line" }],
    [900, 250, { width: "L", height: "short", head: "one-line", pins: "rail", record: "in-head" }],
    [
      640,
      480,
      { width: "M", height: "medium", head: "two-line", pins: "tiles", record: "own-line" },
    ],
  ])("lays out a %i × %i pane by the design's breakpoints", async (w, h, want) => {
    await renderOverlay(w, h);
    const root = screen.getByTestId("chat-overlay");
    for (const [k, v] of Object.entries(want)) expect(root).toHaveAttribute(`data-${k}`, v);
    await screen.findByTestId("chat-overlay-pin-3");
  });

  it("draws each pin as its preview: short name and value; a stopped pin says since when", async () => {
    await renderOverlay(250, 250);
    const qa = await screen.findByTestId("chat-overlay-pin-3");
    expect(qa).toHaveTextContent("QA");
    expect(qa).toHaveTextContent("5 of 5");
    expect(qa).toHaveAttribute("data-status", "on-track");
    const tests = screen.getByTestId("chat-overlay-pin-1");
    expect(tests).toHaveAttribute("data-status", "stopped");
    expect(tests).toHaveTextContent("stopped 14:05");
  });

  it("puts the status word ahead of the record line in a narrow one-line head", async () => {
    await renderOverlay(250, 250);
    const record = screen.getByTestId("chat-overlay-record");
    expect(record).toHaveTextContent("BUG-142");
    expect(record).not.toHaveTextContent("41m");
  });

  it("opens a pin in a sheet above the chat on a tall pane; Escape closes it and focus returns to the pin", async () => {
    await renderOverlay(300, 700);
    const pin = await screen.findByTestId("chat-overlay-pin-3");
    fireEvent.click(pin);
    const sheet = screen.getByRole("region", { name: /QA/ });
    expect(within(sheet).getByText("QA: 5 of 5 ACs traced")).toBeInTheDocument();
    expect(screen.getByTestId("ibx-msgs")).toBeInTheDocument();
    expect(screen.getByTestId("chat-overlay")).toHaveAttribute("data-pins", "line");
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("region", { name: /QA/ })).toBeNull();
    expect(screen.getByTestId("chat-overlay-pin-3")).toHaveFocus();
  });

  it("opens a pin in the chat's place on a short pane, until it is closed", async () => {
    await renderOverlay(250, 250);
    fireEvent.click(await screen.findByTestId("chat-overlay-pin-3"));
    expect(screen.queryByTestId("ibx-msgs")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close QA" }));
    expect(screen.getByTestId("ibx-msgs")).toBeInTheDocument();
  });

  it("Full view opens the agent's conversation in the Inbox", async () => {
    await renderOverlay(420, 700);
    fireEvent.click(screen.getByRole("button", { name: "Full view" }));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "inbox",
        intent: expect.objectContaining({ conversation: LEAD, org: "acme", team: "widgets" }),
      }),
    );
  });

  it("Terminal hands the tab back to the terminal, and names the key that brings the chat back", async () => {
    act(() => openAgentInboxRail(SESSION));
    await renderOverlay(600, 300, "cover");
    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(terminal.getAttribute("title")).toMatch(/⌘I|Ctrl\+I/);
    expect(useAgentInboxRailStore.getState().bySession[SESSION]).toBeDefined();
    fireEvent.click(terminal);
    expect(useAgentInboxRailStore.getState().bySession[SESSION]).toBeUndefined();
  });

  it("Escape outside the composer closes the chat", async () => {
    act(() => openAgentInboxRail(SESSION));
    await renderOverlay(420, 700, "dock");
    expect(useAgentInboxRailStore.getState().bySession[SESSION]).toBeDefined();
    fireEvent.keyDown(screen.getByTestId("ibx-msgs"), { key: "Escape" });
    expect(useAgentInboxRailStore.getState().bySession[SESSION]).toBeUndefined();
  });

  it.each([
    [300, 700, false],
    [640, 480, true],
  ])("a %i × %i pane shows the head's button labels: %s", async (w, h, labelled) => {
    await renderOverlay(w, h);
    const full = screen.getByRole("button", { name: "Full view" });
    if (labelled) expect(full).toHaveTextContent("Full view");
    else expect(full).not.toHaveTextContent("Full view");
  });

  it("redraws its pins when the engine says that thread's list changed", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    expect(screen.queryByTestId("chat-overlay-pin-4")).toBeNull();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "agent_pins"
        ? {
            status: "pins",
            ...TEAM,
            agentId: "builtin/claude",
            storyId: "BUG-142",
            pins: [
              ...PINS,
              { ...PINS[0], messageId: 4, position: 2, preview: { shortName: "New" } },
            ],
          }
        : undefined,
    );
    // Another thread's change is not this one's.
    await act(async () =>
      events.get(AGENT_PINS_CHANGED_EVENT)?.({
        payload: { ...TEAM, agentId: "builtin/other", storyId: "BUG-142" },
      }),
    );
    expect(screen.queryByTestId("chat-overlay-pin-4")).toBeNull();
    await act(async () =>
      events.get(AGENT_PINS_CHANGED_EVENT)?.({
        payload: { ...TEAM, agentId: "builtin/claude", storyId: "BUG-142" },
      }),
    );
    expect(await screen.findByTestId("chat-overlay-pin-4")).toHaveTextContent("New");
  });

  it.each(AGENT_RUNTIMES)("shows the chat and its composer for a %s session", async (runtime) => {
    roster({ kind: runtime });
    await renderOverlay(420, 700, "dock");
    expect(screen.getByTestId("ibx-msgs")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Full view" })).toBeInTheDocument();
  });

  it("covering the tab, takes the keyboard into its composer; docked, leaves it where it is", async () => {
    const { unmount } = await renderOverlay(600, 300, "cover");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    unmount();
    await renderOverlay(420, 700, "dock");
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  describe("the group chat shortcut", () => {
    const room = { chatWorkspaceId: "ws-1", groupUnread: 2, groupReadId: 5 };
    const ask = () => act(() => useAgentInboxRailStore.getState().openGroup(SESSION));

    it("flips the chat to the workspace room and back", async () => {
      roster(room);
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(420, 700, "dock");
      ask();
      const pane = await screen.findByTestId("group-pane");
      expect(pane).toHaveAttribute("data-room", "ws-1");
      expect(screen.queryByTestId("ibx-msgs")).toBeNull();
      expect(useAgentInboxRailStore.getState().bySession[SESSION]?.groupHandled).toBe(1);
      ask();
      await waitFor(() => expect(screen.queryByTestId("group-pane")).toBeNull());
      expect(screen.getByTestId("ibx-msgs")).toBeInTheDocument();
      ask();
      fireEvent.click(await screen.findByRole("button", { name: "Back to the inbox" }));
      expect(screen.getByTestId("ibx-msgs")).toBeInTheDocument();
    });

    it("has nothing to open for a session with no room, and says it handled the request", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(420, 700, "dock");
      ask();
      await waitFor(() =>
        expect(useAgentInboxRailStore.getState().bySession[SESSION]?.groupHandled).toBe(1),
      );
      expect(screen.queryByTestId("group-pane")).toBeNull();
    });
  });
});

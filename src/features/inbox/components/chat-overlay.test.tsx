// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, render, screen, waitFor, within } from "@/test-utils";
import { invoke } from "@tauri-apps/api/core";
import {
  openAgentInboxRail,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { AGENT_RUNTIMES } from "@/shared/lib/agent-runtimes";
import { AGENT_INBOX_CHANGED_EVENT, AGENT_PINS_CHANGED_EVENT } from "@/tauri/events";
import type { AgentPin, AgentSessionRow, ConversationMessage } from "@/tauri/commands";

import { runBridgeCommand } from "@/features/dashboard/components/html-bridge";
import { useInboxSessionsStore } from "../hooks/use-inbox-sessions";
import { msgKey } from "../model";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => undefined),
}));
const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
// Every handler per event: a later listener replaces the one `events` keeps.
const listeners = vi.hoisted(() => new Map<string, ((event: { payload: unknown }) => void)[]>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.set(name, handler);
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));
const openFile = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/open-file-in-team", () => ({ openFileInTeam: openFile }));

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

const openFullView = vi.hoisted(() => vi.fn());
vi.mock("../lib/agent-full-view", async (orig) => ({
  ...(await orig<typeof import("../lib/agent-full-view")>()),
  openAgentFullView: openFullView,
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

const AGENT_PAGE = "pages/agent.html";
/** The registry's view of the team: `agent_page` is what teams.yml declares (absent ⇒ no page). */
function declareTeam(agentPage?: string) {
  useOrgStore.setState({
    orgs: [
      { slug: "acme", teams: [{ name: "widgets", source_repos: [], agent_page: agentPage }] },
    ] as never,
  });
}

beforeEach(() => {
  declareTeam(AGENT_PAGE);
  clearInboxDrafts();
  vi.clearAllMocks();
  events.clear();
  listeners.clear();
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

const arrive = (...extra: ConversationMessage[]) => {
  api.loadSessionInbox.mockResolvedValue({
    dto: { handle: LEAD, roles: [], messages: [...MESSAGES, ...extra] },
    source: "live",
  });
  act(() => listeners.get(AGENT_INBOX_CHANGED_EVENT)?.forEach((h) => h({ payload: null })));
};
const lead = (extra = {}) => [
  { handle: LEAD, displayName: "Login timeout lead", state: "running", unread: 1, ...extra },
];

describe("ChatOverlay marks (chat-core)", () => {
  it("marks what you send Queued while a busy lead is not told, Delivered once it is, none on history", async () => {
    api.loadInboxSessions.mockResolvedValue(lead({ mailNotice: "pending" }));
    await renderOverlay(420, 700, "dock");
    expect(screen.queryByText("Queued")).toBeNull();
    expect(screen.queryByText("Delivered")).toBeNull();
    await waitFor(() => expect(useInboxSessionsStore.getState().sessions).toHaveLength(1));
    const sentAt = Date.now();
    arrive(msg(7, "human", LEAD, "Ship it", { createdAtMs: sentAt }));
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    act(() =>
      useInboxSessionsStore.setState({
        sessions: lead({
          mailNotice: "told",
          notifiedAt: new Date(sentAt + 1000).toISOString(),
        }) as never,
      }),
    );
    expect(await screen.findByText("Delivered")).toBeInTheDocument();
    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("marks a send to an idle lead Delivered at once", async () => {
    api.loadInboxSessions.mockResolvedValue(lead({ state: "idle", unread: 0 }));
    await renderOverlay(420, 700, "dock");
    await waitFor(() => expect(useInboxSessionsStore.getState().sessions).toHaveLength(1));
    arrive(msg(7, "human", LEAD, "Ship it", { createdAtMs: Date.now() }));
    expect(await screen.findByText("Delivered")).toBeInTheDocument();
  });
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
    await renderOverlay(300, 700);
    const qa = await screen.findByTestId("chat-overlay-pin-3");
    expect(qa).toHaveTextContent("QA");
    expect(qa).toHaveTextContent("5 of 5");
    expect(qa).toHaveAttribute("data-status", "on-track");
    const tests = screen.getByTestId("chat-overlay-pin-1");
    expect(tests).toHaveAttribute("data-status", "stopped");
    expect(tests).toHaveTextContent("stopped 14:05");
  });

  it("a stopped pin in the one-line strip says stopped without its time, so it keeps to one row", async () => {
    await renderOverlay(250, 250);
    const tests = await screen.findByTestId("chat-overlay-pin-1");
    expect(screen.getByTestId("chat-overlay")).toHaveAttribute("data-pins", "line");
    expect(tests).toHaveTextContent("stopped");
    expect(tests).not.toHaveTextContent("14:05");
  });

  it.each([
    ["on-track", "on track"],
    ["running", "running"],
    ["needs-you", "needs you"],
  ] as const)(
    "names a %s pin's status in words, not by its dot's colour alone",
    async (status, word) => {
      const pins = [{ ...PINS[0]!, preview: { ...PINS[0]!.preview, status } }];
      vi.mocked(invoke).mockImplementation(async (cmd: string) =>
        cmd === "agent_pins"
          ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins }
          : undefined,
      );
      await renderOverlay(640, 480);
      const pin = await screen.findByTestId("chat-overlay-pin-3");
      expect(pin).toHaveAccessibleName(expect.stringContaining(word));
    },
  );

  it("a pins read that fails says so in the strip, and Retry reads them again", async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== "agent_pins") return undefined;
      if (fail) throw new Error("store locked");
      return { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: PINS };
    });
    await renderOverlay(640, 480);
    const line = await screen.findByTestId("chat-overlay-pins-failed");
    expect(line).toHaveTextContent("Couldn't read pins");
    expect(line).toHaveAttribute("role", "alert");
    fail = false;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("chat-overlay-pin-3")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-overlay-pins-failed")).toBeNull();
  });

  describe("the record line, from the agent's session record", () => {
    const RECORD = {
      handle: LEAD,
      sessionId: SESSION,
      sessionIds: [SESSION],
      model: "claude-opus-5-5",
      costUsd: 1.26,
      files: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }],
      story: "BUG-142",
    };
    const withRecord = (record: Record<string, unknown> = RECORD) =>
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "session_record") return record;
        if (cmd === "resolve_story_path")
          return { storyFilePath: "/ctx/acme/widgets/content/stories/BUG-142.md", team: "widgets" };
        return cmd === "agent_pins"
          ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: PINS }
          : undefined;
      });
    const recordText = async () => {
      const line = await screen.findByTestId("chat-overlay-record");
      await waitFor(() => expect(line).toHaveTextContent("$1.26"));
      return line.textContent;
    };

    it.each([
      [640, 480, "Opus 5.5 · $1.26 · 3 files · TIME · BUG-142"],
      [450, 700, "Opus 5.5 · $1.26 · 3 files · BUG-142"],
      [350, 700, "Opus 5.5 · $1.26 · BUG-142"],
      [250, 700, "$1.26 · BUG-142"],
    ])(
      "at %i × %i reads %s: time, then files, then the model drop; cost and the link stay",
      async (w, h, want) => {
        withRecord();
        await renderOverlay(w, h);
        // The elapsed time runs on the real clock.
        const text = (await recordText())?.replace(/\s*↗/, "").replace(/\b(\d+h )?\d+m\b/, "TIME");
        expect(text).toBe(want);
        expect(invoke).toHaveBeenCalledWith("session_record", { params: { handle: LEAD } });
      },
    );

    it("the story is a link that opens its page", async () => {
      useOrgStore.setState({ activeOrgSlug: "acme" });
      withRecord();
      await renderOverlay(640, 480);
      await recordText();
      fireEvent.click(screen.getByRole("link", { name: /BUG-142/ }));
      await waitFor(() =>
        expect(openFile).toHaveBeenCalledWith(
          expect.objectContaining({
            team: "widgets",
            path: "/ctx/acme/widgets/content/stories/BUG-142.md",
          }),
        ),
      );
    });

    it("reads the record again when the session's usage changes, and only for its own session", async () => {
      withRecord();
      await renderOverlay(640, 480);
      await recordText();
      withRecord({ ...RECORD, costUsd: 2.5 });
      const reads = () =>
        vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "session_record").length;
      const before = reads();
      act(() =>
        listeners
          .get("session-usage-changed")
          ?.forEach((h) => h({ payload: { sessionId: "other" } })),
      );
      expect(reads()).toBe(before);
      act(() =>
        listeners
          .get("session-usage-changed")
          ?.forEach((h) => h({ payload: { sessionId: SESSION } })),
      );
      await waitFor(() =>
        expect(screen.getByTestId("chat-overlay-record")).toHaveTextContent("$2.50"),
      );
    });

    it("a record not read yet, or with no price, shows what it knows and no cost", async () => {
      withRecord({ ...RECORD, costUsd: null, model: null, files: null });
      await renderOverlay(640, 480);
      await waitFor(() =>
        expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "session_record")).toBe(true),
      );
      const line = screen.getByTestId("chat-overlay-record");
      expect(line.textContent).toMatch(/^\d+(h \d+)?m · BUG-142/);
      expect(line).not.toHaveTextContent("$");
    });
  });

  it.each([
    [640, 480, true],
    [250, 250, false],
  ])(
    "a %i × %i pane draws the run-start avatar of the agent's messages: %s",
    async (w, h, drawn) => {
      await renderOverlay(w, h);
      const first = document.querySelector(`[data-mid="${msgKey(MESSAGES[0]!)}"]`)!;
      expect(first.querySelector(".ibx-av") !== null).toBe(drawn);
      // Your own messages carry no avatar.
      const own = document.querySelector(`[data-mid="${msgKey(MESSAGES[1]!)}"]`)!;
      expect(own.querySelector(".ibx-av")).toBeNull();
    },
  );

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

  it("Full view opens the team's declared agent page for its session, in the agent's team", async () => {
    await renderOverlay(420, 700);
    fireEvent.click(screen.getByRole("button", { name: "Full view" }));
    expect(openFullView).toHaveBeenCalledWith({
      org: "acme",
      team: "widgets",
      handle: LEAD,
      page: AGENT_PAGE,
    });
    expect(opened).not.toHaveBeenCalled();
  });

  it("with no agent page declared there is no Full view button, and no error", async () => {
    declareTeam(undefined);
    await renderOverlay(420, 700);
    expect(screen.queryByRole("button", { name: "Full view" })).toBeNull();
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("a message the page sends to the agent's handle appears in the overlay's thread for the same session", async () => {
    // A keyed store like the engine's: the page's `sendAsHuman({to: handle})` lands under the session that handle names,
    // and the overlay reads its thread by that session id, so the two meet only if the handle resolves to the overlay's session.
    const store = new Map<string, ConversationMessage[]>([[SESSION, [...MESSAGES]]]);
    const handleToSession = new Map([[LEAD, SESSION]]);
    api.loadSessionInbox.mockImplementation(async (key: string) => ({
      dto: { handle: LEAD, roles: [], messages: store.get(key) ?? [] },
      source: "live",
    }));
    const sends: { to: string; text: string }[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "send_inbox_as_human") {
        const { to, text } = args as { to: string; text: string };
        sends.push({ to, text });
        const session = handleToSession.get(to);
        if (session) store.get(session)?.push(msg(5, "human", to, text));
        return { status: "sent", messageId: 5 };
      }
      return cmd === "agent_pins"
        ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: PINS }
        : undefined;
    });
    await renderOverlay(420, 700);
    expect(api.loadSessionInbox).toHaveBeenCalledWith(SESSION);

    // The page's own transport: the bridge verb, with the handle the overlay's agent is known by.
    await runBridgeCommand("sendAsHuman", { to: LEAD, text: "sent from the agent page", ...TEAM });
    expect(sends).toEqual([{ to: LEAD, text: "sent from the agent page" }]);

    api.loadSessionInbox.mockClear();
    await act(async () => {
      events.get(AGENT_INBOX_CHANGED_EVENT)?.({ payload: null });
    });
    expect(await screen.findByText("sent from the agent page")).toBeInTheDocument();
    // The reload is keyed by the overlay's session id, and the thread it read is the one whose handle is what the page sent to.
    const keys = api.loadSessionInbox.mock.calls.map((call) => call[0]);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set([SESSION]));
    const read = await api.loadSessionInbox.mock.results.at(-1)!.value;
    expect(read.dto.handle).toBe(LEAD);
    expect(sends[0]!.to).toBe(read.dto.handle);
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

describe("ChatOverlay: the person pins a message", () => {
  // A one-thread engine double: pin, unpin and restore change the list the next read returns.
  let held: AgentPin[];
  let removed: AgentPin[];
  let failNext = false;
  beforeEach(() => {
    held = PINS.map((p) => ({ ...p }));
    removed = [];
    failNext = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      // An HTML message looks up its team's pages; there are none here.
      if (cmd === "list_panes") return { panes: [], contentRoot: null };
      if (cmd !== "agent_pins") return undefined;
      const a = args as { op: string; messageId?: number };
      if (failNext && a.op !== "read") {
        failNext = false;
        throw new Error("offline");
      }
      let outcome: string | undefined;
      if (a.op === "pin") {
        held.push({
          messageId: a.messageId!,
          position: held.length,
          pinnedBy: "human",
          pinnedAtMs: NOW,
        });
        outcome = "pinned";
      } else if (a.op === "unpin") {
        const at = held.findIndex((p) => p.messageId === a.messageId);
        removed.push({ ...held[at]!, position: at });
        held.splice(at, 1);
        outcome = "unpinned";
      } else if (a.op === "restore") {
        const back = removed.find((p) => p.messageId === a.messageId)!;
        held.splice(back.position, 0, back);
        outcome = "restored";
      }
      const pins = held.map((p, position) => ({ ...p, position }));
      return {
        status: "pins",
        ...TEAM,
        agentId: "builtin/claude",
        storyId: "BUG-142",
        pins,
        outcome,
      };
    });
  });
  const messageKeyOf = (id: number) => msgKey(msg(id, LEAD, "human", ""));
  const row = (id: number) =>
    document.querySelector<HTMLElement>(`[data-mid="${messageKeyOf(id)}"]`)!;
  const pinOf = (id: number) => within(row(id)).getByTestId("ibx-pin");
  const ops = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd, a]) => cmd === "agent_pins" && (a as { op: string }).op !== "read")
      .map(([, a]) => [(a as { op: string }).op, (a as { messageId: number }).messageId]);

  it("pins a message from its action row: the button turns Unpin, the tag says you, the live region says so", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    const pin = pinOf(4);
    expect(pin).toHaveAccessibleName("Pin");
    pin.focus();
    fireEvent.click(pin);
    await waitFor(() => expect(pinOf(4)).toHaveAccessibleName("Unpin"));
    expect(ops()).toEqual([["pin", 4]]);
    expect(pinOf(4)).toHaveFocus();
    expect(within(row(4)).getByTestId("ibx-pin-tag")).toHaveTextContent("Pinned by you");
    expect(screen.getByTestId("ibx-pin-live")).toHaveTextContent(
      'Pinned "Review is clean; merge…". 3 of 3 pinned.',
    );
    // The new pin is in the strip, named by its message.
    expect(await screen.findByTestId("chat-overlay-pin-4")).toBeInTheDocument();
  });

  it("at the cap every Pin is dimmed ahead of time; a click names whose pins fill it and replaces nothing", async () => {
    held.push({ messageId: 2, position: 2, pinnedBy: "human", pinnedAtMs: NOW });
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-2");
    const pin = pinOf(4);
    expect(pin).toHaveAttribute("aria-disabled", "true");
    expect(pin).toHaveAccessibleName("Pin (3 of 3 pinned)");
    fireEvent.click(pin);
    const note = within(row(4)).getByTestId("ibx-pin-note");
    expect(note).toHaveTextContent(
      "3 of 3 pinned (2 by Login timeout lead, 1 by you). Unpin one to pin this.",
    );
    expect(ops()).toEqual([]);
    fireEvent.keyDown(note, { key: "Escape" });
    expect(within(row(4)).queryByTestId("ibx-pin-note")).toBeNull();
    fireEvent.click(pin);
    fireEvent.click(within(row(4)).getByRole("button", { name: "Show pins" }));
    expect(screen.getByTestId("chat-overlay-pin-3")).toHaveFocus();
  });

  it("unpins an agent's pin with Undo, which puts it back as it was until the next pin, unpin or Esc", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    expect(within(row(3)).getByTestId("ibx-pin-tag")).toHaveTextContent(
      "Pinned by Login timeout lead",
    );
    fireEvent.click(pinOf(3));
    const undo = await within(row(3)).findByRole("button", { name: "Undo" });
    expect(screen.queryByTestId("chat-overlay-pin-3")).toBeNull();
    fireEvent.click(undo);
    await screen.findByTestId("chat-overlay-pin-3");
    expect(ops()).toEqual([
      ["unpin", 3],
      ["restore", 3],
    ]);
    expect(within(row(3)).getByTestId("ibx-pin-tag")).toHaveTextContent(
      "Pinned by Login timeout lead",
    );
    expect(within(row(3)).queryByRole("button", { name: "Undo" })).toBeNull();
    // Esc ends an Undo too.
    fireEvent.click(pinOf(3));
    await within(row(3)).findByRole("button", { name: "Undo" });
    fireEvent.keyDown(screen.getByTestId("ibx-msgs"), { key: "Escape" });
    expect(within(row(3)).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("your pin previews its message: a quote card for text, a name card for HTML, each with a glyph", async () => {
    arrive(msg(5, LEAD, "human", "<title>Merge board</title><p>x</p>", { contentType: "html" }));
    await renderOverlay(300, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    fireEvent.click(pinOf(4));
    const quote = await screen.findByTestId("chat-overlay-pin-4");
    expect(quote).toHaveAttribute("data-own", "quote");
    expect(quote).toHaveTextContent("Review is clean; merge card is next.");
    expect(quote).toHaveTextContent("Pinned by you");
    // An agent's pin keeps its preview and status dot.
    expect(screen.getByTestId("chat-overlay-pin-3")).not.toHaveAttribute("data-own");
    fireEvent.click(pinOf(3));
    await waitFor(() => expect(screen.queryByTestId("chat-overlay-pin-3")).toBeNull());
    fireEvent.click(within(row(5)).getByTestId("ibx-pin"));
    const card = await screen.findByTestId("chat-overlay-pin-5");
    expect(card).toHaveAttribute("data-own", "name");
    expect(card).toHaveTextContent("Merge board");
    expect(card).toHaveTextContent("Dashboard from Login timeout lead");
  });

  it("the new pin is marked new until the next click or key press, with no timer, and the strip says the count", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    expect(screen.getByRole("group", { name: "Pinned, 2 of 3" })).toBeInTheDocument();
    fireEvent.click(pinOf(4));
    const fresh = await screen.findByTestId("chat-overlay-pin-4");
    expect(fresh).toHaveAttribute("data-new", "true");
    expect(within(fresh).getByText("New")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Pinned, 3 of 3" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getByTestId("chat-overlay-pin-4")).not.toHaveAttribute("data-new");
  });

  it("an Undo refused because the agent filled the list since says so with the cap note, not Try again", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    fireEvent.click(pinOf(3));
    const undo = await within(row(3)).findByRole("button", { name: "Undo" });
    // Meanwhile the agent pins two more: the list is at the cap.
    held.push(
      { messageId: 2, position: 1, pinnedBy: LEAD, pinnedAtMs: NOW },
      { messageId: 4, position: 2, pinnedBy: LEAD, pinnedAtMs: NOW },
    );
    act(() =>
      listeners
        .get(AGENT_PINS_CHANGED_EVENT)
        ?.forEach((h) =>
          h({ payload: { ...TEAM, agentId: "builtin/claude", storyId: "BUG-142" } }),
        ),
    );
    await screen.findByTestId("chat-overlay-pin-4");
    fireEvent.click(undo);
    const note = await within(row(3)).findByRole("note");
    expect(note).toHaveTextContent(
      "3 of 3 pinned (3 by Login timeout lead). Unpin one to pin this.",
    );
    expect(within(note).getByRole("button", { name: "Show pins" })).toBeInTheDocument();
    expect(within(row(3)).queryByRole("alert")).toBeNull();
    expect(ops()).toEqual([["unpin", 3]]);
  });

  it("a pin that fails keeps its state and offers Try again", async () => {
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    failNext = true;
    fireEvent.click(pinOf(4));
    const note = await within(row(4)).findByRole("alert");
    expect(note).toHaveTextContent(
      "Couldn't pin. Try again. If it keeps failing, reload the page.",
    );
    expect(pinOf(4)).toHaveAccessibleName("Pin");
    fireEvent.click(within(note).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pinOf(4)).toHaveAccessibleName("Unpin"));
  });

  it("an HTML message has Pin in its title bar, named by its <title>, and the strip names its pin the same", async () => {
    arrive(
      msg(
        5,
        LEAD,
        "human",
        "<html><head><title>Merge board</title></head><body><h1>x</h1></body></html>",
        {
          contentType: "html",
        },
      ),
    );
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    const bar = within(row(5)).getByTestId("ibx-dm-bar");
    expect(bar).toHaveTextContent("Merge board");
    expect(bar).toHaveTextContent("Dashboard");
    fireEvent.click(within(bar).getByTestId("ibx-pin"));
    const chip = await screen.findByTestId("chat-overlay-pin-5");
    expect(chip).toHaveTextContent("Merge board");
    expect(chip).not.toHaveTextContent("<");
  });
});

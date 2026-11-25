// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, fireEvent, render, screen, waitFor, within } from "@/test-utils";
import { invoke } from "@tauri-apps/api/core";
import {
  flipAgentView,
  openAgentInboxRail,
  useAgentInboxRailStore,
} from "@/features/viewer/stores/agent-inbox-rail-store";
import { useAgentStateStore } from "@/shared/stores/agent-state-store";
import { useManagedSessionStore } from "@/shared/stores/use-managed-session-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { usePrefsStore } from "@/features/dashboard/lib/prefs-client";
import { useAgentListProjectionStore } from "@/features/viewer/lib/agent-list-projection";
import { isRunningAgent } from "@/features/viewer/lib/hand-agents";
import { AGENT_RUNTIMES, REMOTE_LAUNCH_CLIS } from "@/shared/lib/agent-runtimes";
import { AGENT_INBOX_CHANGED_EVENT, AGENT_PINS_CHANGED_EVENT } from "@/tauri/events";
import type {
  AgentPin,
  AgentPinMessage,
  AgentSessionRow,
  ConversationMessage,
} from "@/tauri/commands";

import { runBridgeCommand } from "@/features/dashboard/components/html-bridge";
import { liveHub } from "@/features/dashboard/lib/live-hub";
import { FOREMAN_AGENT, isForemanAgent } from "@/features/foreman/open-foreman";
import { FOREMAN_HISTORY } from "@/features/foreman/use-foreman-thread";
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
  loadThreadInbox: vi.fn(),
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
    threadHidden?: boolean;
  }) => (
    <div
      data-testid="group-pane"
      data-room={p.room.workspaceId}
      data-focus={p.focusRequest}
      data-thread-hidden={p.threadHidden ? "true" : "false"}
    >
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
import { InboxSplit } from "./inbox-split";

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

/** The messages the store holds beyond the first four (those that arrived), by id. */
const arrived = new Map<number, ConversationMessage>();
/** What the pins read says a pinned message is, as the engine reads it from its store. */
const pinnedOf = (id: number): AgentPinMessage => {
  const m = arrived.get(id) ?? MESSAGES.find((x) => x.id === id);
  return m
    ? {
        from: m.from,
        createdAtMs: m.createdAtMs,
        text: m.text,
        contentType: m.contentType,
        summary: m.summary,
      }
    : { from: LEAD, createdAtMs: NOW, text: `Message ${id}.` };
};

const PINS: AgentPin[] = [
  {
    messageId: 3,
    position: 0,
    pinnedBy: LEAD,
    pinnedAtMs: NOW,
    message: pinnedOf(3),
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
    message: pinnedOf(1),
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

async function renderOverlay(width: number, height: number, paneAttrs: object = {}) {
  const utils = render(
    <div {...paneAttrs}>
      <ChatOverlay
        tabId="tab-1"
        sessionId={SESSION}
        teamKey={TEAM_KEY}
        composeRequest={0}
        size={{ width, height }}
      />
    </div>,
  );
  await screen.findByText("Review is clean; merge card is next.");
  return utils;
}

/** An elapsed time as the record line says it (`formatElapsed`): "45s", "41m", "65h" or
 *  "2h 5m". It runs on the real clock. */
const ELAPSED = /\b\d+(?:s|m|h(?: \d+m)?)\b/;

const composerBox = () =>
  screen.getByTestId("chat-overlay").querySelector<HTMLTextAreaElement>(".ibx-comp textarea")!;

const INBOX_CSS = readFileSync(resolve(__dirname, "../inbox.css"), "utf-8");
/** The declarations of `selector`'s own rule in inbox.css. */
const ruleOf = (selector: string) => {
  const at = INBOX_CSS.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return INBOX_CSS.slice(at, INBOX_CSS.indexOf("}", at));
};

describe("ChatOverlay contrast and focus (inbox.css)", () => {
  it("draws a failed pins read as one muted line, with a Retry that has the 2 px accent focus ring", () => {
    const failed = ruleOf(".ibx-ov-pins.ibx-ov-pins-failed");
    expect(failed).toContain("display: flex");
    expect(failed).toContain("color: var(--ibx-mfg)");
    expect(ruleOf(".ibx-ov-pins-retry")).toContain("color: var(--ibx-accent)");
    expect(ruleOf(".ibx-ov-pins-retry:focus-visible")).toContain(
      "outline: 2px solid var(--ibx-accent)",
    );
  });

  it("draws the composer's hint, placeholder and key words in the muted ink that reads at 4.5:1", () => {
    expect(ruleOf(".ibx-box textarea::placeholder")).toContain("color: var(--ibx-mfg)");
    expect(ruleOf(".ibx-comp-foot")).toContain("color: var(--ibx-mfg)");
    expect(ruleOf(".ibx-comp-foot .ibx-tohint")).toContain("color: var(--ibx-mfg)");
  });
  it("rings the focused thread with the 2 px accent outline the pins and buttons use", () => {
    const ring = ruleOf(".ibx-msgs:focus-visible");
    expect(ring).toContain("outline: 2px solid var(--ibx-accent)");
    expect(ring).not.toContain("outline: none");
  });
  it("keeps a message's actions in the layout while hidden, so Pin… or Unpin can take focus back after a redraw", () => {
    // display:none made focus() a no-op on the rebuilt PinButton: focus dropped to the page after a
    // keyboard replace, its Undo, or Esc in the chooser. Hidden by opacity, the row shows on focus-within.
    const hidden = ruleOf(".ibx-acts");
    expect(hidden).not.toContain("display: none");
    expect(hidden).toContain("opacity: 0");
    expect(hidden).toContain("pointer-events: none");
    const shown = ruleOf(".ibx-m[data-tapped] .ibx-acts");
    expect(shown).toContain("opacity: 1");
    expect(shown).toContain("pointer-events: auto");
  });
  it("sets the cap count on Pin… and a fresh pin's New at the 11 px meta floor", () => {
    expect(ruleOf(".ibx-ov .ibx-pin-cap")).toContain("font-size: 11px");
    expect(ruleOf(".ibx-pk-new")).toContain("font-size: 11px");
  });
  it("draws the chooser's highlighted row's Pinned by and Replace in the full ink, which reads at AA on its accent wash", () => {
    // Muted and accent inks only just pass on the bare page: on the wash they fell to 4.36:1 and 4.25:1 in light.
    const current = ".ibx-pin-chooser .choice[data-current]";
    expect(ruleOf(current)).toContain("background: var(--ibx-accent-wash)");
    // A pin that arrived while the chooser was open is a New row (accent), and it can be the current one.
    expect(ruleOf(`${current} .by,\n${current} .go,\n${current} .new`)).toContain(
      "color: var(--ibx-fg)",
    );
  });
  it("draws a pinned message's pressed Unpin in the accent, which shows on the page with no fill behind it", () => {
    // The on-accent ink is for text on an accent fill; on the bare page it drew the icon at 1:1.
    const pressed = ruleOf('.ibx-pin-b[aria-pressed="true"]');
    expect(pressed).toContain("color: var(--ibx-accent);");
    expect(pressed).not.toContain("--ibx-accent-ink");
  });
  it("draws a fresh pin's reduced-motion New in the accent, which shows on the pin's light wash", () => {
    const fresh = ruleOf(".ibx-pk-new");
    expect(fresh).toContain("color: var(--ibx-accent);");
    expect(fresh).not.toContain("--ibx-accent-ink");
  });
  it("sets the Pinned by tag at the 11 px meta floor", () => {
    expect(ruleOf(".ibx-pin-tag")).toContain("font-size: 11px");
  });
  it("sets the key hints at the 11 px meta floor", () => {
    expect(ruleOf(".ibx-comp-keys kbd")).toContain("font-size: 11px");
  });
});

const AGENT_PAGE = "/r/acme/widgets/content/pages/agent.html";
/** The registry's view of the team: `agent_page` is what teams.yml declares (absent ⇒ no page). */
function declareTeam(agentPage?: string) {
  useOrgStore.setState({
    orgs: [
      {
        slug: "acme",
        org_root: "/r/acme",
        teams: [{ name: "widgets", source_repos: [], agent_page: agentPage }],
      },
    ] as never,
  });
}

beforeEach(() => {
  declareTeam("pages/agent.html");
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
  // A session launched on a saved agent and story reads its thread: by default what the session
  // read gives for its seat, so a test that sets the session read sets what the chat shows.
  api.loadThreadInbox.mockImplementation((key: string) =>
    api.loadSessionInbox((JSON.parse(key) as string[])[2]),
  );
  api.loadInboxSessions.mockResolvedValue([]);
  api.sendAsHuman.mockResolvedValue({ status: "sent", messageId: 99 });
  vi.mocked(invoke).mockImplementation(async (cmd: string) =>
    cmd === "agent_pins"
      ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: PINS }
      : undefined,
  );
});

const arrive = (...extra: ConversationMessage[]) => {
  for (const m of extra) arrived.set(m.id, m);
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
    await renderOverlay(420, 700);
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
    await renderOverlay(420, 700);
    await waitFor(() => expect(useInboxSessionsStore.getState().sessions).toHaveLength(1));
    arrive(msg(7, "human", LEAD, "Ship it", { createdAtMs: Date.now() }));
    expect(await screen.findByText("Delivered")).toBeInTheDocument();
  });
});

describe("ChatOverlay", () => {
  it("shows that agent's chat at its newest message, and sends to the agent from its composer", async () => {
    await renderOverlay(420, 700);
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

  it("the one-line strip shows every pin, each keeping its full name and its value", async () => {
    await renderOverlay(250, 250);
    await screen.findByTestId("chat-overlay-pin-1");
    const three = [
      ...PINS,
      {
        messageId: 2,
        position: 2,
        pinnedBy: LEAD,
        pinnedAtMs: NOW,
        message: pinnedOf(2),
        preview: { shortName: "Review rounds", value: "2", status: "running" as const },
        previewAtMs: NOW,
      },
    ];
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "agent_pins"
        ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: three }
        : undefined,
    );
    act(() =>
      listeners
        .get(AGENT_PINS_CHANGED_EVENT)
        ?.forEach((h) =>
          h({ payload: { ...TEAM, agentId: "builtin/claude", storyId: "BUG-142" } }),
        ),
    );
    const third = await screen.findByTestId("chat-overlay-pin-2");
    for (const [id, name] of [
      [3, "QA"],
      [1, "Tests"],
      [2, "Review rounds"],
    ] as const) {
      const pin = id === 2 ? third : screen.getByTestId(`chat-overlay-pin-${id}`);
      expect(pin).toHaveAccessibleName(expect.stringContaining(name));
      expect(pin.querySelector(".ibx-pk-t")).toHaveAttribute("title", name);
      expect(pin.querySelector(".ibx-pk-v")).not.toBeNull();
    }
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
        const text = (await recordText())?.replace(/\s*↗/, "").replace(ELAPSED, "TIME");
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

    it("a cost or file count the record has only in part says so, with the record's reason", async () => {
      withRecord({
        ...RECORD,
        unpricedModels: ["gpt-5.5-codex"],
        unavailable: {
          cost: "costUsd is the priced part only: a model of this session has no rate",
          files: "only the first 10000 commits were read",
        },
      });
      await renderOverlay(640, 480);
      const line = await screen.findByTestId("chat-overlay-record");
      await waitFor(() => expect(line).toHaveTextContent("≥ $1.26"));
      expect(line).toHaveTextContent("≥ 3 files");
      expect(within(line).getByText("≥ $1.26")).toHaveAttribute(
        "title",
        "costUsd is the priced part only: a model of this session has no rate",
      );
      expect(within(line).getByText("≥ 3 files")).toHaveAttribute(
        "title",
        "only the first 10000 commits were read",
      );
    });

    it("an unpriced model alone marks the cost as part of it, naming the model", async () => {
      withRecord({ ...RECORD, unpricedModels: ["gpt-5.5-codex"] });
      await renderOverlay(640, 480);
      const line = await screen.findByTestId("chat-overlay-record");
      await waitFor(() => expect(line).toHaveTextContent("≥ $1.26"));
      expect(within(line).getByText("≥ $1.26").getAttribute("title")).toContain("gpt-5.5-codex");
    });

    it("reads the record one at a time: events while a read runs queue one more read, not many", async () => {
      let release!: () => void;
      let reads = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "session_record") {
          reads++;
          if (reads === 2) await new Promise<void>((resolve) => (release = resolve));
          return RECORD;
        }
        return cmd === "agent_pins"
          ? { status: "pins", ...TEAM, agentId: "builtin/claude", storyId: "BUG-142", pins: PINS }
          : undefined;
      });
      await renderOverlay(640, 480);
      await recordText();
      const usage = () =>
        act(() =>
          listeners
            .get("session-usage-changed")
            ?.forEach((h) => h({ payload: { sessionId: SESSION } })),
        );
      usage();
      await waitFor(() => expect(reads).toBe(2));
      usage();
      usage();
      usage();
      expect(reads).toBe(2);
      await act(async () => release());
      await waitFor(() => expect(reads).toBe(3));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reads).toBe(3);
    });

    it("a record not read yet, or with no price, shows what it knows and no cost", async () => {
      withRecord({ ...RECORD, costUsd: null, model: null, files: null });
      await renderOverlay(640, 480);
      await waitFor(() =>
        expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "session_record")).toBe(true),
      );
      const line = screen.getByTestId("chat-overlay-record");
      expect(line.textContent).toMatch(new RegExp(`^${ELAPSED.source} · BUG-142`));
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

  it.each([
    [250, 250],
    [640, 480],
  ])(
    "opens a pin in the chat's place on a %i × %i pane, until it is closed, and keeps the composer",
    async (w, h) => {
      await renderOverlay(w, h);
      fireEvent.click(await screen.findByTestId("chat-overlay-pin-3"));
      expect(screen.getByTestId("ibx-msgs")).not.toBeVisible();
      const box = composerBox();
      expect(box).toBeInTheDocument();
      expect(box).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Close QA" }));
      expect(screen.getByTestId("ibx-msgs")).toBeVisible();
    },
  );

  it("closing a pin opened in the chat's place puts the thread back at its newest message, still following", async () => {
    await renderOverlay(250, 250);
    const msgs = screen.getByTestId("ibx-msgs");
    const height = { value: 1000 };
    Object.defineProperty(msgs, "scrollHeight", { configurable: true, get: () => height.value });
    fireEvent.click(await screen.findByTestId("chat-overlay-pin-3"));
    // A hidden scroller can lose its place.
    msgs.scrollTop = 0;
    fireEvent.click(screen.getByRole("button", { name: "Close QA" }));
    // The same scroller, not a new one without its stick-to-bottom wiring.
    expect(screen.getByTestId("ibx-msgs")).toBe(msgs);
    expect(msgs.scrollTop).toBe(1000);
    // Still following: a message that lands keeps it at its end.
    height.value = 1400;
    arrive(msg(9, LEAD, "human", "Merged."));
    await screen.findByText("Merged.");
    expect(msgs.scrollTop).toBe(1400);
  });

  it("Escape in an empty composer closes an open pin; with a draft it leaves the pin open", async () => {
    await renderOverlay(300, 700);
    fireEvent.click(await screen.findByTestId("chat-overlay-pin-3"));
    const box = composerBox();
    fireEvent.change(box, { target: { value: "half a thought" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByRole("region", { name: /QA/ })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("region", { name: /QA/ })).toBeNull();
    // The chat itself stays open: Escape closed the pin, not the overlay.
    expect(screen.getByTestId("chat-overlay")).toBeInTheDocument();
  });

  it.each([
    [250, 250, false],
    [900, 250, false],
    [300, 700, false],
    [420, 700, true],
  ])("a %i × %i pane keeps the composer's route and key hints: %s", async (w, h, hinted) => {
    await renderOverlay(w, h);
    const comp = composerBox().closest(".ibx-comp")!;
    expect(comp.classList.contains("compact")).toBe(!hinted);
    if (hinted) expect(screen.getByTestId("ibx-route-hint")).toBeInTheDocument();
    else expect(screen.queryByTestId("ibx-route-hint")).toBeNull();
    expect(comp.querySelector(".ibx-comp-keys") !== null).toBe(hinted);
  });

  it("an empty chat says so once; a refresh that fails says the chat could not refresh", async () => {
    api.loadSessionInbox.mockResolvedValue({
      dto: { handle: LEAD, roles: [], messages: [] },
      source: "live",
    });
    render(
      <ChatOverlay
        tabId="tab-1"
        sessionId={SESSION}
        teamKey={TEAM_KEY}
        composeRequest={0}
        size={{ width: 420, height: 700 }}
      />,
    );
    const empty = await screen.findByTestId("chat-overlay-empty");
    expect(empty).toHaveTextContent("No messages yet");
    expect(empty).not.toHaveTextContent("inbox");
    api.loadSessionInbox.mockRejectedValue(new Error("store locked"));
    act(() => listeners.get(AGENT_INBOX_CHANGED_EVENT)?.forEach((h) => h({ payload: null })));
    const stale = await screen.findByRole("alert");
    expect(stale).toHaveTextContent("Couldn’t refresh the chat: store locked");
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

  it("has no Terminal button: the caption's switch is the way back, and Full view stays", async () => {
    act(() => openAgentInboxRail(SESSION));
    await renderOverlay(600, 300);
    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Full view" })).toBeInTheDocument();
  });

  it("Escape in the composer leaves the box and does not flip to the CLI", async () => {
    act(() => openAgentInboxRail(SESSION));
    await renderOverlay(600, 300);
    const box = composerBox();
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(useAgentInboxRailStore.getState().bySession[SESSION]).toBeDefined();
  });

  describe("the CLI needs you while the chat covers it", () => {
    const line = () => screen.queryByTestId("chat-overlay-needs");
    const askUser = () =>
      act(() =>
        useManagedSessionStore.setState({
          pendingAsks: { q1: { correlationId: "c1", sessionId: SESSION, question: "Ship it?" } },
        }),
      );
    // The ask_user's MCP signal, which also sets the session's record to needs-permission.
    const askSignal = () =>
      act(() =>
        useAgentStateStore.getState().recordSignal(SESSION, {
          tier: 1,
          signal: { kind: "ask-user" },
        }),
      );
    const approvalHook = () =>
      act(() =>
        useAgentStateStore.getState().recordSignal(SESSION, {
          tier: 1,
          signal: { kind: "claude-hook", event: "PermissionRequest" },
        }),
      );
    const activity = (revision: number, waiting: boolean) =>
      act(() =>
        useAgentStateStore.getState().recordActivity(
          {
            session: SESSION,
            identity: { hostBootId: "h", sessionIncarnation: "s", invocationId: "i" },
            revision,
            turnGeneration: 1,
            provider: "claude",
            state: waiting ? "needs-permission" : "working",
            ...(waiting ? { reason: "question" as const } : {}),
            observed: true,
            limited: false,
            exit: null,
            asks: [],
          },
          0,
        ),
      );
    const cliQuestion = () => activity(1, true);

    it.each(["permission", "startup"] as const)(
      "a %s shows one chrome line with Show CLI, which flips to the CLI",
      async (kind) => {
        act(() => openAgentInboxRail(SESSION));
        roster({ needsYouKind: kind });
        await renderOverlay(600, 300);
        const needs = await screen.findByTestId("chat-overlay-needs");
        expect(needs).toHaveTextContent("Input needed");
        expect(screen.getAllByTestId("chat-overlay-needs")).toHaveLength(1);
        fireEvent.click(within(needs).getByRole("button", { name: "Show CLI" }));
        expect(useAgentInboxRailStore.getState().bySession[SESSION]?.shown).toBe(false);
      },
    );

    it("a CLI question shows it, and the line clears when the CLI no longer waits", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(600, 300);
      expect(line()).toBeNull();
      cliQuestion();
      await waitFor(() => expect(line()).not.toBeNull());
      activity(2, false);
      await waitFor(() => expect(line()).toBeNull());
    });

    it("an ask_user alone is answered in the chat and shows no line", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(600, 300);
      askUser();
      expect(line()).toBeNull();
    });

    it("an ask_user's own signal is not a CLI permission prompt, and shows no line", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(600, 300);
      askUser();
      askSignal();
      expect(line()).toBeNull();
    });

    it("an ask_user and a CLI approval prompt both open: the approval shows the line", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(600, 300);
      askUser();
      askSignal();
      approvalHook();
      await waitFor(() => expect(line()).not.toBeNull());
    });

    it("an ask_user and a CLI question both open: the CLI question shows the line", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(600, 300);
      askUser();
      cliQuestion();
      await waitFor(() => expect(line()).not.toBeNull());
    });

    it("is chrome, never a message in the thread", async () => {
      act(() => openAgentInboxRail(SESSION));
      roster({ needsYouKind: "permission" });
      await renderOverlay(600, 300);
      const needs = await screen.findByTestId("chat-overlay-needs");
      expect(screen.getByTestId("ibx-msgs")).not.toContainElement(needs);
    });
  });

  it("Escape outside the composer hides the chat behind the CLI", async () => {
    act(() => openAgentInboxRail(SESSION));
    await renderOverlay(420, 700);
    expect(useAgentInboxRailStore.getState().bySession[SESSION]).toBeDefined();
    fireEvent.keyDown(screen.getByTestId("ibx-msgs"), { key: "Escape" });
    expect(useAgentInboxRailStore.getState().bySession[SESSION]?.shown).toBe(false);
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
              {
                ...PINS[0],
                messageId: 4,
                message: pinnedOf(4),
                position: 2,
                preview: { shortName: "New" },
              },
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
    await renderOverlay(420, 700);
    expect(screen.getByTestId("ibx-msgs")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Full view" })).toBeInTheDocument();
  });

  it.each(REMOTE_LAUNCH_CLIS)(
    "shows a remote %s session's chat at its newest message, and sends to it from its composer",
    async (runtime) => {
      // A session on another machine: its row names the machine and the team it was launched in,
      // and its agent is known from that host's activity snapshot, not a process on this Mac. Only
      // the isRunningAgent line below exercises that remote path; the overlay itself reads nothing
      // remote (the inbox by session id, the team from its prop), so the rest shows a remote row
      // gets the same chat as a local one. The tab mounting the chat for a remote session is
      // inbox-split's REMOTE_LAUNCH_CLIS case.
      roster({ kind: runtime, machineId: "box", launchTeamKey: TEAM_KEY });
      useAgentStateStore.setState({ processAgentBySession: {} });
      useAgentStateStore.getState().recordActivity(
        {
          session: SESSION,
          identity: { hostBootId: "box", sessionIncarnation: "shell", invocationId: "agent" },
          revision: 1,
          turnGeneration: 0,
          provider: runtime as never,
          state: "idle",
          observed: true,
          limited: false,
          exit: null,
          asks: [],
        },
        0,
      );
      expect(isRunningAgent(useAgentStateStore.getState(), SESSION)).toBe(true);
      await renderOverlay(420, 700);
      expect(api.loadSessionInbox).toHaveBeenCalledWith(SESSION);
      const shown = Array.from(screen.getByTestId("ibx-msgs").querySelectorAll(".ibx-m"));
      expect(shown.at(-1)).toHaveTextContent("Review is clean; merge card is next.");
      const box = screen.getByRole("textbox");
      expect(box).toBeEnabled();
      fireEvent.change(box, { target: { value: "Ship it" } });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(api.sendAsHuman).toHaveBeenCalled());
      expect(api.sendAsHuman.mock.calls[0]).toEqual(
        expect.arrayContaining([expect.objectContaining(TEAM), LEAD, "Ship it"]),
      );
    },
  );

  it("covering the tab, takes the keyboard into its composer when its pane is the active tab", async () => {
    await renderOverlay(600, 300, { "data-focus-pane": "tab-1", "data-pane-active": "" });
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  });

  it("never takes the keyboard from an element outside its pane, nor in a tab that is not active", async () => {
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    const { unmount } = await renderOverlay(600, 300, {
      "data-focus-pane": "tab-1",
      "data-pane-active": "",
    });
    expect(other).toHaveFocus();
    unmount();
    other.remove();
    await renderOverlay(600, 300, { "data-focus-pane": "tab-1" });
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  describe("the group chat shortcut", () => {
    const room = { chatWorkspaceId: "ws-1", groupUnread: 2, groupReadId: 5 };
    const ask = () => act(() => useAgentInboxRailStore.getState().openGroup(SESSION));

    it("flips the chat to the workspace room and back", async () => {
      roster(room);
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(420, 700);
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

    it("a pin opened in the room's place keeps the room's composer", async () => {
      roster(room);
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(250, 250);
      ask();
      const pane = await screen.findByTestId("group-pane");
      expect(pane).toHaveAttribute("data-thread-hidden", "false");
      fireEvent.click(await screen.findByTestId("chat-overlay-pin-3"));
      expect(screen.getByTestId("group-pane")).toHaveAttribute("data-thread-hidden", "true");
      fireEvent.click(screen.getByRole("button", { name: "Close QA" }));
      expect(screen.getByTestId("group-pane")).toHaveAttribute("data-thread-hidden", "false");
    });

    it("has nothing to open for a session with no room, and says it handled the request", async () => {
      act(() => openAgentInboxRail(SESSION));
      await renderOverlay(420, 700);
      ask();
      await waitFor(() =>
        expect(useAgentInboxRailStore.getState().bySession[SESSION]?.groupHandled).toBe(1),
      );
      expect(screen.queryByTestId("group-pane")).toBeNull();
    });
  });
});

describe("ChatOverlay: the thread is one Tab stop", () => {
  const thread = () => screen.getByTestId("ibx-msgs");
  const rows = () => [...thread().querySelectorAll<HTMLElement>("[data-mid]")];
  /** What Tab stops on in the thread: anything focusable with a tabindex of 0 or more. */
  const stops = () =>
    [thread(), ...thread().querySelectorAll<HTMLElement>("*")].filter(
      (el) =>
        el.tabIndex >= 0 &&
        (el.matches("button, a[href], iframe, input") || el.hasAttribute("tabindex")),
    );

  it("stops on the newest message and its own actions, and on nothing in older messages", async () => {
    await renderOverlay(420, 700);
    const newest = rows().at(-1)!;
    expect(newest.tabIndex).toBe(0);
    expect(thread().tabIndex).toBe(-1);
    const all = stops();
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((el) => el === newest || newest.contains(el))).toBe(true);
  });

  it("moves between messages with the arrow keys, Home and End, and takes each message's actions along", async () => {
    await renderOverlay(420, 700);
    const all = rows();
    const newest = all.at(-1)!;
    act(() => newest.focus());
    fireEvent.keyDown(newest, { key: "ArrowUp" });
    const before = all.at(-2)!;
    expect(before).toHaveFocus();
    expect(before.tabIndex).toBe(0);
    expect(newest.tabIndex).toBe(-1);
    expect(stops().every((el) => el === before || before.contains(el))).toBe(true);
    fireEvent.keyDown(before, { key: "Home" });
    expect(all[0]).toHaveFocus();
    fireEvent.keyDown(all[0]!, { key: "ArrowUp" });
    expect(all[0]).toHaveFocus();
    fireEvent.keyDown(all[0]!, { key: "End" });
    expect(newest).toHaveFocus();
    fireEvent.keyDown(newest, { key: "ArrowDown" });
    expect(newest).toHaveFocus();
  });

  it("an action focused in an older message makes that message the thread's stop", async () => {
    await renderOverlay(420, 700);
    const first = rows()[0]!;
    const pin = within(first).getAllByRole("button")[0]!;
    act(() => pin.focus());
    expect(first.tabIndex).toBe(0);
    expect(rows().at(-1)!.tabIndex).toBe(-1);
    expect(stops().every((el) => el === first || first.contains(el))).toBe(true);
  });

  it("holds an older message's scrolling code block and table out of the Tab order, as its controls are", async () => {
    // Chromium makes an overflowing scroller keyboard-focusable with no tabindex, so it would leak out of
    // the one stop: forward Tab past the message, Shift+Tab onto every older block.
    api.loadSessionInbox.mockResolvedValue({
      dto: {
        handle: LEAD,
        roles: [],
        messages: [
          msg(
            1,
            LEAD,
            "human",
            "Here:\n\n```\nlong line of code\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
          ),
          ...MESSAGES.slice(1),
        ],
      },
      source: "live",
    });
    await renderOverlay(420, 700);
    const older = rows()[0]!;
    const blocks = [...older.querySelectorAll<HTMLElement>("pre, .inbox-table-scroll")];
    expect(blocks.length).toBe(2);
    for (const block of blocks) expect(block.getAttribute("tabindex")).toBe("-1");
    // Its message becomes the stop: the blocks are as the browser made them again.
    act(() => older.focus());
    for (const block of blocks) expect(block.hasAttribute("tabindex")).toBe(false);
  });

  it("names a code block or table that scrolls, which Chromium makes a Tab stop, and leaves one that fits alone", async () => {
    const BLOCK = "pre, .inbox-table-scroll";
    const wide = new Set<string>(["PRE"]);
    // jsdom has no layout: the code block overflows, the table fits.
    const width = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.matches(BLOCK) && wide.has(this.tagName) ? 400 : 0;
      });
    try {
      api.loadSessionInbox.mockResolvedValue({
        dto: {
          handle: LEAD,
          roles: [],
          messages: [
            ...MESSAGES,
            msg(
              9,
              LEAD,
              "human",
              "Here:\n\n```\nlong line of code\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
            ),
          ],
        },
        source: "live",
      });
      await renderOverlay(420, 700);
      const newest = rows().at(-1)!;
      const code = newest.querySelector<HTMLElement>("pre")!;
      const table = newest.querySelector<HTMLElement>(".inbox-table-scroll")!;
      expect(code).toHaveAttribute("role", "region");
      expect(code).toHaveAccessibleName("Code");
      expect(table).not.toHaveAttribute("role");
      expect(table).not.toHaveAttribute("aria-label");
    } finally {
      width.mockRestore();
    }
  });

  it("names the active message's block once a thread drawn hidden is shown and focus comes into it", async () => {
    let shown = false;
    // Drawn hidden, a block measures 0 (it fits); shown, it scrolls.
    const width = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        return shown && this.matches("pre") ? 400 : 0;
      });
    try {
      api.loadSessionInbox.mockResolvedValue({
        dto: {
          handle: LEAD,
          roles: [],
          messages: [...MESSAGES, msg(9, LEAD, "human", "Here:\n\n```\nlong line of code\n```")],
        },
        source: "live",
      });
      await renderOverlay(420, 700);
      const newest = rows().at(-1)!;
      const code = newest.querySelector<HTMLElement>("pre")!;
      expect(code).not.toHaveAttribute("role");
      shown = true;
      act(() => newest.focus());
      expect(code).toHaveAttribute("role", "region");
      expect(code).toHaveAccessibleName("Code");
    } finally {
      width.mockRestore();
    }
  });

  it("measures only the active message's blocks, and names an older one's when focus moves into it", async () => {
    const BLOCK = "pre, .inbox-table-scroll";
    const measured: Element[] = [];
    const width = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: HTMLElement) {
        if (!this.matches(BLOCK)) return 0;
        measured.push(this);
        return 400;
      });
    try {
      api.loadSessionInbox.mockResolvedValue({
        dto: {
          handle: LEAD,
          roles: [],
          messages: [
            msg(1, LEAD, "human", "Here:\n\n```\nlong line of code\n```"),
            ...MESSAGES.slice(1),
          ],
        },
        source: "live",
      });
      await renderOverlay(420, 700);
      const older = rows()[0]!;
      const code = older.querySelector<HTMLElement>("pre")!;
      // An older message's block is out of the Tab order: it is neither measured nor named.
      expect(measured).not.toContain(code);
      expect(code).not.toHaveAttribute("role");
      act(() => older.focus());
      expect(code).toHaveAttribute("role", "region");
      expect(code).toHaveAccessibleName("Code");
    } finally {
      width.mockRestore();
    }
  });

  it("names a grouped follow-on message by its sender and time, as the message it follows is", async () => {
    await renderOverlay(420, 700);
    const grouped = rows().filter((r) => r.classList.contains("grouped"));
    expect(grouped.length).toBeGreaterThan(0);
    for (const row of grouped) {
      const said = row.querySelector(".ibx-sr")!;
      expect(said.textContent).toMatch(/^Login timeout lead · \d/);
      // it comes first, so the article is read sender and time, then the text
      expect(row.firstElementChild).toBe(said);
    }
  });

  it("a message you are on that leaves the thread hands focus to the newest, never to the page", async () => {
    await renderOverlay(420, 700);
    const first = rows()[0]!;
    act(() => first.focus());
    // The thread is trimmed at its cap: the message focus is on leaves as a new one lands.
    api.loadSessionInbox.mockResolvedValue({
      dto: {
        handle: LEAD,
        roles: [],
        messages: [...MESSAGES.slice(1), msg(9, LEAD, "human", "Merged.")],
      },
      source: "live",
    });
    act(() => listeners.get(AGENT_INBOX_CHANGED_EVENT)?.forEach((h) => h({ payload: null })));
    await screen.findByText("Merged.");
    const newest = rows().at(-1)!;
    expect(newest).toHaveFocus();
    expect(newest.tabIndex).toBe(0);
  });

  it("a message that lands while you read an older one leaves the stop where you are", async () => {
    await renderOverlay(420, 700);
    const first = rows()[0]!;
    act(() => first.focus());
    arrive(msg(9, LEAD, "human", "Merged."));
    await screen.findByText("Merged.");
    expect(first).toHaveFocus();
    expect(first.tabIndex).toBe(0);
    expect(rows().at(-1)!.tabIndex).toBe(-1);
  });
});

describe("ChatOverlay: the person pins a message", () => {
  // A one-thread engine double: pin, unpin and restore change the list the next read returns,
  // and the read says what each pinned message is.
  type Held = Omit<AgentPin, "message"> & { message?: AgentPinMessage };
  let held: Held[];
  let removed: Held[];
  let failNext = false;
  beforeEach(() => {
    arrived.clear();
    held = PINS.map((p) => ({ ...p }));
    removed = [];
    failNext = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      // An HTML message looks up its team's pages; there are none here.
      if (cmd === "list_panes") return { panes: [], contentRoot: null };
      if (cmd !== "agent_pins") return undefined;
      const a = args as {
        op: string;
        messageId?: number;
        replaces?: number | null;
        replacing?: number | null;
      };
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
      } else if (a.op === "replace") {
        const at = held.findIndex((p) => p.messageId === a.replaces);
        if (at < 0) {
          return {
            status: "invalid",
            message: `message ${a.replaces} is no longer pinned here; the list changed`,
          };
        }
        removed.push({ ...held[at]!, position: at });
        held[at] = { messageId: a.messageId!, position: at, pinnedBy: "human", pinnedAtMs: NOW };
        outcome = "replaced";
      } else if (a.op === "restore") {
        if (a.replacing != null) {
          const gone = held.findIndex((p) => p.messageId === a.replacing);
          if (gone >= 0) held.splice(gone, 1);
        }
        if (held.length >= 3) {
          return { status: "invalid", message: "a thread holds at most 3 pins; unpin one first" };
        }
        const back = removed.find((p) => p.messageId === a.messageId)!;
        held.splice(back.position, 0, back);
        outcome = "restored";
      }
      const pins = held.map((p, position) => ({
        ...p,
        message: p.message ?? pinnedOf(p.messageId),
        position,
      }));
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

  it("names a pin of a concurrent seat's message by what it says, in the strip and in the chooser at the cap", async () => {
    // The other seat's mail isn't in this seat's thread; the pins read says what it is.
    held.push({
      messageId: 77,
      position: 2,
      pinnedBy: "human",
      pinnedAtMs: NOW,
      message: {
        from: "BUG-142#dev6",
        createdAtMs: NOW - 5 * 60_000,
        text: "Tests pass. The rest is cleanup.",
      },
    });
    await renderOverlay(420, 700);
    const strip = await screen.findByTestId("chat-overlay-pin-77");
    expect(strip).toHaveTextContent("Tests pass.");
    expect(strip).toHaveTextContent("The rest is cleanup.");
    expect(strip).not.toHaveTextContent("Pin 77");
    fireEvent.click(pinOf(4));
    const choice = within(row(4))
      .getAllByTestId("ibx-pin-choice")
      .find((c) => c.dataset.pinId === "77")!;
    expect(choice).toHaveTextContent("Tests pass.");
    expect(choice).not.toHaveTextContent("Pin 77");
  });

  it("opens a pin of a concurrent seat's message as what it says, never as gone from the thread", async () => {
    held.push({
      messageId: 77,
      position: 2,
      pinnedBy: "human",
      pinnedAtMs: NOW,
      message: { from: "BUG-142#dev6", createdAtMs: NOW, text: "Tests pass. The rest is cleanup." },
    });
    await renderOverlay(300, 700);
    fireEvent.click(await screen.findByTestId("chat-overlay-pin-77"));
    const sheet = screen.getByRole("region", { name: "Tests pass." });
    expect(within(sheet).getByText("Tests pass. The rest is cleanup.")).toBeInTheDocument();
    expect(within(sheet).queryByText("This view is no longer in the thread.")).toBeNull();
  });

  it("opens a concurrent seat's HTML pin as its live view, by its message", async () => {
    held.push({
      messageId: 78,
      position: 2,
      pinnedBy: "human",
      pinnedAtMs: NOW,
      message: {
        from: "BUG-142#dev6",
        createdAtMs: NOW,
        text: "<title>Merge board</title><p>x</p>",
        contentType: "html",
      },
    });
    await renderOverlay(300, 700);
    fireEvent.click(await screen.findByTestId("chat-overlay-pin-78"));
    const sheet = screen.getByRole("region", { name: "Merge board" });
    expect(within(sheet).getByTestId("inbox-message-frame")).toBeInTheDocument();
    expect(within(sheet).queryByText("This view is no longer in the thread.")).toBeNull();
  });

  it("names a pin of a message the thread holds from the thread's own row, not the pins read's copy", async () => {
    held.push({
      messageId: 2,
      position: 2,
      pinnedBy: "human",
      pinnedAtMs: NOW,
      message: { from: "human", createdAtMs: NOW, text: "A shortened copy." },
    });
    await renderOverlay(420, 700);
    const strip = await screen.findByTestId("chat-overlay-pin-2");
    expect(strip).toHaveTextContent("Thanks, keep me posted.");
    expect(strip).not.toHaveTextContent("A shortened copy.");
  });

  describe("at the cap: Pin… asks which pin to replace", () => {
    const full = async () => {
      held.push({ messageId: 2, position: 2, pinnedBy: "human", pinnedAtMs: NOW });
      await renderOverlay(420, 700);
      await screen.findByTestId("chat-overlay-pin-2");
    };
    const chooser = () =>
      within(row(4)).getByRole("group", {
        name: "Replace a pin with this message · 3 of 3 pinned",
      });
    const choices = () => within(chooser()).getAllByTestId("ibx-pin-choice");
    const choiceOf = (id: number) => choices().find((c) => c.dataset.pinId === String(id))!;
    const pinsChanged = () =>
      act(() =>
        listeners
          .get(AGENT_PINS_CHANGED_EVENT)
          ?.forEach((h) =>
            h({ payload: { ...TEAM, agentId: "builtin/claude", storyId: "BUG-142" } }),
          ),
      );
    const replaceOps = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([cmd, a]) => cmd === "agent_pins" && (a as { op: string }).op !== "read",
        )
        .map(([, a]) => {
          const call = a as {
            op: string;
            messageId: number;
            replaces?: number;
            replacing?: number;
          };
          return [call.op, call.messageId, call.replaces ?? call.replacing ?? null];
        });

    it("Pin… works at the cap and opens the chooser under the message, every pin in list order, focus on the first", async () => {
      await full();
      const pin = pinOf(4);
      expect(pin).not.toHaveAttribute("aria-disabled");
      expect(pin).toHaveAccessibleName("Pin, replacing one (3 of 3 pinned)");
      expect(pin).toHaveTextContent("Pin…");
      expect(pin).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(pin);
      expect(pin).toHaveAttribute("aria-expanded", "true");
      expect(pin.getAttribute("aria-controls")).toBe(chooser().id);
      expect(choices().map((c) => c.dataset.pinId)).toEqual(["3", "1", "2"]);
      expect(choices()[0]).toHaveFocus();
      expect(choiceOf(3)).toHaveTextContent("QA");
      expect(choiceOf(3)).toHaveTextContent(/Pinned by Login timeout lead at \d\d:\d\d/);
      expect(choiceOf(2)).toHaveTextContent(/Pinned by you at/);
      expect(replaceOps()).toEqual([]);
      // The strip marks the pin the current row would replace.
      expect(screen.getByTestId("chat-overlay-pin-3")).toHaveAttribute("data-replacing", "true");
    });

    it("a click on a row that isn't current only arrives on it; the next click replaces", async () => {
      await full();
      fireEvent.click(pinOf(4));
      fireEvent.keyDown(choices()[0]!, { key: "ArrowDown" });
      fireEvent.keyDown(choiceOf(1), { key: "ArrowDown" });
      expect(choiceOf(2)).toHaveFocus();
      fireEvent.click(choiceOf(3));
      expect(replaceOps()).toEqual([]);
      expect(choiceOf(3)).toHaveAttribute("data-current", "true");
      expect(choiceOf(3)).toHaveTextContent("Replace");
      expect(choiceOf(2)).not.toHaveTextContent("Replace");
      expect(screen.getByTestId("chat-overlay-pin-3")).toHaveAttribute("data-replacing", "true");
      fireEvent.click(choiceOf(3));
      await within(row(4)).findByTestId("ibx-pin-note");
      expect(replaceOps()).toEqual([["replace", 4, 3]]);
    });

    it("the icon-only Pin… carries the cap's count, and your own pin's row shows the strip's glyph", async () => {
      await full();
      expect(pinOf(4).querySelector(".ibx-pin-cap")).toHaveTextContent("3");
      expect(pinOf(1).querySelector(".ibx-pin-cap")).toBeNull();
      fireEvent.click(pinOf(4));
      expect(choiceOf(2)).toHaveAttribute("data-own", "quote");
      expect(choiceOf(3)).not.toHaveAttribute("data-own");
    });

    it("moves between rows with the arrow keys, Home and End, which never reach the thread; Esc closes back to Pin…", async () => {
      await full();
      fireEvent.click(pinOf(4));
      fireEvent.keyDown(choices()[0]!, { key: "ArrowDown" });
      expect(choiceOf(1)).toHaveFocus();
      expect(screen.getByTestId("chat-overlay-pin-1")).toHaveAttribute("data-replacing", "true");
      fireEvent.keyDown(choiceOf(1), { key: "End" });
      expect(choiceOf(2)).toHaveFocus();
      fireEvent.keyDown(choiceOf(2), { key: "ArrowDown" });
      expect(choiceOf(2)).toHaveFocus();
      fireEvent.keyDown(choiceOf(2), { key: "Home" });
      expect(choiceOf(3)).toHaveFocus();
      // One Tab stop among the rows; Tab goes on to Cancel.
      expect(choices().filter((c) => c.tabIndex === 0)).toEqual([choiceOf(3)]);
      expect(within(chooser()).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      fireEvent.keyDown(choiceOf(3), { key: "Escape" });
      expect(within(row(4)).queryByTestId("ibx-pin-chooser")).toBeNull();
      expect(pinOf(4)).toHaveFocus();
      expect(screen.getByTestId("chat-overlay")).toBeInTheDocument();
    });

    it("one choice replaces in place, says so with Undo and moves focus to Unpin; one Undo puts both back", async () => {
      await full();
      fireEvent.click(pinOf(4));
      fireEvent.keyDown(choices()[0]!, { key: "ArrowDown" });
      fireEvent.keyDown(choiceOf(1), { key: "Enter" });
      const note = await within(row(4)).findByTestId("ibx-pin-note");
      expect(note).toHaveTextContent("Replaced Login timeout lead's pin “Tests”.");
      expect(replaceOps()).toEqual([["replace", 4, 1]]);
      // In the replaced pin's place, and nothing else moved.
      const strip = () =>
        [...document.querySelectorAll<HTMLElement>('[data-testid^="chat-overlay-pin-"]')].map(
          (el) => el.dataset.testid,
        );
      expect(strip()).toEqual(["chat-overlay-pin-3", "chat-overlay-pin-4", "chat-overlay-pin-2"]);
      await waitFor(() => expect(pinOf(4)).toHaveFocus());
      expect(pinOf(4)).toHaveAccessibleName("Unpin");
      expect(screen.getByTestId("ibx-pin-live")).toHaveTextContent(
        "Replaced Login timeout lead's pin “Tests”.",
      );
      fireEvent.click(within(note).getByRole("button", { name: "Undo" }));
      await waitFor(() =>
        expect(strip()).toEqual(["chat-overlay-pin-3", "chat-overlay-pin-1", "chat-overlay-pin-2"]),
      );
      expect(replaceOps()).toEqual([
        ["replace", 4, 1],
        ["restore", 1, 4],
      ]);
      await waitFor(() => expect(pinOf(4)).toHaveFocus());
      expect(pinOf(4)).toHaveAccessibleName("Pin, replacing one (3 of 3 pinned)");
      expect(within(row(4)).queryByRole("button", { name: "Undo" })).toBeNull();
    });

    it("a pin the agent swapped in while the chooser is open is new and must be arrived on before it can be replaced", async () => {
      await full();
      fireEvent.click(pinOf(4));
      // The agent swaps "QA" (3) for message 1's neighbour 5.
      arrive(msg(5, LEAD, "human", "Trace for QA"));
      await screen.findByText("Trace for QA");
      held[0] = {
        messageId: 5,
        position: 0,
        pinnedBy: LEAD,
        pinnedAtMs: NOW,
        preview: { shortName: "QA trace" },
      };
      pinsChanged();
      await waitFor(() => expect(choiceOf(5)).toBeDefined());
      const fresh = choiceOf(5);
      expect(fresh).toHaveTextContent("New");
      const changed = await within(chooser()).findByTestId("ibx-pin-change");
      expect(changed).toHaveTextContent("“QA trace” is new");
      // The row the person was on left: no row is chosen, focus is on the change line.
      await waitFor(() => expect(within(chooser()).getByTestId("ibx-pin-change")).toHaveFocus());
      expect(choices().filter((c) => c.dataset.current)).toEqual([]);
      fireEvent.click(fresh);
      expect(within(chooser()).getByTestId("ibx-pin-change")).toHaveTextContent(
        "“QA trace” is new. Choose it again to replace it.",
      );
      expect(replaceOps()).toEqual([]);
      fireEvent.click(fresh);
      await within(row(4)).findByTestId("ibx-pin-note");
      expect(replaceOps()).toEqual([["replace", 4, 5]]);
    });

    it("a pin that left while the chooser is open leaves room: it offers a plain Pin and replaces nothing", async () => {
      await full();
      fireEvent.click(pinOf(4));
      held.splice(2, 1);
      pinsChanged();
      const room = await within(row(4)).findByText("There's room now.");
      expect(within(row(4)).queryAllByTestId("ibx-pin-choice")).toEqual([]);
      fireEvent.click(
        within(room.closest("[role=group]") as HTMLElement).getByRole("button", { name: "Pin" }),
      );
      await screen.findByTestId("chat-overlay-pin-4");
      expect(replaceOps()).toEqual([["pin", 4, null]]);
    });

    it("a replace that fails keeps the chooser and its row, and says nothing changed", async () => {
      await full();
      fireEvent.click(pinOf(4));
      failNext = true;
      fireEvent.click(choiceOf(3));
      const alert = await within(chooser()).findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't replace. Nothing changed.");
      expect(choiceOf(3)).toHaveFocus();
      expect(screen.getByTestId("chat-overlay-pin-3")).toBeInTheDocument();
    });

    it("Esc on a replace's Undo closes the note and keeps focus on the message's pin button", async () => {
      await full();
      fireEvent.click(pinOf(4));
      fireEvent.click(choiceOf(3));
      const note = await within(row(4)).findByTestId("ibx-pin-note");
      const undo = within(note).getByRole("button", { name: "Undo" });
      act(() => undo.focus());
      fireEvent.keyDown(undo, { key: "Escape" });
      expect(within(row(4)).queryByTestId("ibx-pin-note")).toBeNull();
      await waitFor(() => expect(pinOf(4)).toHaveFocus());
    });

    it("an Undo refused because the list filled again goes away, keeps the new pin, says why and keeps focus on the message", async () => {
      await full();
      fireEvent.click(pinOf(4));
      fireEvent.click(choiceOf(3));
      const note = await within(row(4)).findByTestId("ibx-pin-note");
      // The agent takes the new pin off and fills its place: the restore would go past the cap.
      held[0] = { messageId: 5, position: 0, pinnedBy: LEAD, pinnedAtMs: NOW };
      const undo = within(note).getByRole("button", { name: "Undo" });
      undo.focus();
      fireEvent.click(undo);
      await waitFor(() =>
        expect(within(row(4)).getByTestId("ibx-pin-note")).toHaveTextContent(
          "Can't undo: the list is full again.",
        ),
      );
      expect(within(row(4)).queryByRole("button", { name: "Undo" })).toBeNull();
      // Undo left the page; focus goes back to the message's pin button, not to the page body.
      await waitFor(() => expect(pinOf(4)).toHaveFocus());
    });
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

  it("keeps the new pin marked through keys typed into the CLI while the chat is hidden", async () => {
    const overlay = (visible: boolean) => (
      <div>
        <ChatOverlay
          tabId="tab-1"
          sessionId={SESSION}
          teamKey={TEAM_KEY}
          composeRequest={0}
          size={{ width: 420, height: 700 }}
          visible={visible}
        />
      </div>
    );
    const { rerender } = render(overlay(true));
    await screen.findByTestId("chat-overlay-pin-3");
    fireEvent.click(pinOf(4));
    expect(await screen.findByTestId("chat-overlay-pin-4")).toHaveAttribute("data-new", "true");
    rerender(overlay(false));
    fireEvent.keyDown(window, { key: "l" });
    fireEvent.pointerDown(window);
    rerender(overlay(true));
    expect(screen.getByTestId("chat-overlay-pin-4")).toHaveAttribute("data-new", "true");
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

  it("a real needs-you snapshot pins from its title bar through the pins bridge, named by the message's summary", async () => {
    // The live dashboard a lead sends when asked what needs you (its first heading is "What needs you").
    const snapshot = readFileSync(
      resolve(__dirname, "../../../../tests/fixtures/needs-you-snapshot.html"),
      "utf-8",
    );
    arrive(
      msg(6, LEAD, "human", snapshot, {
        contentType: "html",
        summary: "Two things wait on you",
      }),
    );
    await renderOverlay(420, 700);
    await screen.findByTestId("chat-overlay-pin-3");
    const bar = within(row(6)).getByTestId("ibx-dm-bar");
    expect(bar).toHaveTextContent("Two things wait on you");
    fireEvent.click(within(bar).getByTestId("ibx-pin"));
    await waitFor(() => expect(ops()).toContainEqual(["pin", 6]));
    const chip = await screen.findByTestId("chat-overlay-pin-6");
    expect(chip).toHaveTextContent("Two things wait on you");
    expect(chip).not.toHaveTextContent("What needs you");
  });
});

describe("ChatOverlay for the Foreman", () => {
  const DOCS_ROOT = "/ctx/codesense-docs";
  const DOCS_TEAM = { org: "codesense/docs", team: "getting-started" };
  const FOREMAN = "_worker/codesense/docs/getting-started/foreman";
  const EARLIER = "_worker/codesense/docs/getting-started/foreman-2";
  const FOREMAN_SESSION = "sess-foreman";
  const FOREMAN_AGENT_ID = "codesense/docs/getting-started/foreman-claude";
  const fm = (id: number, from: string, to: string, text: string, at: number) =>
    msg(id, from, to, text, { team: DOCS_TEAM, fromName: "Foreman", createdAtMs: at });
  const EARLIER_MAIL = [
    fm(1, EARLIER, "human", "Hello from the earlier Foreman.", NOW - 3_600_000),
  ];
  const LIVE_MAIL = [fm(2, FOREMAN, "human", "Hello from the live Foreman.", NOW - 60_000)];
  // The Foreman page's shared UI state (`ui:foreman`): its sender set, newest first.
  let senders: string[];
  // Its live hosted setup sessions (`setupLive`), which the page publishes there too.
  let setupLive: string[];
  const SETUP = "_worker/codesense/docs/getting-started/setup";
  let setupAlive: boolean | null;
  const realWatch = liveHub.watch.bind(liveHub);

  // The view key the host files the page's `ui:foreman` state under: "all" under the Open
  // preset (the default), the frame's team under Team-safe.
  let preset: "open" | "team-safe";
  const viewKeyOf = () =>
    preset === "team-safe" ? `team:${DOCS_TEAM.org}/${DOCS_TEAM.team}` : "all";
  const uiWatches: string[] = [];

  function foremanSetup(store: Map<string, ConversationMessage[]>) {
    usePrefsStore.setState({ owned: { dashboardPolicy: { preset } }, ownedReady: true });
    // The docs team declares no agent_page: the Foreman's Full view comes from openForeman.
    useOrgStore.setState({
      orgs: [
        {
          slug: DOCS_TEAM.org,
          org_root: DOCS_ROOT,
          teams: [{ name: DOCS_TEAM.team, source_repos: [] }],
        },
      ] as never,
    });
    useAgentListProjectionStore.setState({
      sessions: [
        {
          handle: FOREMAN,
          sessionId: FOREMAN_SESSION,
          kind: "claude",
          alive: true,
          displayName: "Foreman",
          agentRevision: `${FOREMAN_AGENT_ID}@4`,
          story: null,
          role: null,
          startedAtMs: NOW - 5 * 60_000,
        } as unknown as AgentSessionRow,
        ...(setupAlive === null
          ? []
          : [
              {
                handle: SETUP,
                sessionId: "sess-setup",
                kind: "claude",
                alive: setupAlive,
                displayName: "Setup",
                story: null,
                role: null,
                startedAtMs: NOW - 60_000,
              } as unknown as AgentSessionRow,
            ]),
      ],
    });
    useAgentStateStore.setState({
      processAgentBySession: { [FOREMAN_SESSION]: "claude" },
    } as never);
    api.loadSessionInbox.mockImplementation(async (key: string) => {
      const handle = key === FOREMAN_SESSION ? FOREMAN : key;
      return {
        dto: { handle, roles: [], messages: [...(store.get(handle) ?? [])] },
        source: "live",
      };
    });
    vi.spyOn(liveHub, "watch").mockImplementation((topic, viewKey, callback, options) => {
      if (topic !== "ui:foreman") return realWatch(topic, viewKey, callback, options);
      uiWatches.push(viewKey);
      if (viewKey !== viewKeyOf()) return () => {};
      callback({ topic, viewKey, rev: 0, snapshot: [{ id: topic, senders, setupLive }] } as never);
      return () => {};
    });
  }

  async function renderForeman(teamKey = `${DOCS_TEAM.org}:${DOCS_TEAM.team}`) {
    render(
      <ChatOverlay
        tabId="tab-fm"
        sessionId={FOREMAN_SESSION}
        teamKey={teamKey}
        composeRequest={0}
        size={{ width: 420, height: 700 }}
      />,
    );
    await screen.findByText("Hello from the live Foreman.");
  }

  beforeEach(() => {
    senders = [FOREMAN, EARLIER];
    setupLive = [];
    setupAlive = null;
    preset = "open";
    uiWatches.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("knows the Foreman by its saved agent, never its name", () => {
    expect(isForemanAgent(FOREMAN_AGENT_ID)).toBe(true);
    expect(isForemanAgent(`${FOREMAN_AGENT_ID}@4`)).toBe(true);
    expect(isForemanAgent(FOREMAN_AGENT)).toBe(true);
    expect(isForemanAgent("acme/widgets/not-foreman-claude")).toBe(false);
    expect(isForemanAgent("Foreman")).toBe(false);
    expect(isForemanAgent(null)).toBe(false);
  });

  it.each(["open", "team-safe"] as const)(
    "under the %s preset reads the page's sender set where the host files it",
    async (which) => {
      preset = which;
      foremanSetup(
        new Map([
          [FOREMAN, LIVE_MAIL],
          [EARLIER, EARLIER_MAIL],
        ]),
      );
      await renderForeman();
      await screen.findByText("Hello from the earlier Foreman.");
      expect(new Set(uiWatches)).toEqual(new Set([viewKeyOf()]));
    },
  );

  it("shows the page's thread: the earlier Foreman sessions' messages, then the live one's, oldest first", async () => {
    foremanSetup(
      new Map([
        [FOREMAN, LIVE_MAIL],
        [EARLIER, EARLIER_MAIL],
      ]),
    );
    await renderForeman();
    await screen.findByText("Hello from the earlier Foreman.");
    const shown = Array.from(screen.getByTestId("ibx-msgs").querySelectorAll(".ibx-m"));
    expect(shown.map((m) => m.textContent)).toEqual([
      expect.stringContaining("Hello from the earlier Foreman."),
      expect.stringContaining("Hello from the live Foreman."),
    ]);
    expect(api.loadSessionInbox).toHaveBeenCalledWith(EARLIER);
    // The Foreman merges its own sessions; it never reads a thread.
    expect(api.loadThreadInbox).not.toHaveBeenCalled();
  });

  it("reads no more earlier sessions than the page keeps in its thread", async () => {
    senders = [FOREMAN, ...Array.from({ length: 8 }, (_, i) => `${EARLIER}-${i}`)];
    foremanSetup(new Map([[FOREMAN, LIVE_MAIL]]));
    await renderForeman();
    await waitFor(() =>
      expect(api.loadSessionInbox).toHaveBeenCalledWith(senders[FOREMAN_HISTORY - 1]),
    );
    expect(api.loadSessionInbox).not.toHaveBeenCalledWith(senders[FOREMAN_HISTORY]);
  });

  it("reads the pins the page reads: the docs team, the Foreman's agent, no story", async () => {
    foremanSetup(new Map([[FOREMAN, LIVE_MAIL]]));
    await renderForeman();
    const pinReads = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "agent_pins")
        .map(([, args]) => {
          const a = args as { team: unknown; agentId: string; storyId: string | null };
          // The engine keys a thread by the saved agent before `@` and the story ("" for none).
          return { team: a.team, agent: a.agentId.split("@")[0], story: a.storyId ?? "" };
        });
    await waitFor(() => expect(pinReads()).toHaveLength(1));
    const overlay = pinReads()[0];
    expect(overlay).toEqual({ team: DOCS_TEAM, agent: FOREMAN_AGENT_ID, story: "" });

    // The page's shared read (the bridge's `pins` verb): the Foreman's row's agent, no story, in its frame's team.
    vi.mocked(invoke).mockClear();
    await runBridgeCommand(
      "pins",
      { agentId: FOREMAN_AGENT_ID },
      {
        frameGrant: {
          frameId: "f-1",
          principal: "human",
          dashboard: "foreman",
          slot: "centre",
          team: DOCS_TEAM,
          scope: "team",
        },
      },
    );
    expect(pinReads()).toEqual([overlay]);
  });

  it("opens the one Foreman tab from Full view, though the docs team declares no agent page", async () => {
    foremanSetup(new Map([[FOREMAN, LIVE_MAIL]]));
    await renderForeman();
    fireEvent.click(screen.getByRole("button", { name: "Full view" }));
    expect(openFile).toHaveBeenCalledWith(
      { ...DOCS_TEAM, path: `${DOCS_ROOT}/getting-started/content/foreman/index.html` },
      { newTab: true },
    );
    expect(openFullView).not.toHaveBeenCalled();
  });

  it("while the page's hosted setup runs, says so with Open full view, which opens the Foreman tab", async () => {
    setupLive = [SETUP];
    setupAlive = true;
    foremanSetup(new Map([[FOREMAN, LIVE_MAIL]]));
    await renderForeman();
    const row = await screen.findByTestId("chat-overlay-setup");
    expect(row).toHaveAttribute("role", "status");
    expect(row).toHaveTextContent("Setup is running");
    fireEvent.click(within(row).getByRole("button", { name: "Open full view" }));
    expect(openFile).toHaveBeenCalledWith(
      { ...DOCS_TEAM, path: `${DOCS_ROOT}/getting-started/content/foreman/index.html` },
      { newTab: true },
    );
  });

  it.each([
    ["none is published", [] as string[], true],
    ["the published session has ended", ["_worker/codesense/docs/getting-started/setup"], false],
  ])("shows no setup row when %s", async (_why, live, alive) => {
    setupLive = live;
    setupAlive = alive;
    foremanSetup(new Map([[FOREMAN, LIVE_MAIL]]));
    await renderForeman();
    expect(screen.queryByTestId("chat-overlay-setup")).toBeNull();
  });

  it("a send in the overlay goes to the live Foreman, shows in its thread, and is a handle the page's thread reads", async () => {
    const store = new Map([
      [FOREMAN, [...LIVE_MAIL]],
      [EARLIER, EARLIER_MAIL],
    ]);
    foremanSetup(store);
    api.sendAsHuman.mockImplementation(async (_team: unknown, to: string, text: string) => {
      store.get(to)?.push(fm(3, "human", to, text, Date.now()));
      return { status: "sent", messageId: 3 };
    });
    await renderForeman();
    const box = composerBox();
    fireEvent.change(box, { target: { value: "What needs me?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.sendAsHuman).toHaveBeenCalled());
    const to = api.sendAsHuman.mock.calls[0]![1] as string;
    expect(to).toBe(FOREMAN);
    await act(async () => {
      listeners.get(AGENT_INBOX_CHANGED_EVENT)?.forEach((h) => h({ payload: null }));
    });
    // It renders in the overlay's own thread, read back from the live Foreman's inbox: the inbox
    // the page's thread reads for that handle.
    const thread = screen.getByTestId("ibx-msgs");
    expect(await within(thread).findByText("What needs me?")).toBeInTheDocument();
  });

  it("re-reads an earlier sender when the inbox changes: a second, still running Foreman's new message shows", async () => {
    const store = new Map([
      [FOREMAN, [...LIVE_MAIL]],
      [EARLIER, [...EARLIER_MAIL]],
    ]);
    foremanSetup(store);
    await renderForeman();
    await screen.findByText("Hello from the earlier Foreman.");
    store.get(EARLIER)!.push(fm(5, EARLIER, "human", "The other Foreman is still here.", NOW));
    await act(async () => {
      listeners.get(AGENT_INBOX_CHANGED_EVENT)?.forEach((h) => h({ payload: null }));
    });
    expect(await screen.findByText("The other Foreman is still here.")).toBeInTheDocument();
  });

  it("names a pin on an earlier session's message by that message, not by its id", async () => {
    foremanSetup(
      new Map([
        [FOREMAN, LIVE_MAIL],
        [EARLIER, EARLIER_MAIL],
      ]),
    );
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "agent_pins"
        ? {
            status: "pins",
            team: DOCS_TEAM,
            agentId: FOREMAN_AGENT_ID,
            storyId: null,
            pins: [
              {
                messageId: 1,
                position: 0,
                pinnedBy: "human",
                pinnedAtMs: NOW,
                preview: null,
                message: {
                  from: EARLIER,
                  createdAtMs: NOW,
                  text: "Hello from the earlier Foreman.",
                },
              },
            ],
          }
        : undefined,
    );
    await renderForeman();
    await within(screen.getByTestId("ibx-msgs")).findByText("Hello from the earlier Foreman.");
    const strip = await waitFor(() => {
      const el = screen.getByTestId("chat-overlay").querySelector<HTMLElement>(".ibx-ov-pins");
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(strip.textContent).toMatch(/Hello from the earlier Foreman/));
    expect(strip.textContent).not.toMatch(/Pin 1\b/);
  });

  it("keeps the Foreman's pins on the docs team when its chat lives in another team", async () => {
    const USER_TEAM = { org: "acme", team: "widgets" };
    const moved = [{ ...LIVE_MAIL[0]!, team: USER_TEAM }];
    foremanSetup(new Map([[FOREMAN, moved]]));
    await renderForeman("acme:widgets");
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "agent_pins")).toBe(true),
    );
    const teams = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "agent_pins")
      .map(([, args]) => (args as { team: unknown }).team);
    expect(teams).toEqual(teams.map(() => DOCS_TEAM));
  });

  it("names, cards and opens a pin on a lead's message to the Foreman", async () => {
    const LEAD_TO_FOREMAN = fm(7, "acme-lead", FOREMAN, "Lead note for the Foreman.", NOW - 30_000);
    foremanSetup(new Map([[FOREMAN, [...LIVE_MAIL, LEAD_TO_FOREMAN]]]));
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "agent_pins"
        ? {
            status: "pins",
            team: DOCS_TEAM,
            agentId: FOREMAN_AGENT_ID,
            storyId: null,
            pins: [
              {
                messageId: 7,
                position: 0,
                pinnedBy: "human",
                pinnedAtMs: NOW,
                preview: null,
                message: {
                  from: "acme-lead",
                  createdAtMs: NOW - 30_000,
                  text: "Lead note for the Foreman.",
                },
              },
            ],
          }
        : undefined,
    );
    await renderForeman();
    const strip = await waitFor(() => {
      const el = screen.getByTestId("chat-overlay").querySelector<HTMLElement>(".ibx-ov-pins");
      expect(el?.textContent).toMatch(/Lead note for the Foreman/);
      return el!;
    });
    expect(strip.textContent).not.toMatch(/Pin 7\b/);
    const card = strip.querySelector<HTMLButtonElement>("button");
    expect(card).not.toBeNull();
    fireEvent.click(card!);
    expect(screen.queryByText("This view is no longer in the thread.")).toBeNull();
    expect(screen.getAllByText(/Lead note for the Foreman/).length).toBeGreaterThan(1);
  });
});

describe("ChatOverlay in its tab: the Chat | CLI flip", () => {
  const TAB = { id: "tab-1", sessionId: SESSION };
  async function renderTab() {
    render(
      <div data-focus-pane="tab-1" data-pane-active="">
        <InboxSplit tab={TAB} teamKey={TEAM_KEY}>
          <div className="xterm">
            <textarea data-testid="cli" />
          </div>
        </InboxSplit>
      </div>,
    );
    act(() => openAgentInboxRail(SESSION));
    await screen.findByText("Review is clean; merge card is next.");
  }
  const flip = () => act(() => flipAgentView(SESSION));
  const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const reads = () =>
    api.loadThreadInbox.mock.calls.length + api.loadSessionInbox.mock.calls.length;
  const markedRead = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "mark_inbox_message_read")
      .map(([, args]) => (args as { messageId: number }).messageId);

  it("five flips mount the chat once: back on the chat, the same thread, scroll and draft, read once", async () => {
    await renderTab();
    const chat = screen.getByTestId("chat-overlay");
    const thread = screen.getByTestId("ibx-msgs");
    thread.scrollTop = 40;
    fireEvent.change(composerBox(), { target: { value: "half a thought" } });
    const before = reads();
    for (let i = 0; i < 5; i++) {
      flip();
      expect(screen.getByTestId("chat-overlay")).toBe(chat);
      // No loading frame stands in for the chat on either side.
      expect(document.querySelectorAll(".ibx-ov")).toHaveLength(1);
    }
    expect(useAgentInboxRailStore.getState().bySession[SESSION]?.shown).toBe(false);
    expect(chat).not.toBeVisible();
    flip();
    expect(chat).toBeVisible();
    expect(screen.getByTestId("ibx-msgs")).toBe(thread);
    expect(thread.scrollTop).toBe(40);
    expect(composerBox().value).toBe("half a thought");
    expect(reads()).toBe(before);
  });

  it("hidden, the chat marks nothing read and leaves the keyboard on the CLI; shown, it reads", async () => {
    const box = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 420,
      bottom: 700,
      width: 420,
      height: 700,
      toJSON: () => ({}),
    });
    try {
      await renderTab();
      flip();
      await nextFrame();
      const cli = screen.getByTestId("cli");
      expect(cli).toHaveFocus();
      arrive(msg(7, LEAD, "human", "Sent while the CLI shows", { unread: true }));
      expect(await screen.findByText("Sent while the CLI shows")).not.toBeVisible();
      await nextFrame();
      expect(markedRead()).not.toContain(7);
      expect(cli).toHaveFocus();
      expect(screen.getByTestId("chat-overlay").closest("[inert]")).not.toBeNull();
      flip();
      await waitFor(() => expect(markedRead()).toContain(7));
      expect(screen.getByTestId("chat-overlay").closest("[inert]")).toBeNull();
    } finally {
      box.mockRestore();
    }
  });
});

describe("ChatOverlay on a successor session", () => {
  it("reads the thread of its saved agent and story, so its predecessor's mail shows though the roster no longer lists it", async () => {
    api.loadThreadInbox.mockResolvedValue({
      dto: {
        handle: LEAD,
        agentId: "builtin/claude",
        storyId: "BUG-142",
        sessions: ["BUG-142#lead-old", LEAD],
        addresses: ["sess-old", "BUG-142#lead-old", SESSION, LEAD],
        roles: [],
        messages: [
          msg(1, "human", "BUG-142#lead-old", "Asked the first session"),
          msg(2, "BUG-142#lead-old", "human", "The first session answered"),
          // Mail the thread read found by the predecessor's tab session id.
          msg(3, "sess-old", "human", "Sent from the first session's tab"),
          ...MESSAGES,
        ],
      },
      source: "live",
    });
    await renderOverlay(420, 700);
    expect(await screen.findByText("The first session answered")).toBeInTheDocument();
    expect(screen.getByText("Asked the first session")).toBeInTheDocument();
    expect(screen.getByText("Sent from the first session's tab")).toBeInTheDocument();
    expect(api.loadThreadInbox).toHaveBeenCalledWith(
      JSON.stringify(["builtin/claude", "BUG-142", SESSION]),
    );
    expect(api.loadSessionInbox).not.toHaveBeenCalledWith(SESSION);
  });

  it("marks the predecessor's mail read on screen as it does the session's own, and nothing else", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 420,
      bottom: 700,
      width: 420,
      height: 700,
      toJSON: () => ({}),
    });
    api.loadThreadInbox.mockResolvedValue({
      dto: {
        handle: LEAD,
        agentId: "builtin/claude",
        storyId: "BUG-142",
        sessions: ["BUG-142#lead-old", LEAD],
        addresses: ["sess-old", "BUG-142#lead-old", SESSION, LEAD],
        roles: [],
        messages: [
          msg(41, "BUG-142#lead-old", "human", "Unread from the first session", { unread: true }),
          msg(42, "sess-old", "human", "Unread from its tab", { unread: true }),
          msg(43, LEAD, "human", "Unread from this session", { unread: true }),
          msg(44, "human", "BUG-142#lead-old", "Sent by you", { unread: true }),
          ...MESSAGES,
        ],
      },
      source: "live",
    });
    await renderOverlay(420, 700);
    await screen.findByText("Unread from this session");
    const read = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "mark_inbox_message_read")
        .map(([, args]) => (args as { messageId: number }).messageId)
        .sort();
    await waitFor(() => expect(read()).toEqual([41, 42, 43]));
    vi.restoreAllMocks();
  });

  it("reads one session's inbox when the session was launched from no saved agent", async () => {
    roster({ agentRevision: null, story: null });
    await renderOverlay(420, 700);
    await waitFor(() => expect(api.loadSessionInbox).toHaveBeenCalledWith(SESSION));
    expect(api.loadThreadInbox).not.toHaveBeenCalled();
  });
});

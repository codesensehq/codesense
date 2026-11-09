// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pane's own script on a stub `window.codesense`, under fake timers, so the test owns the
// pane's clock. The seam tests drive the same pane through the real bridge.
const PANE = readFileSync(resolve(__dirname, "../__fixtures__/inbox-pane.html"), "utf8");
const page = new DOMParser().parseFromString(PANE, "text/html");
const SCRIPT = [...page.querySelectorAll("script:not([src])")].map((s) => s.textContent).join(";");

const TEAM = { org: "acme", team: "web" };
type Row = { id: number; from: string; to: string; unread: boolean };
type Scope = "all-teams" | "team";

function boot(rows: Row[], scope: Scope) {
  const nudges = new Set<(change: unknown) => void>();
  const shows = new Set<(shown: boolean) => void>();
  const intents = new Set<(intent: unknown) => void>();
  // When each list read started, on the pane's monotonic clock.
  const readAt: number[] = [];
  const view = () => {
    const messages = rows.map((m) => ({
      ...m,
      messageId: m.id,
      toHuman: m.to === "human",
      fromName: m.from,
      toName: m.to,
      team: TEAM,
      conversation: m.from === "human" ? m.to : m.from,
      text: "Message " + m.id,
      createdAtMs: m.id * 1000,
      contentType: "markdown",
    }));
    const conversations = new Map<string, Record<string, unknown>>();
    for (const m of messages) {
      const c = conversations.get(m.conversation) ?? {
        with: m.conversation,
        team: TEAM,
        unread: 0,
        messageCount: 0,
      };
      c.messageCount = (c.messageCount as number) + 1;
      if (m.to === "human" && m.unread) c.unread = (c.unread as number) + 1;
      Object.assign(c, { lastMessageId: m.id, lastAt: m.createdAtMs, lastPreview: m.text });
      conversations.set(m.conversation, c);
    }
    return { messages, conversations: [...conversations.values()], hasMore: false };
  };
  const cs = {
    context: vi.fn(async () => ({
      org: TEAM.org,
      team: scope === "team" ? TEAM.team : null,
      inboxScope: scope,
      activeTeam: TEAM,
      inboxTeams: [TEAM],
    })),
    prefs: vi.fn(async () => ({})),
    setPrefs: vi.fn(async () => ({})),
    inboxRollup: vi.fn(async () => {
      readAt.push(performance.now());
      return view();
    }),
    inbox: vi.fn(async (query: { scope?: string }) => {
      if (query.scope === "to-human") readAt.push(performance.now());
      const all = view();
      if (query.scope === "to-human")
        return { ...all, messages: all.messages.filter((m) => m.toHuman) };
      if (query.scope === "to-agents")
        return { ...all, messages: all.messages.filter((m) => !m.toHuman) };
      return all;
    }),
    roles: vi.fn(async () => ({ roles: [] })),
    humanStatus: vi.fn(async () => ({ status: "online", note: "" })),
    agents: vi.fn(async () => []),
    // Mia runs, so the composer can reply to her.
    subscribe: vi.fn(async (_topic: string, { onChange }: { onChange: (s: unknown) => void }) => {
      onChange({ snapshot: [{ handle: "Mia", state: "idle" }] });
      return {};
    }),
    unsubscribe: vi.fn(async () => {}),
    act: vi.fn(async (verb: string) =>
      verb === "sendAsHuman" || verb === "replyAsHuman" ? { status: "sent" } : {},
    ),
    setBadge: vi.fn(),
    onInboxChanged: (cb: (change: unknown) => void) => nudges.add(cb),
    onVisibility: (cb: (shown: boolean) => void) => shows.add(cb),
    onIntent: (cb: (intent: unknown) => void) => intents.add(cb),
    onCommand: () => {},
    onMenuAction: () => {},
    onFocusIn: () => {},
    onTeardown: () => {},
    onAgentsChanged: () => {},
    openFile: vi.fn(),
    ready: vi.fn(),
  };
  document.head.innerHTML = page.head.innerHTML;
  document.body.innerHTML = page.body.innerHTML;
  (window as unknown as { codesense: typeof cs }).codesense = cs;
  new Function(SCRIPT)();
  // The list read each refresh makes: the rollup across teams, or the team's to-human page.
  const reads = () =>
    scope === "all-teams"
      ? cs.inboxRollup.mock.calls.length
      : cs.inbox.mock.calls.filter(([q]) => q.scope === "to-human").length;
  return {
    cs,
    rows,
    reads,
    readAt,
    nudge: (ids?: number[], team = TEAM) =>
      nudges.forEach((cb) => cb(ids ? { changes: [{ team, messageIds: ids }] } : {})),
    // What the host's live-hub shim passes after a sessions re-read.
    sessionsNudge: () =>
      nudges.forEach((cb) => cb({ type: "codesense:inbox-changed", changes: [] })),
    show: (shown: boolean) => shows.forEach((cb) => cb(shown)),
    intent: (intent: unknown) => intents.forEach((cb) => cb(intent)),
    listRows: () => document.querySelectorAll(".ib-row").length,
    view: () => document.getElementById("inbox")!.dataset.view,
  };
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("inbox pane refresh pacing", () => {
  async function shown(seed: Row[], scope: Scope = "all-teams") {
    const rows = seed.map((r) => ({ ...r }));
    const p = boot(rows, scope);
    p.show(true);
    await settle(50);
    expect(p.listRows()).toBe(new Set(rows.map((r) => (r.from === "human" ? r.to : r.from))).size);
    await settle(2000);
    vi.clearAllMocks();
    p.readAt.length = 0;
    return p;
  }
  const MIA: Row = { id: 1, from: "Mia", to: "human", unread: true };
  const SENT: Row = { id: 2, from: "human", to: "Mia", unread: false };

  it.each<Scope>(["all-teams", "team"])(
    "coalesces 100 nudges for agents' mail in one second into at most two reads (%s)",
    async (scope) => {
      const p = await shown([MIA], scope);
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        p.nudge([100 + i]);
        await settle(10);
      }
      expect(p.readAt.filter((at) => at < start + 1000)).toHaveLength(2);
      await settle(2000);
      // One trailing read for the nudges after the second read, then idle: no timer keeps reading.
      expect(p.reads()).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
      await settle(10_000);
      expect(p.reads()).toBe(3);
    },
  );

  it("keeps an agent burst mixed with changes to the human's loaded mail at two reads a second", async () => {
    const p = await shown([MIA, SENT]);
    for (let i = 0; i < 300; i++) {
      p.nudge(i % 7 ? [100 + i] : [1]);
      await settle(10);
    }
    await settle(2000);
    expect(p.readAt.length).toBeGreaterThanOrEqual(3);
    // No second-long span holds more than two reads.
    for (let i = 2; i < p.readAt.length; i++)
      expect(p.readAt[i] - p.readAt[i - 2]).toBeGreaterThanOrEqual(1000);
  });

  it("doesn't skip the window for changes to the human's own sent mail", async () => {
    const p = await shown([MIA, SENT]);
    p.nudge([100]);
    await settle(30);
    p.nudge([2]);
    await settle(300);
    expect(p.reads()).toBe(1);
    await settle(500);
    expect(p.reads()).toBe(2);
  });

  it("ignores the empty change the host sends after a sessions re-read", async () => {
    const p = await shown([MIA]);
    p.sessionsNudge();
    await settle(2000);
    p.show(false);
    await settle(2000);
    vi.clearAllMocks();
    p.sessionsNudge();
    await settle(2000);
    expect(p.reads()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paces on the monotonic clock, so a wall clock stepped back doesn't stall it", async () => {
    const p = await shown([MIA]);
    p.nudge([100]);
    await settle(30);
    vi.setSystemTime(Date.now() - 60_000);
    p.nudge([101]);
    await settle(800);
    expect(p.reads()).toBe(2);
  });

  it("skips nudges that name only another team's rows on a single-team pane", async () => {
    const p = await shown([MIA], "team");
    p.nudge([9], { org: "acme", team: "ops" });
    await settle(2000);
    expect(p.reads()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows new mail at once on the first nudge after a quiet second", async () => {
    const p = await shown([MIA]);
    p.rows.push({ id: 3, from: "Lee", to: "human", unread: true });
    p.nudge([3]);
    await settle(30);
    expect(p.reads()).toBe(1);
    expect(p.listRows()).toBe(2);
  });

  it("shows the human's mail within 750 ms inside a burst of agents' mail", async () => {
    const p = await shown([MIA]);
    p.nudge([100]);
    await settle(30);
    p.rows.push({ id: 3, from: "Lee", to: "human", unread: true });
    p.nudge([3]);
    for (let i = 0; i < 20; i++) {
      p.nudge([101 + i]);
      await settle(10);
    }
    expect(p.listRows()).toBe(1);
    // 750 ms after the human's mail was nudged, leaving the rest of the second for the read.
    await settle(550);
    expect(p.listRows()).toBe(2);
    expect(p.reads()).toBe(2);
  });

  it("waits only 250 ms for a change to a loaded row of the human's mail", async () => {
    const p = await shown([MIA]);
    p.nudge([100]);
    await settle(30);
    expect(p.reads()).toBe(1);
    p.rows[0].unread = false;
    p.nudge([1]);
    await settle(200);
    expect(p.reads()).toBe(1);
    await settle(50);
    expect(p.reads()).toBe(2);
  });

  it("counts a refresh the human starts toward the two reads a second", async () => {
    const p = await shown([MIA, SENT]);
    p.nudge([100]);
    await settle(30);
    p.intent({ conversation: "Mia", org: TEAM.org, team: TEAM.team });
    await settle(30);
    expect(p.reads()).toBe(2);
    p.nudge([1]);
    await settle(400);
    expect(p.reads()).toBe(2);
    await settle(600);
    expect(p.reads()).toBe(3);
  });

  it("does no list refresh while hidden, re-reads the badge only for unread changes, and refreshes once on show", async () => {
    const p = await shown([MIA, SENT]);
    p.show(false);
    await settle(2000);
    vi.clearAllMocks();
    const listBefore = document.querySelector(".ib-rows")!.innerHTML;

    // A change to the human's own sent message cannot change their unread set.
    for (let i = 0; i < 20; i++) p.nudge([2]);
    await settle(2000);
    expect(p.reads()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // New mail for the human: badge reads only, paced like the list.
    p.rows.push({ id: 3, from: "Lee", to: "human", unread: true });
    for (let i = 0; i < 50; i++) {
      p.nudge([3]);
      await settle(10);
    }
    await settle(2000);
    expect(p.reads()).toBeGreaterThanOrEqual(1);
    expect(p.reads()).toBeLessThanOrEqual(2);
    expect(p.cs.setBadge).toHaveBeenLastCalledWith({ count: 2 });
    expect(document.querySelector(".ib-rows")!.innerHTML).toBe(listBefore);
    expect(vi.getTimerCount()).toBe(0);

    // A nudge that names no rows could be anything, so it re-reads the badge.
    vi.clearAllMocks();
    p.nudge();
    await settle(30);
    expect(p.reads()).toBe(1);

    vi.clearAllMocks();
    p.show(true);
    await settle(30);
    expect(p.reads()).toBe(1);
    expect(p.listRows()).toBe(2);
    await settle(2000);
    expect(p.reads()).toBe(1);
  });

  it("re-reads a hidden badge when a loaded row of the human's mail changes", async () => {
    const p = await shown([MIA, SENT]);
    p.show(false);
    await settle(2000);
    vi.clearAllMocks();
    p.rows[0].unread = false;
    p.nudge([1]);
    await settle(30);
    expect(p.reads()).toBe(1);
    expect(p.cs.setBadge).toHaveBeenLastCalledWith(null);
  });

  it("retries a failed hidden badge read on the next nudge, without a timer meanwhile", async () => {
    const p = await shown([MIA, SENT]);
    p.show(false);
    await settle(2000);
    vi.clearAllMocks();
    p.cs.inboxRollup.mockRejectedValueOnce(new Error("offline"));
    p.nudge([3]);
    await settle(30);
    expect(p.reads()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    // This change alone couldn't touch the unread set, but the owed read runs.
    await settle(2000);
    p.nudge([2]);
    await settle(30);
    expect(p.reads()).toBe(2);
    expect(p.cs.setBadge).toHaveBeenLastCalledWith({ count: 1 });
  });

  describe("refreshes the human starts run at once inside the pacing window", () => {
    async function insideWindow() {
      const p = await shown([MIA, SENT]);
      p.nudge([100]);
      await settle(30);
      p.nudge([101]);
      await settle(30);
      expect(p.reads()).toBe(1);
      return p;
    }

    it("Retry", async () => {
      const p = await shown([MIA]);
      p.cs.inboxRollup.mockRejectedValueOnce(new Error("offline"));
      p.nudge([100]);
      await settle(30);
      const retry = [...document.querySelectorAll<HTMLButtonElement>("#list-notice button")].find(
        (b) => b.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      p.nudge([101]);
      await settle(30);
      // The nudge waits for the window; Retry doesn't.
      expect(p.reads()).toBe(1);
      retry!.click();
      await settle(30);
      expect(p.reads()).toBe(2);
      expect(document.querySelector("#list-notice")!.textContent).not.toContain("offline");
    });

    it("opening a thread from a host intent", async () => {
      const p = await insideWindow();
      expect(p.view()).not.toBe("thread");
      p.intent({ conversation: "Mia", org: TEAM.org, team: TEAM.team });
      await settle(30);
      expect(p.reads()).toBe(2);
      expect(p.view()).toBe("thread");
    });

    it("opening a thread whose mail lands while the read is in flight", async () => {
      const p = await insideWindow();
      await settle(2000);
      vi.clearAllMocks();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const read = p.cs.inboxRollup.getMockImplementation()!;
      p.cs.inboxRollup.mockImplementationOnce(async () => {
        const result = await read();
        await held;
        return result;
      });
      p.nudge([102]);
      await settle(30);
      expect(p.reads()).toBe(1);
      // Lee's first mail lands after the held read took its snapshot.
      p.intent({ conversation: "Lee", org: TEAM.org, team: TEAM.team });
      p.rows.push({ id: 3, from: "Lee", to: "human", unread: true });
      p.nudge([3]);
      release();
      await settle(30);
      expect(p.reads()).toBe(2);
      expect(p.view()).toBe("thread");
      expect(document.getElementById("thread-name")!.textContent).toBe("Lee");
    });

    it("sending", async () => {
      const p = await shown([MIA, SENT]);
      p.intent({ conversation: "Mia", org: TEAM.org, team: TEAM.team, focusComposer: true });
      await settle(30);
      expect(p.view()).toBe("thread");
      await settle(2000);
      vi.clearAllMocks();
      p.nudge([100]);
      await settle(30);
      expect(p.reads()).toBe(1);
      const draft = document.getElementById("draft") as HTMLTextAreaElement;
      draft.value = "On it";
      draft.dispatchEvent(new Event("input"));
      document.getElementById("composer")!.dispatchEvent(new Event("submit", { cancelable: true }));
      await settle(30);
      expect(p.cs.act).toHaveBeenCalledWith("replyAsHuman", expect.anything());
      expect(p.reads()).toBe(2);
    });
  });
});

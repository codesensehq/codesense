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

function boot(rows: Row[]) {
  const nudges = new Set<(change: unknown) => void>();
  const shows = new Set<(shown: boolean) => void>();
  const view = () => {
    const messages = rows.map((m) => ({
      ...m,
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
    return { messages, conversations: [...conversations.values()] };
  };
  const cs = {
    context: vi.fn(async () => ({
      org: TEAM.org,
      team: null,
      inboxScope: "all-teams",
      activeTeam: TEAM,
      inboxTeams: [TEAM],
    })),
    prefs: vi.fn(async () => ({})),
    setPrefs: vi.fn(async () => ({})),
    inboxRollup: vi.fn(async () => view()),
    inbox: vi.fn(async () => ({ messages: [], conversations: [], hasMore: false })),
    roles: vi.fn(async () => ({ roles: [] })),
    humanStatus: vi.fn(async () => ({ status: "online", note: "" })),
    agents: vi.fn(async () => []),
    subscribe: vi.fn(async () => ({})),
    unsubscribe: vi.fn(async () => {}),
    act: vi.fn(async () => ({})),
    setBadge: vi.fn(),
    onInboxChanged: (cb: (change: unknown) => void) => nudges.add(cb),
    onVisibility: (cb: (shown: boolean) => void) => shows.add(cb),
    onIntent: () => {},
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
  return {
    cs,
    rows,
    nudge: (ids?: number[]) =>
      nudges.forEach((cb) => cb(ids ? { changes: [{ team: TEAM, messageIds: ids }] } : {})),
    show: (shown: boolean) => shows.forEach((cb) => cb(shown)),
    listRows: () => document.querySelectorAll(".ib-row").length,
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
  async function shown(rows: Row[]) {
    const p = boot(rows);
    p.show(true);
    await settle(50);
    expect(p.listRows()).toBe(new Set(rows.map((r) => (r.from === "human" ? r.to : r.from))).size);
    await settle(2000);
    p.cs.inboxRollup.mockClear();
    return p;
  }

  it("coalesces 100 change nudges in one second into at most two reads", async () => {
    const p = await shown([{ id: 1, from: "Mia", to: "human", unread: true }]);
    for (let i = 0; i < 100; i++) {
      p.nudge([1]);
      await settle(10);
    }
    await settle(2000);
    expect(p.cs.inboxRollup.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(p.cs.inboxRollup.mock.calls.length).toBeLessThanOrEqual(2);
    // Idle afterwards: no timer keeps reading.
    expect(vi.getTimerCount()).toBe(0);
    await settle(10_000);
    expect(p.cs.inboxRollup.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("shows new mail at once on the first nudge after a quiet second", async () => {
    const p = await shown([{ id: 1, from: "Mia", to: "human", unread: true }]);
    p.rows.push({ id: 2, from: "Lee", to: "human", unread: true });
    p.nudge([2]);
    await settle(30);
    expect(p.cs.inboxRollup).toHaveBeenCalledTimes(1);
    expect(p.listRows()).toBe(2);
  });

  it("does no list refresh while hidden, re-reads the badge only for unread changes, and refreshes once on show", async () => {
    const p = await shown([
      { id: 1, from: "Mia", to: "human", unread: true },
      { id: 2, from: "human", to: "Mia", unread: false },
    ]);
    p.show(false);
    await settle(2000);
    p.cs.inboxRollup.mockClear();
    p.cs.setBadge.mockClear();
    const listBefore = document.querySelector(".ib-rows")!.innerHTML;

    // A change to the human's own sent message cannot change their unread set.
    for (let i = 0; i < 20; i++) p.nudge([2]);
    await settle(2000);
    expect(p.cs.inboxRollup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // New mail for the human: badge reads only, paced like the list.
    p.rows.push({ id: 3, from: "Lee", to: "human", unread: true });
    for (let i = 0; i < 50; i++) {
      p.nudge([3]);
      await settle(10);
    }
    await settle(2000);
    expect(p.cs.inboxRollup.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(p.cs.inboxRollup.mock.calls.length).toBeLessThanOrEqual(2);
    expect(p.cs.setBadge).toHaveBeenLastCalledWith({ count: 2 });
    expect(document.querySelector(".ib-rows")!.innerHTML).toBe(listBefore);
    expect(vi.getTimerCount()).toBe(0);

    // A nudge that names no rows could be anything, so it re-reads the badge.
    p.cs.inboxRollup.mockClear();
    p.nudge();
    await settle(30);
    expect(p.cs.inboxRollup).toHaveBeenCalledTimes(1);

    p.cs.inboxRollup.mockClear();
    p.show(true);
    await settle(30);
    expect(p.cs.inboxRollup).toHaveBeenCalledTimes(1);
    expect(p.listRows()).toBe(2);
    await settle(2000);
    expect(p.cs.inboxRollup).toHaveBeenCalledTimes(1);
  });

  it("runs a refresh the human starts at once, inside the pacing window", async () => {
    const p = await shown([{ id: 1, from: "Mia", to: "human", unread: true }]);
    p.cs.inboxRollup.mockRejectedValueOnce(new Error("offline"));
    p.nudge([1]);
    await settle(30);
    const retry = [...document.querySelectorAll<HTMLButtonElement>("#list-notice button")].find(
      (b) => b.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    p.nudge([1]);
    await settle(30);
    // The nudge waits for the window; Retry doesn't.
    expect(p.cs.inboxRollup).toHaveBeenCalledTimes(1);
    retry!.click();
    await settle(30);
    expect(p.cs.inboxRollup).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#list-notice")!.textContent).not.toContain("offline");
  });
});

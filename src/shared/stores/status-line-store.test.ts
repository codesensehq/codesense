// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStatusLine,
  dismissStatusLine,
  getStatusLineState,
  holdStatusLine,
  pauseStatusLine,
  postStatusLine,
  releaseStatusLine,
  resetStatusLineForTests,
  resumeStatusLine,
  runStatusLineAction,
  STATUS_LINE_MAX_WAITING,
  STATUS_LINE_MS,
  STATUS_LINE_OFFER_WAIT_MS,
  STATUS_LINE_UNDO_MS,
} from "./status-line-store";

/** The text of the line that shows, or null. */
const shown = () => getStatusLineState().line?.text ?? null;
const waiting = () => getStatusLineState().waiting.map((l) => l.text);
const announced = () => getStatusLineState().announcements.map((a) => a.text);
const show = () => ({ label: "Show", run: vi.fn() });
const undo = () => ({ label: "Undo", run: vi.fn(), keyHint: "⌥⌘Z" });

beforeEach(() => {
  vi.useFakeTimers();
  resetStatusLineForTests();
});

afterEach(() => {
  resetStatusLineForTests();
  vi.useRealTimers();
});

describe("timing", () => {
  it("shows a line for 6 s", () => {
    postStatusLine({ text: "design opened critique-log.html", kind: "offer", action: show() });
    expect(shown()).toBe("design opened critique-log.html");
    vi.advanceTimersByTime(STATUS_LINE_MS - 1);
    expect(shown()).toBe("design opened critique-log.html");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it("shows an Undo line for 10 s", () => {
    postStatusLine({ text: "Moved a tile", kind: "undo", action: undo() });
    vi.advanceTimersByTime(STATUS_LINE_UNDO_MS - 1);
    expect(shown()).toBe("Moved a tile");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it('shows "Nothing to undo" (info) for 6 s', () => {
    postStatusLine({ text: "Nothing to undo", kind: "info" });
    vi.advanceTimersByTime(STATUS_LINE_MS - 1);
    expect(shown()).toBe("Nothing to undo");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it("pauses and resumes with the remaining time, not the full 6 s", () => {
    postStatusLine({ text: "A", kind: "announcement" });
    vi.advanceTimersByTime(4000);
    pauseStatusLine("hover");
    vi.advanceTimersByTime(30_000);
    expect(shown()).toBe("A");
    resumeStatusLine("hover");
    vi.advanceTimersByTime(1999);
    expect(shown()).toBe("A");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it("stays paused while any reason holds it", () => {
    postStatusLine({ text: "A", kind: "announcement" });
    pauseStatusLine("hover");
    pauseStatusLine("focus");
    resumeStatusLine("hover");
    vi.advanceTimersByTime(60_000);
    expect(shown()).toBe("A");
    resumeStatusLine("focus");
    vi.advanceTimersByTime(STATUS_LINE_MS);
    expect(shown()).toBeNull();
  });
});

describe("order", () => {
  it("an Undo line preempts an offer, from a person or an agent, and the offer shows after", () => {
    postStatusLine({ text: "review agent opened Routines", kind: "offer", action: show() });
    vi.advanceTimersByTime(1000);
    postStatusLine({ text: "design moved a tile", kind: "undo", action: undo() });
    expect(shown()).toBe("design moved a tile");
    vi.advanceTimersByTime(STATUS_LINE_UNDO_MS);
    expect(shown()).toBe("review agent opened Routines");
    // The offer kept its remaining 5 s.
    vi.advanceTimersByTime(4999);
    expect(shown()).toBe("review agent opened Routines");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it("a newer Undo line replaces an older one", () => {
    postStatusLine({ text: "Moved one", kind: "undo", action: undo() });
    vi.advanceTimersByTime(3000);
    postStatusLine({ text: "Moved two", kind: "undo", action: undo() });
    expect(shown()).toBe("Moved two");
    vi.advanceTimersByTime(STATUS_LINE_UNDO_MS);
    expect(shown()).toBeNull();
  });

  it('a second offer waits behind "+1"', () => {
    postStatusLine({ text: "Offer one", kind: "offer", action: show() });
    postStatusLine({ text: "Offer two", kind: "offer", action: show() });
    expect(shown()).toBe("Offer one");
    expect(waiting()).toEqual(["Offer two"]);
  });

  it(`at most ${STATUS_LINE_MAX_WAITING} offers wait and the oldest drops`, () => {
    postStatusLine({ text: "Showing", kind: "offer", action: show() });
    for (const n of [1, 2, 3, 4]) postStatusLine({ text: `Offer ${n}`, kind: "offer" });
    expect(waiting()).toEqual(["Offer 2", "Offer 3", "Offer 4"]);
  });

  it("announcements queue in the order posted", () => {
    postStatusLine({ text: "First", kind: "announcement" });
    postStatusLine({ text: "Second", kind: "announcement" });
    postStatusLine({ text: "Nothing to undo", kind: "info" });
    expect(shown()).toBe("First");
    vi.advanceTimersByTime(STATUS_LINE_MS);
    expect(shown()).toBe("Second");
    vi.advanceTimersByTime(STATUS_LINE_MS);
    expect(shown()).toBe("Nothing to undo");
  });
});

describe("queue and lifecycle", () => {
  it("dedupes by key, for a waiting or a showing line", () => {
    postStatusLine({ key: "a", text: "A one", kind: "offer" });
    postStatusLine({ key: "b", text: "B one", kind: "offer" });
    postStatusLine({ key: "b", text: "B two", kind: "offer" });
    expect(waiting()).toEqual(["B two"]);
    postStatusLine({ key: "a", text: "A two", kind: "offer" });
    expect(shown()).toBe("A two");
    expect(waiting()).toEqual(["B two"]);
  });

  it("a waiting offer expires at 60 s, and its own 6 s starts when it first shows", () => {
    postStatusLine({ text: "Long", kind: "announcement" });
    pauseStatusLine("focus");
    postStatusLine({ text: "Stale offer", kind: "offer" });
    vi.advanceTimersByTime(STATUS_LINE_OFFER_WAIT_MS);
    expect(waiting()).toEqual([]);

    postStatusLine({ text: "Fresh offer", kind: "offer" });
    vi.advanceTimersByTime(STATUS_LINE_OFFER_WAIT_MS - 10_000);
    resumeStatusLine("focus");
    vi.advanceTimersByTime(STATUS_LINE_MS);
    expect(shown()).toBe("Fresh offer");
    vi.advanceTimersByTime(STATUS_LINE_MS - 1);
    expect(shown()).toBe("Fresh offer");
    vi.advanceTimersByTime(1);
    expect(shown()).toBeNull();
  });

  it("a line closes once its action runs, and a second run is a no-op", () => {
    const action = show();
    postStatusLine({ text: "Offer", kind: "offer", action });
    const id = getStatusLineState().line!.id;
    runStatusLineAction(id);
    runStatusLineAction(id);
    expect(action.run).toHaveBeenCalledTimes(1);
    expect(shown()).toBeNull();
  });

  it("running a waiting offer's action or dismissing it removes it from the queue", () => {
    const two = show();
    postStatusLine({ text: "Offer one", kind: "offer" });
    postStatusLine({ text: "Offer two", kind: "offer", action: two });
    postStatusLine({ text: "Offer three", kind: "offer" });
    const [second, third] = getStatusLineState().waiting;
    runStatusLineAction(second.id);
    expect(two.run).toHaveBeenCalledTimes(1);
    dismissStatusLine(third.id);
    expect(waiting()).toEqual([]);
    expect(shown()).toBe("Offer one");
  });

  it("a rejected action posts nothing of its own", async () => {
    postStatusLine({
      text: "Offer",
      kind: "offer",
      action: { label: "Show", run: () => Promise.reject(new Error("gone")) },
    });
    runStatusLineAction(getStatusLineState().line!.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toBeNull();
  });

  it("clears one line by key", () => {
    postStatusLine({ key: "a", text: "A", kind: "announcement" });
    postStatusLine({ key: "b", text: "B", kind: "offer" });
    clearStatusLine("b");
    expect(waiting()).toEqual([]);
    clearStatusLine("a");
    expect(shown()).toBeNull();
  });
});

describe("progress", () => {
  it("replaces in place by key and counts 6 s from the last update", () => {
    postStatusLine({
      key: "resume",
      text: "Resuming release-notes · 1 of 4 tiles",
      kind: "progress",
    });
    postStatusLine({ text: "Queued", kind: "announcement" });
    vi.advanceTimersByTime(5000);
    postStatusLine({
      key: "resume",
      text: "Resuming release-notes · 3 of 4 tiles",
      kind: "progress",
    });
    expect(shown()).toBe("Resuming release-notes · 3 of 4 tiles");
    vi.advanceTimersByTime(STATUS_LINE_MS - 1);
    expect(shown()).toBe("Resuming release-notes · 3 of 4 tiles");
    vi.advanceTimersByTime(1);
    expect(shown()).toBe("Queued");
    // In-place updates announce once, when the line first shows.
    expect(announced().filter((t) => t.startsWith("Resuming"))).toEqual([
      "Resuming release-notes · 1 of 4 tiles",
    ]);
  });
});

describe("hold and the hint line", () => {
  it("held: nothing but the hint line shows, and timers pause", () => {
    postStatusLine({ text: "Offer", kind: "offer" });
    postStatusLine({ text: "Waiting", kind: "offer" });
    vi.advanceTimersByTime(2000);
    holdStatusLine();
    expect(shown()).toBeNull();
    postStatusLine({ key: "hint", text: "Drop to move below design", kind: "offer" });
    expect(getStatusLineState().line).toMatchObject({
      key: "hint",
      kind: "info",
      text: "Drop to move below design",
    });
    postStatusLine({ key: "hint", text: "Drop to move beside design", kind: "info" });
    expect(shown()).toBe("Drop to move beside design");
    vi.advanceTimersByTime(STATUS_LINE_OFFER_WAIT_MS - 10_000);
    expect(shown()).toBe("Drop to move beside design");

    clearStatusLine("hint");
    releaseStatusLine();
    expect(shown()).toBe("Offer");
    expect(waiting()).toEqual(["Waiting"]);
    vi.advanceTimersByTime(3999);
    expect(shown()).toBe("Offer");
    vi.advanceTimersByTime(1);
    expect(shown()).toBe("Waiting");
  });

  it("a line posted under a hold shows when the hold is released", () => {
    holdStatusLine();
    postStatusLine({ text: "Moved a tile", kind: "undo", action: undo() });
    expect(shown()).toBeNull();
    expect(announced()).toEqual([]);
    releaseStatusLine();
    expect(shown()).toBe("Moved a tile");
    expect(announced()).toEqual(["Moved a tile"]);
  });
});

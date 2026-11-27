// SPDX-License-Identifier: MIT
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLine } from "./status-line";
import {
  clearStatusLine,
  holdStatusLine,
  postStatusLine,
  releaseStatusLine,
  resetStatusLineForTests,
  STATUS_LINE_MS,
  STATUS_LINE_UNDO_MS,
  type StatusLinePost,
} from "@/shared/stores/status-line-store";

const post = (p: StatusLinePost) => act(() => void postStatusLine(p));
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const line = () => screen.queryByTestId("status-line");
const region = () => screen.getByRole("status", { name: "status line" });

/** Every text the live region gains, in order, as a screen reader hears it. */
function recordRegion(): () => string[] {
  const heard: string[] = [];
  const collect = (records: MutationRecord[]) => {
    for (const r of records)
      for (const n of r.addedNodes) if (n.textContent) heard.push(n.textContent);
  };
  const observer = new MutationObserver(collect);
  observer.observe(region(), { childList: true, subtree: true });
  return () => {
    collect(observer.takeRecords());
    return heard;
  };
}

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.useFakeTimers();
  // Testing Library ends each user event with a setTimeout(0), which it only runs on a fake
  // clock it knows as Jest's.
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  resetStatusLineForTests();
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
});

afterEach(() => {
  cleanup();
  resetStatusLineForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the line", () => {
  it("renders nothing visible when nothing has posted", () => {
    render(<StatusLine />);
    expect(line()).toBeNull();
    expect(region()).toHaveTextContent("");
  });

  it("puts its action in the Tab order with its key pill, and runs it once on a double press", async () => {
    const run = vi.fn();
    render(<StatusLine />);
    post({
      text: "design moved a tile",
      kind: "undo",
      action: { label: "Undo", run, keyHint: "⌥⌘Z" },
    });
    await user.tab();
    const button = screen.getByRole("button", { name: "Undo ⌥⌘Z" });
    expect(button).toHaveFocus();
    expect(within(button).getByText("⌥⌘Z").tagName).toBe("KBD");
    await user.dblClick(button);
    expect(run).toHaveBeenCalledTimes(1);
    expect(line()).toBeNull();
  });

  it("pauses on hover and resumes with the remaining time on leave", async () => {
    render(<StatusLine />);
    post({ text: "review agent opened Routines", kind: "offer" });
    tick(4000);
    await user.hover(line()!);
    tick(30_000);
    expect(line()).not.toBeNull();
    await user.unhover(line()!);
    tick(1999);
    expect(line()).not.toBeNull();
    tick(1);
    expect(line()).toBeNull();
  });

  it("pauses while focus is inside and resumes on blur", async () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <StatusLine />
      </>,
    );
    post({ text: "Offer", kind: "offer", action: { label: "Show", run: vi.fn() } });
    tick(4000);
    screen.getByRole("button", { name: "Show" }).focus();
    tick(30_000);
    expect(line()).not.toBeNull();
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    tick(1999);
    expect(line()).not.toBeNull();
    tick(1);
    expect(line()).toBeNull();
  });

  it("closes on Esc and returns focus to the element that had it before", async () => {
    render(
      <>
        <button type="button">Before</button>
        <StatusLine />
      </>,
    );
    post({ text: "Offer", kind: "offer", action: { label: "Show", run: vi.fn() } });
    screen.getByRole("button", { name: "Before" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Show" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(line()).toBeNull();
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
  });

  it("returns focus to body when nothing had it before", async () => {
    render(<StatusLine />);
    post({ text: "Offer", kind: "offer", action: { label: "Show", run: vi.fn() } });
    await user.tab();
    tick(STATUS_LINE_MS);
    expect(line()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(line()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("under a hold shows only the hint line", () => {
    render(<StatusLine />);
    post({ text: "Offer", kind: "offer" });
    post({ text: "Waiting", kind: "offer" });
    act(() => holdStatusLine());
    expect(line()).toBeNull();
    post({ key: "hint", text: "Drop to move below design", kind: "info" });
    expect(line()).toHaveTextContent("Drop to move below design");
    expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull();
    act(() => {
      clearStatusLine("hint");
      releaseStatusLine();
    });
    expect(line()).toHaveTextContent("Offer");
  });
});

describe('"+N waiting ▾"', () => {
  async function threeOffers() {
    const runs = [vi.fn(), vi.fn(), vi.fn()];
    render(<StatusLine />);
    runs.forEach((run, i) =>
      post({ text: `Offer ${i + 1}`, kind: "offer", action: { label: "Show", run } }),
    );
    return runs;
  }

  it("is a menu button that lists each waiting offer with its action and ✕", async () => {
    await threeOffers();
    const button = screen.getByRole("button", { name: "+2 waiting ▾" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Offer 2 Show" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Dismiss Offer 2" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Offer 3 Show" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Dismiss Offer 3" })).toBeInTheDocument();
  });

  it("moves with the arrows, closes on Esc and returns focus to the button", async () => {
    await threeOffers();
    const button = screen.getByRole("button", { name: "+2 waiting ▾" });
    button.focus();
    await user.keyboard("{Enter}");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    await user.keyboard("{ArrowDown}");
    const focused = items.findIndex((i) => i === document.activeElement);
    expect(focused).toBeGreaterThanOrEqual(0);
    await user.keyboard("{ArrowDown}");
    expect(items.findIndex((i) => i === document.activeElement)).toBe(focused + 1);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
    // Esc in the menu closes the menu, not the line.
    expect(line()).not.toBeNull();
  });

  it("drops the count when an offer runs or is dismissed, and closes when none is left", async () => {
    const runs = await threeOffers();
    await user.click(screen.getByRole("button", { name: "+2 waiting ▾" }));
    await user.click(screen.getByRole("menuitem", { name: "Offer 2 Show" }));
    expect(runs[1]).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "+1 waiting ▾" })).toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Dismiss Offer 3" }));
    expect(runs[2]).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /waiting/ })).toBeNull();
    expect(line()).toHaveTextContent("Offer 1");
  });

  it("pauses the current line's timer while the menu is open", async () => {
    await threeOffers();
    await user.click(screen.getByRole("button", { name: "+2 waiting ▾" }));
    tick(30_000);
    expect(line()).toHaveTextContent("Offer 1");
    await user.keyboard("{Escape}");
    // Hover and focus still pause it; leaving both lets it run out.
    await user.unhover(line()!);
    act(() => (document.activeElement as HTMLElement).blur());
    tick(STATUS_LINE_MS);
    expect(line()).toHaveTextContent("Offer 2");
  });
});

describe("the live region", () => {
  it('is one polite region labelled "status line"', () => {
    render(<StatusLine />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(region()).toHaveAttribute("aria-live", "polite");
  });

  it("hears each line once, a preempted line when it later shows, a progress line once", () => {
    render(<StatusLine />);
    const heard = recordRegion();
    act(() => {
      postStatusLine({ text: "review agent opened Routines", kind: "offer" });
      postStatusLine({ text: "design moved a tile", kind: "undo" });
    });
    tick(STATUS_LINE_UNDO_MS);
    expect(line()).toHaveTextContent("review agent opened Routines");
    tick(STATUS_LINE_MS);
    post({ key: "r", text: "Resuming release-notes · 1 of 4 tiles", kind: "progress" });
    post({ key: "r", text: "Resuming release-notes · 3 of 4 tiles", kind: "progress" });
    post({ text: "3 need you", kind: "announcement" });
    tick(STATUS_LINE_MS);
    expect(line()).toHaveTextContent("3 need you");
    const texts = heard();
    const count = (t: string) => texts.filter((h) => h === t).length;
    expect(count("review agent opened Routines")).toBe(1);
    expect(count("design moved a tile")).toBe(1);
    expect(texts.filter((h) => h.startsWith("Resuming"))).toHaveLength(1);
    expect(count("3 need you")).toBe(1);
  });

  it("hears a hint once per distinct text, and a drop once", () => {
    render(<StatusLine />);
    const heard = recordRegion();
    act(() => holdStatusLine());
    post({ key: "hint", text: "Drop to move below design", kind: "info" });
    post({ key: "hint", text: "Drop to move below design", kind: "info" });
    post({ key: "hint", text: "Drop to move beside design", kind: "info" });
    act(() => {
      clearStatusLine("hint");
      releaseStatusLine();
    });
    post({ text: "Moved critique-log.html beside design", kind: "undo" });
    expect(heard()).toEqual([
      "Drop to move below design",
      "Drop to move beside design",
      "Moved critique-log.html beside design",
    ]);
  });
});

describe("the name", () => {
  it('says "status line", never "hint slot" or "status slot"', async () => {
    render(<StatusLine />);
    post({ text: "Offer 1", kind: "offer", action: { label: "Show", run: vi.fn() } });
    post({ text: "Offer 2", kind: "offer", action: { label: "Show", run: vi.fn() } });
    await user.click(screen.getByRole("button", { name: "+1 waiting ▾" }));
    expect(screen.getByRole("group", { name: "Status line" })).toBe(line());
    const labels = [
      region().getAttribute("aria-label"),
      line()!.getAttribute("aria-label"),
      screen.getByRole("button", { name: "+1 waiting ▾" }).textContent,
      screen.getByRole("menu").getAttribute("aria-label"),
      ...screen.getAllByRole("menuitem").map((m) => m.getAttribute("aria-label") ?? m.textContent),
    ];
    for (const label of labels) expect(label).not.toMatch(/hint slot|status slot/i);
    expect(region()).toHaveAttribute("aria-label", "status line");
    expect(screen.getByRole("menu")).toHaveAttribute("aria-label", "Waiting in the status line");
  });
});

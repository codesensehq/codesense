// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  PIN_CAP,
  capNote,
  capLabel,
  firstWords,
  liveText,
  pinTitleOf,
  quoteOf,
  whoPinned,
} from "./person-pins";

const label = (from: string) => (from === "lead-1" ? "Story lead" : from);

describe("pinTitleOf", () => {
  it("an HTML message takes its summary, then <title>, then its first heading, then who sent it", () => {
    const html = (text: string, summary?: string) => ({ text, contentType: "html", summary });
    expect(pinTitleOf(html("<title>T</title><h1>H</h1>", "Merge plan"), "Story lead")).toBe(
      "Merge plan",
    );
    expect(pinTitleOf(html("<head><title> QA  board </title></head><h1>H</h1>"), "Lead")).toBe(
      "QA board",
    );
    expect(pinTitleOf(html("<div><h2 class='x'>Spend <b>today</b></h2></div>"), "Lead")).toBe(
      "Spend today",
    );
    expect(pinTitleOf(html("<div><p>no heading</p></div>"), "Story lead")).toBe(
      "Dashboard from Story lead",
    );
    // Markup never leaks into a title.
    expect(pinTitleOf(html("<title></title><h3>  </h3>"), "Lead")).toBe("Dashboard from Lead");
  });

  it("a plain message takes its summary, else its first sentence", () => {
    expect(pinTitleOf({ text: "Ship it.", summary: "Go" }, "Lead")).toBe("Go");
    expect(pinTitleOf({ text: "Merge plan: squash onto main. Then tag it." }, "Lead")).toBe(
      "Merge plan: squash onto main.",
    );
    expect(pinTitleOf({ text: "first line\nsecond line" }, "Lead")).toBe("first line");
    expect(pinTitleOf({ text: "   " }, "Lead")).toBe("Message from Lead");
  });
});

describe("quoteOf", () => {
  it("is the title, then the rest of the message", () => {
    expect(quoteOf({ text: "Merge plan: squash onto main. Then tag v2 and ship." }, "L")).toEqual({
      title: "Merge plan: squash onto main.",
      rest: "Then tag v2 and ship.",
    });
    expect(quoteOf({ text: "One line" }, "L")).toEqual({ title: "One line", rest: "" });
  });
});

describe("the cap", () => {
  const pins = [
    { messageId: 1, pinnedBy: "lead-1" },
    { messageId: 2, pinnedBy: "human" },
    { messageId: 3, pinnedBy: "lead-1" },
  ];

  it("names how many are pinned, as the dimmed Pin's accessible name says it", () => {
    expect(PIN_CAP).toBe(3);
    expect(capLabel(3)).toBe("3 of 3 pinned");
  });

  it("the note says whose pins fill the list, the most first", () => {
    expect(capNote(pins, label)).toBe(
      "3 of 3 pinned (2 by Story lead, 1 by you). Unpin one to pin this.",
    );
    expect(
      capNote(
        pins.map((p) => ({ ...p, pinnedBy: "human" })),
        label,
      ),
    ).toBe("3 of 3 pinned (3 by you). Unpin one to pin this.");
  });

  it("says who pinned a message: you, or the agent by name", () => {
    expect(whoPinned("human", label)).toBe("you");
    expect(whoPinned("lead-1", label)).toBe("Story lead");
  });
});

describe("what is announced", () => {
  it("names the message by its first words and says how many are pinned", () => {
    expect(firstWords("Merge plan: squash onto main and then tag it")).toBe(
      "Merge plan: squash onto…",
    );
    expect(firstWords("Short")).toBe("Short");
    expect(liveText("pinned", "Merge plan: squash onto main and then tag it", 3)).toBe(
      'Pinned "Merge plan: squash onto…". 3 of 3 pinned.',
    );
    expect(liveText("unpinned", "Ship it", 1)).toBe('Unpinned "Ship it". 1 of 3 pinned.');
    expect(liveText("restored", "Ship it", 2)).toBe('Restored "Ship it". 2 of 3 pinned.');
  });
});

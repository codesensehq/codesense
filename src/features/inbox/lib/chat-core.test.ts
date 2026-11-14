// SPDX-License-Identifier: MIT
// The chat-core cases the dashboard kit and any page that vendors the chat both run:
// the marks rule and the card parser, through the overlay's import.
import { describe, expect, it } from "vitest";

import {
  cardAnswer,
  createMarkLatch,
  deliveryMark,
  isBusy,
  parseCard,
  parseNext,
  type ChatLeadRow,
} from "./chat-core";

const SENT = Date.parse("2026-11-12T10:00:00Z");
const later = (ms: number) => new Date(SENT + ms).toISOString();
const earlier = (ms: number) => new Date(SENT - ms).toISOString();
// The lead rows below are the shapes list_sessions returns: mailNotice null | 'pending' | 'told', notifiedAt RFC 3339 or null, unread a count.
const lead = (extra: ChatLeadRow = {}): ChatLeadRow => ({
  state: "running",
  unread: 1,
  mailNotice: "pending",
  notifiedAt: null,
  ...extra,
});
const mark = (extra: Partial<Parameters<typeof deliveryMark>[0]> = {}) =>
  deliveryMark({ sentAt: SENT, busyAtSend: true, lead: lead(), newestLeadAt: 0, ...extra });

describe("deliveryMark", () => {
  it("isBusy: only an idle lead is free", () => {
    expect(isBusy({ state: "idle" })).toBe(false);
    for (const state of ["running", "needs-you", "offline", "unknown"])
      expect(isBusy({ state }), state).toBe(true);
    expect(isBusy(null), "no lead row: the launch machine owns the mark").toBe(false);
  });

  it("a send to an idle lead is Delivered at once", () => {
    expect(mark({ busyAtSend: false })).toBe("delivered");
  });

  it("a send to a busy lead is Queued while its notice is pending or absent", () => {
    expect(mark()).toBe("queued");
    expect(mark({ lead: lead({ mailNotice: null, unread: 1 }) }), "unread mail, no notice").toBe(
      "queued",
    );
  });

  it("Queued clears on mailNotice told", () => {
    expect(mark({ lead: lead({ mailNotice: "told", notifiedAt: later(5) }) })).toBe("delivered");
    expect(mark({ lead: lead({ mailNotice: "told", notifiedAt: later(0) }) })).toBe("delivered");
    expect(mark({ lead: lead({ mailNotice: "told", notifiedAt: null }) })).toBe("queued");
    expect(mark({ lead: lead({ mailNotice: "told", notifiedAt: earlier(1) }) })).toBe("queued");
  });

  it("Queued clears on notifiedAt at or after sentAt with unread 0", () => {
    expect(mark({ lead: lead({ mailNotice: null, unread: 0, notifiedAt: later(0) }) })).toBe(
      "delivered",
    );
    expect(mark({ lead: lead({ mailNotice: null, unread: 0, notifiedAt: later(2000) }) })).toBe(
      "delivered",
    );
  });

  it("the real told -> read sequence: pending, told, then read (mailNotice null, unread 0)", () => {
    const sequence: [ChatLeadRow, string][] = [
      [lead({ mailNotice: "pending", unread: 1, notifiedAt: null }), "queued"],
      [lead({ mailNotice: "told", unread: 1, notifiedAt: later(900) }), "delivered"],
      [lead({ mailNotice: null, unread: 0, notifiedAt: later(900) }), "delivered"],
    ];
    for (const [row, want] of sequence) expect(mark({ lead: row }), JSON.stringify(row)).toBe(want);
  });

  it("an older notice or unread mail does not clear Queued", () => {
    expect(
      mark({ lead: lead({ mailNotice: null, unread: 0, notifiedAt: earlier(1) }) }),
      "the notice predates the send",
    ).toBe("queued");
    expect(
      mark({ lead: lead({ mailNotice: null, unread: 1, notifiedAt: later(10) }) }),
      "read is unread 0",
    ).toBe("queued");
    expect(
      mark({ lead: lead({ mailNotice: "pending", unread: 0, notifiedAt: null }) }),
      "no notice at all",
    ).toBe("queued");
    expect(
      mark({ lead: lead({ mailNotice: null, unread: 0, notifiedAt: "not a date" }) }),
      "an unparsable time never clears",
    ).toBe("queued");
  });

  it("Queued clears on a lead message after sentAt, and not on one before it", () => {
    expect(mark({ newestLeadAt: SENT + 1 })).toBe("delivered");
    expect(mark({ newestLeadAt: SENT })).toBe("queued");
    expect(mark({ newestLeadAt: SENT - 1 })).toBe("queued");
  });

  it("with no lead row a busy send that was never delivered stays Queued; an idle send is Delivered", () => {
    expect(mark({ lead: null })).toBe("queued");
    expect(mark({ lead: null, busyAtSend: false })).toBe("delivered");
  });

  it("a Delivered mark latches per message: the lead leaving or other unread mail does not undo it", () => {
    const of = createMarkLatch();
    const input = (extra = {}) => ({
      sentAt: SENT,
      busyAtSend: true,
      lead: lead(),
      newestLeadAt: 0,
      ...extra,
    });
    expect(of("a", input())).toBe("queued");
    expect(of("a", input({ lead: lead({ mailNotice: "told", notifiedAt: later(5) }) }))).toBe(
      "delivered",
    );
    expect(of("a", input({ lead: null }))).toBe("delivered");
    expect(of("a", input({ lead: lead({ unread: 3, notifiedAt: null }) }))).toBe("delivered");
    expect(of("b", input({ lead: null }))).toBe("queued");
  });
});

const Q = "Lazy-load inboxes after the first paint, or page them 10 at a time?";
const card = (options: string, pick = "Lazy-load after paint") =>
  `${Q}\n\nOptions: ${options}. My pick: ${pick}, because it is faster.`;

describe("parseCard", () => {
  it("reads the question, the options and the pick; the pick comes first", () => {
    const parsed = parseCard(card("`Page 10 at a time`, `Lazy-load after paint`, or `Both`"));
    expect(parsed?.question).toBe(Q);
    expect(parsed?.options).toEqual(["Lazy-load after paint", "Page 10 at a time", "Both"]);
    expect(parsed?.pick).toBe("Lazy-load after paint");
    expect(parsed?.reason).toBe("it is faster");
  });

  it("the pick may be backticked, differ in case, and a card with no pick keeps its order", () => {
    expect(parseCard(card("`A`, `B`", "`B`"))?.options[0]).toBe("B");
    expect(parseCard(card("`Yes`, `No`", "yes"))?.options[0]).toBe("Yes");
    const none = parseCard(`${Q}\n\nOptions: \`A\` or \`B\`.`);
    expect(none?.options).toEqual(["A", "B"]);
    expect(none?.pick).toBeNull();
    expect(
      parseCard(card("`A`, `B`", "C"))?.pick,
      "a pick that is no option is dropped",
    ).toBeNull();
  });

  it("keeps the text before Options as the question, over several lines", () => {
    const parsed = parseCard(
      "Merge the release branch?\n**PR:** link\n\nOptions: `merge` or `hold`. My pick: merge, because green.",
    );
    expect(parsed?.question).toBe("Merge the release branch?\n**PR:** link");
    expect(parsed?.options).toEqual(["merge", "hold"]);
  });

  it("falls back (null) for anything it cannot read as buttons", () => {
    for (const text of [
      "",
      null,
      undefined,
      42,
      "Should I ship it?",
      "Options: just words, no backticks. My pick: words.",
      `${Q}\n\nOptions: \`only one\`. My pick: only one.`,
      "Merge?\n\nOptions: `merge`, or `send back: <reason>`. My pick: merge, because ok.",
      `${Q}\n\nOptions: ${Array.from({ length: 9 }, (_, i) => `\`o${i}\``).join(", ")}.`,
      `${Q}\n\nOptions: \`${"x".repeat(200)}\`, \`b\`.`,
      `${Q}\n\nOptions: \`A\`, \`A\`.`,
      "\n\nOptions: `A`, `B`.",
    ])
      expect(parseCard(text), String(text).slice(0, 60)).toBeNull();
  });

  it("uses the last Options line, so a quoted earlier one does not win", () => {
    const parsed = parseCard(
      "Earlier I wrote\nOptions: `x`, `y`.\nNow:\nOptions: `A`, `B`. My pick: B.",
    );
    expect(parsed?.options).toEqual(["B", "A"]);
  });
});

describe("cardAnswer", () => {
  it("a human row whose inReplyTo is the card id answers it, wherever it was sent from", () => {
    const thread = [
      { messageId: 5, from: "human", inReplyTo: 7, text: "Both", createdAtMs: SENT + 1000 },
      { messageId: 6, from: "human", inReplyTo: null, text: "hi" },
    ];
    expect(cardAnswer(7, thread)).toEqual({ text: "Both", at: SENT + 1000 });
    expect(cardAnswer(8, thread)).toBeNull();
    expect(cardAnswer(7, [])).toBeNull();
    expect(cardAnswer(7, undefined)).toBeNull();
    expect(
      cardAnswer(7, [{ messageId: 9, from: "role:x", inReplyTo: 7 }]),
      "only the person",
    ).toBeNull();
  });
});

describe("parseNext", () => {
  it("reads the trailing Next line as chips and returns the text above it", () => {
    expect(
      parseNext(
        "Done. Your repos are set up.\n\nNext: `Bring in my issues`, `What have you set up?`",
      ),
    ).toEqual({
      text: "Done. Your repos are set up.",
      chips: ["Bring in my issues", "What have you set up?"],
    });
  });

  it("splits an unquoted line on the middle dot, so a chip may hold a comma", () => {
    expect(parseNext("Hi.\nNext: I work on acme/web, acme/api · What is CodeSense?\n")).toEqual({
      text: "Hi.",
      chips: ["I work on acme/web, acme/api", "What is CodeSense?"],
    });
  });

  it("takes backticked chips when the line has any, and any case of the word Next", () => {
    expect(parseNext("A\nnext: `x` · `y`")?.chips).toEqual(["x", "y"]);
  });

  it("has no chips when the Next line is not the last line, or there is none", () => {
    for (const text of [
      "Next: `a`, `b`\nand then more",
      "Just a reply.",
      "",
      "Next:",
      "Hi\nNext: ",
      null,
      undefined,
      42,
    ])
      expect(parseNext(text), String(text)).toBeNull();
  });

  it("refuses a line that is not chips: a duplicate, an over-long or placeholder chip, or more than four", () => {
    expect(parseNext("Q\nNext: `a`, `A`")).toBeNull();
    expect(parseNext(`Q\nNext: \`${"x".repeat(81)}\``)).toBeNull();
    expect(parseNext("Q\nNext: `<your repo>`, `b`")).toBeNull();
    expect(parseNext("Q\nNext: `1`, `2`, `3`, `4`, `5`")).toBeNull();
    expect(parseNext("Q\nNext: `1`, `2`, `3`, `4`")?.chips).toHaveLength(4);
  });

  it("keeps a lone chip and a body that is only the line", () => {
    expect(parseNext("Next: `Start my first story`")).toEqual({
      text: "",
      chips: ["Start my first story"],
    });
  });

  it("reads the last Next line only", () => {
    expect(parseNext("Earlier: Next: `x`\nNext: `y`, `z`")).toEqual({
      text: "Earlier: Next: `x`",
      chips: ["y", "z"],
    });
  });
});

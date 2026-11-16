// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { createSessionTextRouter, type SessionTextEvent } from "./session-text";

const prose = (turn: string, key: string, text: string): SessionTextEvent => ({
  kind: "prose",
  turn,
  key,
  text,
});
const tool = (turn: string): SessionTextEvent => ({ kind: "tool", turn });
const end = (turn: string): SessionTextEvent => ({ kind: "end", turn });

describe("the session-text router", () => {
  it("passes prose on as it comes, and ends a turn with exactly one final message", () => {
    const route = createSessionTextRouter();
    const out = [
      ...route("s1", prose("u1", "a1", "Looking at the tests.")),
      ...route("s1", prose("u1", "a3", "All 48 pass.")),
      ...route("s1", end("u1")),
      // A second Stop for the same turn, as a late hook sends it.
      ...route("s1", end("u1")),
    ];
    expect(out).toEqual([
      { sessionId: "s1", kind: "prose", turn: "u1", key: "a1", text: "Looking at the tests." },
      { sessionId: "s1", kind: "prose", turn: "u1", key: "a3", text: "All 48 pass." },
      { sessionId: "s1", kind: "final", turn: "u1", key: "a3", text: "All 48 pass." },
    ]);
  });

  it("a tool-using turn sends prose only: tool markers never reach the page, and the final is the prose after the last tool", () => {
    const route = createSessionTextRouter();
    const out = [
      ...route("s1", prose("u1", "a1", "I'll run the suite.")),
      ...route("s1", tool("u1")),
      ...route("s1", tool("u1")),
      ...route("s1", prose("u1", "a3", "Green: 48 of 48.")),
      ...route("s1", end("u1")),
    ];
    expect(out.map((m) => m.kind)).toEqual(["prose", "prose", "final"]);
    expect(out.at(-1)).toMatchObject({ kind: "final", key: "a3", text: "Green: 48 of 48." });
  });

  it("a turn that ends on a tool call with no prose after it has no final; one with no prose at all sends nothing", () => {
    const route = createSessionTextRouter();
    route("s1", prose("u1", "a1", "Running it."));
    route("s1", tool("u1"));
    expect(route("s1", end("u1"))).toEqual([]);
    expect(route("s1", end("u2"))).toEqual([]);
  });

  it("keeps each session and turn apart", () => {
    const route = createSessionTextRouter();
    route("s1", prose("u1", "a1", "one"));
    route("s2", prose("v1", "b1", "two"));
    expect(route("s2", end("v1"))).toEqual([
      { sessionId: "s2", kind: "final", turn: "v1", key: "b1", text: "two" },
    ]);
    route("s1", prose("u2", "a2", "next turn"));
    expect(route("s1", end("u2"))).toEqual([
      { sessionId: "s1", kind: "final", turn: "u2", key: "a2", text: "next turn" },
    ]);
  });
});

// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { NAV_TEXT_MATCH_CASES } from "../../../../tests/support/fixtures/nav-text-match";
import { navTextMatches } from "./nav-ordering";

describe("navTextMatches", () => {
  it.each(NAV_TEXT_MATCH_CASES)("$name", ({ query, text, matches }) => {
    expect(navTextMatches(query, text)).toBe(matches);
  });

  it("matches any of several texts and skips empty ones", () => {
    expect(navTextMatches("demo-12", "alpha.md", null, undefined, "DEMO-12")).toBe(true);
    expect(navTextMatches("demo-12", "alpha.md", null, undefined)).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(navTextMatches("  ", "anything")).toBe(true);
  });
});

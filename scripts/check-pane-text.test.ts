// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
// @ts-expect-error The lint is an executable JS module.
import { check, paneTextProblems } from "./check-pane-text.mjs";

const FIXTURE = "scripts/fixtures/pane-text/mac-only-pane.html";

it("fails the fixture on every macOS key glyph, Option wording and machine word", () => {
  const problems: string[] = check(process.cwd(), [FIXTURE]);
  const found = problems.map((problem) => problem.split(": ")[1].split(" (")[0]);
  for (const text of ["⌘", "⌥", "⇧", "⌃", "↵", "⏎", "⇥", "⌫", "⌦"]) expect(found).toContain(text);
  expect(found).toEqual(expect.arrayContaining(["Option-", "Option+", "this Mac", "This Mac"]));
  // Every line after the fixture's own comment trips the check.
  const lines = new Set(problems.map((problem) => Number(problem.split(":")[1])));
  expect([...lines].sort()).toEqual([2, 3, 4, 5, 6]);
  expect(readFileSync(FIXTURE, "utf8").split("\n")[0]).not.toMatch(/[⌘⌥]|Option[-+]|This Mac/);
});

it("passes the shipped built-in panes and words that only look alike", () => {
  expect(check()).toEqual([]);
  expect(paneTextProblems("Options + more · this machine · Macintosh · Ctrl+⏴ arrows ↑↓")).toEqual(
    [],
  );
});

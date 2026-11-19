// SPDX-License-Identifier: MIT
/**
 * SW-XS-11: no automatic sync anywhere. Content reaches a workspace only when a
 * worktree is created, when an agent launch prepares it, or by an explicit MCP
 * call — so no user-facing string in the app may promise projection,
 * materialization, delivery to "every worktree", or keeping things "in sync".
 *
 * Scans every string literal, template literal and JSX text in `src/` (tests,
 * mocks and fixtures excluded). Strings without whitespace are identifiers
 * (event fields, test ids), not copy, and are skipped.
 */
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

import { copyStrings, sourceFiles } from "./__test-utils__/copy-strings";

const ROOT = resolve(__dirname, "../../..");
const BANNED =
  /projected|materializ|propagat|every worktree|every workspace|fan(s|ned|ning)?[ -]?out|\bkeeps?\b[^.]{0,40}\bin sync|kept in sync/i;

/** Copy only: a string without whitespace is an identifier (an event field, a test id). */
const phrases = (path: string) => copyStrings(path).filter(({ text }) => /\s/.test(text.trim()));

describe("app copy promises no automatic sync (SW-XS-11)", () => {
  it("no user-facing string says projected, materialize, every worktree or in sync", () => {
    const hits = sourceFiles(join(ROOT, "src")).flatMap((path) =>
      phrases(path)
        .filter(({ text }) => BANNED.test(text))
        .map(({ line, text }) => `${relative(ROOT, path)}:${line}: ${text.replace(/\s+/g, " ")}`),
    );
    expect(hits).toEqual([]);
  });

  it("the scan sees strings (it would catch a regression)", () => {
    const strings = phrases(join(ROOT, "src/shared/lib/onboarding-copy.ts"));
    expect(strings.some(({ text }) => text.includes("their definition declares"))).toBe(true);
    expect(BANNED.test("codesense keeps its context in sync")).toBe(true);
    expect(BANNED.test("propagate the deletion to every projected copy")).toBe(true);
    expect(BANNED.test("it fans out to every workspace")).toBe(true);
  });
});

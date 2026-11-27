// SPDX-License-Identifier: MIT
/**
 * The team's first page is its landing page; "starter" means only a group's
 * starter. So no string literal, template literal or JSX text under `src/`
 * (tests, mocks and fixtures excluded) may say "starter page". Comments and
 * identifiers are not copy and stay exempt.
 */
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

import { copyStrings, sourceFiles } from "@/shared/lib/__test-utils__/copy-strings";

const ROOT = resolve(__dirname, "../../../..");
const BANNED = /starter page/i;

const hitsIn = (path: string, text?: string) =>
  copyStrings(path, text)
    .filter(({ text }) => BANNED.test(text))
    .map(({ line, text }) => `${relative(ROOT, path)}:${line}: ${text.replace(/\s+/g, " ")}`);

describe("app copy calls the team's first page its landing page", () => {
  it("no user-facing string says starter page", () => {
    expect(sourceFiles(join(ROOT, "src")).flatMap((path) => hitsIn(path))).toEqual([]);
  });

  it("the scan catches the old label, and skips comments", () => {
    const fixture = [
      "// Set as team starter page: a comment, exempt.",
      'export const label = "Set as team starter page";',
      "export const Item = () => <span>Clear starter page</span>;",
    ].join("\n");
    expect(hitsIn(join(ROOT, "src/fixture.tsx"), fixture)).toEqual([
      "src/fixture.tsx:2: Set as team starter page",
      "src/fixture.tsx:3: Clear starter page",
    ]);
  });
});

// SPDX-License-Identifier: MIT
import { resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Non-regression guard: the Mod key is read through the helpers in `keystroke.ts`, and
 * `eslint.config.js` fails any other `.metaKey` read under `src/`.
 */

/** The repo root, so the guard reads the same config whatever the working directory. */
const ROOT = resolve(__dirname, "../../../..");

const READS_META_KEY = "export const isCmd = (e: KeyboardEvent) => e.metaKey;\n";

async function ruleIds(source: string, filePath: string): Promise<(string | null)[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.map((m) => m.ruleId);
}

describe("mod key reads", () => {
  it("lint flags a .metaKey read outside the shortcuts folder", async () => {
    expect(await ruleIds(READS_META_KEY, "src/features/org/components/org-picker.ts")).toContain(
      "no-restricted-properties",
    );
  }, 60_000);

  it("lint flags a .metaKey read in a test file", async () => {
    expect(await ruleIds(READS_META_KEY, "src/features/org/org-picker.test.ts")).toContain(
      "no-restricted-properties",
    );
  }, 60_000);

  it("lint allows the read inside the shortcuts folder", async () => {
    expect(await ruleIds(READS_META_KEY, "src/shared/lib/shortcuts/keystroke.ts")).not.toContain(
      "no-restricted-properties",
    );
  }, 60_000);
});

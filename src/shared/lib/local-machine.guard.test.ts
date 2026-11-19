// SPDX-License-Identifier: MIT
/**
 * The app names the machine it runs on through `local-machine.ts`, so it reads
 * "This computer" off macOS. No other app copy may say "this Mac" or the bare
 * noun "Mac".
 *
 * Same scanner and scope as the shortcut-glyph guard: the strings, template text
 * and JSX text of every non-test `.ts`/`.tsx` file under `src/` (mocks, fixtures
 * and generated files excluded). Comments are not copy. `isMac`, `macOS` and
 * `each_mac` do not match `\bMac\b`; "this machine" is a different word.
 */
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

import { copyStrings, sourceFiles } from "./__test-utils__/copy-strings";

const ROOT = resolve(__dirname, "../../..");
const HELPER = join(ROOT, "src/shared/lib/local-machine.ts");
const MAC = /\bthis mac\b|\bMac\b/i;

/**
 * Copy that keeps the word on purpose, by file and text, each with its reason.
 * Kept short: anything here is not named through the helper.
 */
const ALLOWED: ReadonlyArray<{ file: string; text: RegExp; why: string }> = [];

function macHits(path: string, text?: string): string[] {
  const file = relative(ROOT, path);
  return copyStrings(path, text)
    .filter(({ text: copy }) => MAC.test(copy))
    .filter(({ text: copy }) => !ALLOWED.some((a) => a.file === file && a.text.test(copy)))
    .map(({ line, text: copy }) => `${file}:${line}: ${copy.replace(/\s+/g, " ")}`);
}

describe("the local machine is named only through local-machine.ts", () => {
  it('no app copy outside the helper says "this Mac" or "Mac"', () => {
    const hits = sourceFiles(join(ROOT, "src"))
      .filter((path) => path !== HELPER && !path.endsWith(".generated.ts"))
      .flatMap((path) => macHits(path));
    expect(hits).toEqual([]);
  });

  it("catches a planted literal in any case, but not a comment or another word", () => {
    const planted = [
      "// kept on this Mac (a comment)",
      'const a = "Kept on This Mac";',
      "const b = `runs on each teammate's Mac`;",
      "const c = <span>THIS MAC</span>;",
      'const d = "this machine, macOS, isMac, each_mac, Macintosh";',
    ].join("\n");
    expect(macHits(join(ROOT, "src/planted.tsx"), planted)).toEqual([
      "src/planted.tsx:2: Kept on This Mac",
      "src/planted.tsx:3: runs on each teammate's Mac",
      "src/planted.tsx:4: THIS MAC",
    ]);
  });
});

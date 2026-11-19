// SPDX-License-Identifier: MIT
/**
 * Shortcut labels render through `keystroke.ts`'s formatters, so they read
 * `Ctrl+…` off macOS. No other app copy may spell a macOS key glyph.
 *
 * Scans the strings, template text and JSX text of every non-test `.ts`/`.tsx`
 * file under `src/` (mocks, fixtures and generated files excluded); comments
 * are not copy and may name glyphs.
 */
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

import { copyStrings, sourceFiles } from "../__test-utils__/copy-strings";

const ROOT = resolve(__dirname, "../../../..");
const FORMATTER = join(ROOT, "src/shared/lib/shortcuts/keystroke.ts");
const GLYPH = /[⌘⌥⇧⌃↵↩]/;

function glyphHits(path: string, text?: string): string[] {
  return copyStrings(path, text)
    .filter(({ text: copy }) => GLYPH.test(copy))
    .map(({ line, text: copy }) => `${relative(ROOT, path)}:${line}: ${copy}`);
}

describe("shortcut glyphs come only from the keystroke formatters", () => {
  it("no app copy outside keystroke.ts spells ⌘ ⌥ ⇧ ⌃ ↵ or ↩", () => {
    const hits = sourceFiles(join(ROOT, "src"))
      .filter((path) => path !== FORMATTER && !path.endsWith(".generated.ts"))
      .flatMap((path) => glyphHits(path));
    expect(hits).toEqual([]);
  });

  it("catches a planted literal, a lone glyph chord and JSX text, but not a comment", () => {
    const planted = [
      "// ⌘K in a comment is fine",
      'const a = "Save (⌘S)";',
      'const b = "⌘N";',
      "const c = `Send ${x} ⇧↵`;",
      "const d = <kbd>⌃G</kbd>;",
    ].join("\n");
    expect(glyphHits(join(ROOT, "src/planted.tsx"), planted)).toEqual([
      "src/planted.tsx:2: Save (⌘S)",
      "src/planted.tsx:3: ⌘N",
      "src/planted.tsx:4: Send   ⇧↵",
      "src/planted.tsx:5: ⌃G",
    ]);
  });
});

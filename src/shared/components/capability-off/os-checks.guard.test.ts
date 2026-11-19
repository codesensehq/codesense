// SPDX-License-Identifier: MIT
/**
 * Feature code doesn't check the OS. Whether a feature exists on this OS is a capability: ask
 * `useCapability` and explain it with a `CapabilityOff` variant (see `README.md` here). The OS
 * checks feature code has today are presentation (key names, shortcut glyphs, the title-bar
 * inset), listed below with why; the list only shrinks.
 *
 * Scans every non-test `.ts`/`.tsx` file under `src/features/`, comments left out.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const FEATURES = join(ROOT, "src/features");

/** The direct OS checks: the platform helpers (imported, aliased or called), the browser's and
 *  Node's platform fields (read or destructured), a regex tested for an OS name, and an OS name
 *  compared with a value. */
const OS_CHECKS: readonly RegExp[] = [
  /\b(isMac|isLinuxPlatform)\b/,
  /\bnavigator\s*\.\s*platform\b/,
  /\buserAgent(Data)?\b/,
  /\}\s*=\s*(globalThis\.|window\.)?navigator\b/,
  /\bprocess\s*\.\s*platform\b/,
  /\/[^/\n]*\b(mac|macos|win|win32|windows|linux|darwin)\b[^/\n]*\/[a-z]*\s*\.\s*test\s*\(/i,
  /[!=]==?\s*["'`](darwin|win32|windows|linux|macos|mac)["'`]/i,
  /["'`](darwin|win32|windows|linux|macos|mac)["'`]\s*[!=]==?/i,
];

/**
 * Today's uses, by file, with why each is there; all but one are presentation. Remove a file once it
 * no longer checks the OS (the guard says when); never add one.
 */
const ALLOWED: Record<string, string> = {
  "src/features/machines/lib/passphrase-hint.ts": "names the OS dialog that asks for a passphrase",
  "src/features/settings/components/general-section.tsx":
    "a feature gate, not presentation: the macOS-only menu bar item and quit-on-close settings; to move to a capability",
  "src/features/shell/components/title-bar.tsx": "reserves the traffic-light inset only on macOS",
  "src/features/viewer/components/agents-tree-view.tsx": "names the modifier key (Option or Alt)",
  "src/features/viewer/components/tab-context-menu.tsx":
    "names the close key (Backspace or Delete)",
  "src/features/viewer/components/terminal-grid-caption.tsx":
    "terminal key handling: Backspace closes on macOS, Delete elsewhere",
  "src/features/viewer/components/terminal-tab-bar.tsx":
    "terminal key handling: Backspace closes on macOS, Delete elsewhere",
  "src/features/viewer/components/workspace-tray.tsx": "names the modifier key (Option or Alt)",
  "src/features/viewer/lib/os-attention.ts": "picks the OS's own notification sound",
  "src/features/viewer/lib/terminal-close.ts": "shows the close key's glyph (⌫ or Del)",
};
/** The ratchet: lower it with each file removed above, never raise it. */
const MOST_ALLOWED = 10;

/** The source without its comments, so prose about a check isn't one. A block comment keeps its
 *  line breaks, so the lines after it keep their numbers. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The 1-based lines of `source` that check the OS directly. */
function osCheckLines(source: string): number[] {
  return code(source)
    .split("\n")
    .flatMap((line, i) => (OS_CHECKS.some((check) => check.test(line)) ? [i + 1] : []));
}

/** Files that check the OS and aren't allowed to, as `path:line`. */
function violations(files: Record<string, string>, allowed: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([path, source]) =>
    path in allowed ? [] : osCheckLines(source).map((line) => `${path}:${line}`),
  );
}

function featureFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith("__test") ? [] : featureFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

const FILES: Record<string, string> = Object.fromEntries(
  featureFiles(FEATURES).map((path) => [relative(ROOT, path), readFileSync(path, "utf8")]),
);

describe("feature code asks useCapability, not the OS", () => {
  it("no feature file checks the OS outside the allowlist", () => {
    expect(
      violations(FILES, ALLOWED),
      "Gate a feature with useCapability and a CapabilityOff variant " +
        "(src/shared/components/capability-off/README.md), not an OS check.",
    ).toEqual([]);
  });

  it("the allowlist only shrinks: each entry still checks the OS, and there are no more", () => {
    const stale = Object.keys(ALLOWED).filter(
      (path) => osCheckLines(FILES[path] ?? "").length === 0,
    );
    expect(stale, "These no longer check the OS: remove them and lower MOST_ALLOWED.").toEqual([]);
    expect(Object.keys(ALLOWED).length).toBeLessThanOrEqual(MOST_ALLOWED);
    for (const reason of Object.values(ALLOWED)) expect(reason.trim()).not.toBe("");
  });
});

describe("the guard's fixtures", () => {
  const NEW_FILE = "src/features/example/components/example-panel.tsx";

  it("fails a new OS check in a feature file", () => {
    for (const source of [
      `export const Panel = () => (isMac() ? <Remote /> : null);`,
      `if (isLinuxPlatform(navigator.platform)) hide();`,
      `const windows = navigator.userAgent.includes("Windows");`,
      `if (navigator.userAgentData?.platform) hide();`,
      `if (os === "windows") return null;`,
      `if ("darwin" !== platform) return null;`,
      `import { isMac as onApple } from "@/shared/lib/shortcuts/keystroke";`,
      `const { platform } = navigator;`,
      `if (/Win/.test(platform)) return null;`,
      `const linux = process.platform === "linux";`,
    ]) {
      expect(violations({ [NEW_FILE]: source }, ALLOWED), source).toEqual([`${NEW_FILE}:1`]);
    }
  });

  it("keeps the line of a check after a multi-line block comment", () => {
    const source = [`/**`, ` * isMac() in prose`, ` */`, `const mac = isMac();`].join("\n");
    expect(violations({ [NEW_FILE]: source }, ALLOWED)).toEqual([`${NEW_FILE}:4`]);
  });

  it("passes useCapability, and an OS check only in a comment", () => {
    const source = [
      `// Not isMac(): whether remote machines exist here is a capability.`,
      `const remote = useCapability("remote-machines");`,
      `/* navigator.platform is the shared layer's to read */`,
      `if (!remote.on) return <CapabilityOff cap="remote-machines" />;`,
      `const url = "https://example.com/linux";`,
    ].join("\n");
    expect(violations({ [NEW_FILE]: source }, ALLOWED)).toEqual([]);
  });
});

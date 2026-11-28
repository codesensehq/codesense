// SPDX-License-Identifier: MIT
// Proves the test-only front-end code stays out of the release bundle: the webdriver controls
// (`src/app/e2e-*`), the satellite probe route and the WebDriver plugin's own front-end. Each
// lives behind a `MODE === "webdriver"` (or "mock") branch Vite replaces statically, so the
// release build drops it; this check reads the bundle's content, not its chunk names, so code
// Vite inlines into another chunk is still found.
//
// Usage: tsx scripts/verify-webdriver-absence.ts               build the release bundle with
//                                                              `vite build` into a temp dir and
//                                                              fail on any marker in it
//        tsx scripts/verify-webdriver-absence.ts --expect-present [dir]
//                                                              scan an existing webdriver build
//                                                              (default dist/) and fail unless
//                                                              every marker is in it, so a check
//                                                              that can no longer see them fails
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The content each piece of test-only code leaves in a bundle that holds it. */
export const MARKERS: readonly string[] = [
  // The window globals the webdriver controls set.
  "__CODESENSE_ACTIVITY_E2E__",
  "__CODESENSE_CLI_E2E__",
  "__CODESENSE_CLOSE_REOPEN_E2E__",
  "__CODESENSE_CONFIGURATION_E2E__",
  "__CODESENSE_CONTENT_NAV_E2E__",
  "__CODESENSE_E2E_LISTENERS__",
  "__CODESENSE_ORG_E2E__",
  "__CODESENSE_TERMINAL_EVICT_E2E__",
  "__CODESENSE_TERMINAL_LAYOUT_E2E__",
  "__CODESENSE_TERMINAL_WEBGL_E2E__",
  "__CODESENSE_WEFT_E2E__",
  "__CODESENSE_WINDOWS_E2E__",
  // The satellite probe route: its results global and its marker.
  "__CODESENSE_PROBE_RESULTS__",
  "codesense-e2e-satellite-probe",
  // The WebDriver plugin's front-end (`@wdio/tauri-plugin`).
  "plugin:wdio|execute",
  "plugin:wdio|log_frontend",
  "wdioTauri",
];

const TEXT = /\.(?:js|mjs|cjs|css|html|json|svg|txt)$/;

/** Every text file under `dir`, keyed by its path relative to `dir`. */
export function bundleFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TEXT.test(entry.name))
        files.set(path.relative(dir, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return files;
}

/**
 * The problems with a bundle: with `expectPresent` false, each marker found and the file it is
 * in; with it true, each marker no file holds. An empty bundle is always a problem.
 */
export function bundleProblems(
  files: ReadonlyMap<string, string>,
  {
    expectPresent = false,
    markers = MARKERS,
  }: { expectPresent?: boolean; markers?: readonly string[] } = {},
): string[] {
  if (files.size === 0) return ["the bundle holds no text files; nothing was checked"];
  const problems: string[] = [];
  for (const marker of markers) {
    const holders = [...files].filter(([, text]) => text.includes(marker)).map(([name]) => name);
    if (expectPresent && holders.length === 0)
      problems.push(`${marker}: missing from the webdriver bundle; the check cannot see it`);
    if (!expectPresent)
      for (const name of holders) problems.push(`${marker}: in the release bundle (${name})`);
  }
  return problems;
}

function main(argv: string[]): number {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const expectPresent = argv[0] === "--expect-present";
  if (expectPresent) {
    const dir = path.resolve(root, argv[1] ?? "dist");
    const problems = bundleProblems(bundleFiles(dir), { expectPresent });
    for (const problem of problems) console.error(problem);
    if (problems.length === 0)
      console.log(`webdriver bundle: all ${MARKERS.length} markers present in ${dir}`);
    return problems.length === 0 ? 0 : 1;
  }
  if (argv.length > 0) {
    console.error("usage: verify-webdriver-absence.ts [--expect-present [dir]]");
    return 2;
  }
  const out = mkdtempSync(path.join(tmpdir(), "webdriver-absence-"));
  try {
    execFileSync("pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir"], {
      cwd: root,
      stdio: "inherit",
    });
    const problems = bundleProblems(bundleFiles(out));
    for (const problem of problems) console.error(problem);
    if (problems.length === 0)
      console.log(`release bundle: none of the ${MARKERS.length} test-only markers`);
    return problems.length === 0 ? 0 : 1;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));

// SPDX-License-Identifier: MIT
/**
 * Tauri IPC Contract Test
 *
 * Validates that TypeScript command wrappers (commands.ts) stay in sync
 * with Rust handler registrations (lib.rs). Catches drift when someone
 * adds/removes a command on one side without updating the other.
 *
 * This test parses source files directly — no runtime Tauri needed. No check
 * holds a command total: each is derived from the source, so two PRs that each
 * add a command touch no shared line here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { relative, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../..");

// The files whose `invoke("…")` calls are the TS command wrappers, relative to this directory.
const EXTRACTOR_FILES = [
  "commands.ts",
  "../features/dashboard/lib/verb-dispatch.ts",
  "../shared/stores/local-profile-store.ts",
  "../shared/lib/local-profile-session.ts",
  // The beta update wrappers (the commands are registered under the beta cfg).
  "../features/license/api.ts",
  // The two-window driver's wrappers (the commands are registered under `e2e-webdriver`).
  "../app/e2e-windows-control.ts",
];

// Command names may contain digits (e.g. `wv_e2e_seed_dispatch`), so the char class
// mirrors the Rust extractor's `\w` — `[a-z0-9_]` — not a digit-free `[a-z_]`.
const invokePattern = /invoke\s*(?:<[^>]*>)?\s*\(\s*["']([a-z0-9_]+)["']/g;

// Match command paths like commands::install::create_symlink,
// mcp::state::push_viewer_state, or single-segment modules like
// menu::rebuild_menu (the macOS menu). Any allowed prefix may nest modules
// (e.g. live_hub::files::file_surface_prepare_view):
// `(?:::\w+)*` consumes every module segment greedily and the trailing `::(\w+)`
// backtracks to capture the final command name at any depth.
// Single-segment top-level command modules (like `menu`) are allow-listed by
// name: `renderer_watchdog` hosts the `renderer_heartbeat` ack;
// `mcp_registration` hosts the MCP integration-surface commands.
// `weft` is a top-level module (like `menu`) that hosts `#[tauri::command]`s
// registered as `weft::<sub>::<cmd>` (`weft::preflight::preflight_wv_dispatch`).
// `license::commands` hosts the beta license commands (registered under the beta cfg).
// `gif::settings` hosts the GIF search settings and key commands.
// `flags` hosts the release flags' boot-value commands.
// `windows` hosts the window commands; `windows::commands` hosts the window registry's.
const handlerPattern =
  /(?:commands|license::commands|dashboard_publish|verbs::commands|records::commands|mcp|mcp_registration|menu|renderer_watchdog|live_hub|weft|gif|flags|windows)(?:::\w+)*::(\w+)/g;
// The same pattern held to a whole `generate_handler!` entry, so `zz_commands::foo` can't
// pass through its `commands::foo` substring. No `g` flag: `.test()` with `g` is stateful.
const handlerEntryPattern = new RegExp(`^(?:${handlerPattern.source})$`);

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf-8");
}

// The end of a bracketed run that opens at `open`, tracking depth so a nested `[…]`
// (an `#[cfg(...)]` attribute) doesn't end it early.
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

// The `generate_handler![…]` block's contents. A balanced-bracket scan, because the
// `#[cfg(...)]` attributes inside the block contain `]`.
function handlerBlock(libRs: string): string {
  const start = libRs.indexOf("generate_handler![");
  if (start === -1) throw new Error("Could not find generate_handler! block in lib.rs");
  const open = start + "generate_handler!".length;
  const close = closingBracket(libRs, open);
  if (close === -1) throw new Error("generate_handler! block in lib.rs is not closed");
  return libRs.slice(open + 1, close);
}

/** Every `generate_handler!` entry as written, with comments and `#[…]` attributes stripped. */
function parseHandlerEntries(libRs: string): string[] {
  let block = handlerBlock(libRs).replace(/\/\/[^\n]*/g, "");
  for (let at = block.indexOf("#["); at !== -1; at = block.indexOf("#[")) {
    const close = closingBracket(block, at + 1);
    block = block.slice(0, at) + (close === -1 ? "" : block.slice(close + 1));
  }
  return block
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The entries no listed prefix owns: their command would be missed by the parity checks. */
function unmatchedHandlerEntries(entries: string[]): string[] {
  return entries.filter((entry) => !handlerEntryPattern.test(entry));
}

/** The source files allowed to call `invoke("…")` directly. */
const INVOKE_FILES = new Set([
  ...EXTRACTOR_FILES.map((file) => relative(REPO_ROOT, resolve(__dirname, file))),
  "src/tauri/draft-commands.ts",
]);

function isTestOrMock(path: string): boolean {
  return (
    /\.(?:test|spec)\.[^/]*$/.test(path) ||
    path.includes("/__tests__/") ||
    path.startsWith("src/app/mock/")
  );
}

/**
 * The renderer files outside the wrapper files that `invoke("…")` a command by literal
 * name. Such a call bypasses the parity checks, which read only the wrapper files.
 * Paths are repo-relative; test, spec and mock files are skipped.
 */
function strayInvokes(files: { path: string; text: string }[]): string[] {
  const literalInvoke = new RegExp(invokePattern.source);
  return files
    .filter(({ path }) => !isTestOrMock(path) && !INVOKE_FILES.has(path))
    .filter(({ text }) => literalInvoke.test(text))
    .map(({ path }) => path)
    .sort();
}

/**
 * The exception-list members that no longer hold: a Rust-only name must be registered
 * and unwrapped, a TS-only name wrapped and unregistered.
 */
function staleExceptions(
  rustHandlers: string[],
  tsCommands: string[],
  rustOnly: Set<string>,
  tsOnly: Set<string>,
): string[] {
  const rust = new Set(rustHandlers);
  const ts = new Set(tsCommands);
  const stale: string[] = [];
  for (const name of rustOnly) {
    if (!rust.has(name)) stale.push(`RUST_ONLY_COMMANDS ${name} is not registered`);
    if (ts.has(name)) stale.push(`RUST_ONLY_COMMANDS ${name} has a TS wrapper`);
  }
  for (const name of tsOnly) {
    if (!ts.has(name)) stale.push(`TS_ONLY_COMMANDS ${name} has no TS wrapper`);
    if (rust.has(name)) stale.push(`TS_ONLY_COMMANDS ${name} is registered`);
  }
  return stale;
}

// Rust source with every `#[cfg(test)] mod name { … }` block cut out. The brace scan
// skips strings, raw strings, char literals and comments, so a `"{"` doesn't miscount.
function withoutTestModules(rust: string): string {
  const testModule =
    /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g;
  let out = "";
  let from = 0;
  let match;
  while ((match = testModule.exec(rust)) !== null) {
    out += rust.slice(from, match.index);
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < rust.length && depth > 0) {
      const rest = rust.slice(i, i + 12);
      const raw = /^r(#*)"/.exec(rest);
      const char = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'/.exec(rest);
      if (rest.startsWith("//")) {
        i = rust.indexOf("\n", i);
        if (i === -1) i = rust.length;
      } else if (rest.startsWith("/*")) {
        const end = rust.indexOf("*/", i + 2);
        i = end === -1 ? rust.length : end + 2;
      } else if (raw && !/\w/.test(rust[i - 1] ?? "")) {
        const end = rust.indexOf(`"${raw[1]}`, i + raw[0].length);
        i = end === -1 ? rust.length : end + 1 + raw[1].length;
      } else if (rust[i] === '"') {
        i++;
        while (i < rust.length && rust[i] !== '"') i += rust[i] === "\\" ? 2 : 1;
        i++;
      } else if (char) {
        i += char[0].length;
      } else {
        if (rust[i] === "{") depth++;
        else if (rust[i] === "}") depth--;
        i++;
      }
    }
    from = i;
    testModule.lastIndex = i;
  }
  return out + rust.slice(from);
}

function isRustTestFile(path: string): boolean {
  return /(?:^|\/)tests?(?:\/|\.rs$)|_tests?\.rs$/.test(path);
}

/**
 * The `#[tauri::command]` fns in non-test Rust files whose name no `generate_handler!`
 * entry ends in, as `path::fn`. Matching is by the fn name, the last segment of an entry.
 */
function unregisteredCommands(
  rustFiles: { path: string; text: string }[],
  handlerEntries: string[],
): string[] {
  const registered = new Set(handlerEntries.map((entry) => entry.split("::").pop()));
  // The attribute on its own line, then any further attributes or comments, then the fn.
  const commandFn =
    /^[ \t]*#\[tauri::command\][ \t]*\n(?:[ \t]*(?:#\[|\/\/)[^\n]*\n)*[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm;
  const missing: string[] = [];
  for (const { path, text } of rustFiles) {
    if (isRustTestFile(path)) continue;
    for (const match of withoutTestModules(text).matchAll(commandFn)) {
      if (!registered.has(match[1])) missing.push(`${path}::${match[1]}`);
    }
  }
  return missing.sort();
}

// Every file under `dir` (repo-relative) whose name passes `keep`, with its text.
function walkRepo(dir: string, keep: (path: string) => boolean): { path: string; text: string }[] {
  return readdirSync(resolve(REPO_ROOT, dir), { recursive: true, encoding: "utf-8" })
    .map((entry) => `${dir}/${entry.split("\\").join("/")}`)
    .filter(keep)
    .map((path) => ({ path, text: readRepoFile(path) }));
}

// Parse TypeScript invoke calls from the wrapper files.
function extractTypeScriptCommands(): string[] {
  const source = EXTRACTOR_FILES.map((file) =>
    readFileSync(resolve(__dirname, file), "utf-8"),
  ).join("\n");
  return [...new Set([...source.matchAll(invokePattern)].map((match) => match[1]))].sort();
}

// Parse Rust handler registrations from lib.rs: the command name ending each entry a
// listed prefix owns.
function extractRustHandlers(): string[] {
  const entries = parseHandlerEntries(readRepoFile("src-tauri/src/lib.rs"));
  return [
    ...new Set(
      entries.flatMap((entry) => [...entry.matchAll(handlerPattern)].map((match) => match[1])),
    ),
  ].sort();
}

// Rust-only commands that intentionally have no TS wrapper.
// These exist in generate_handler![] but have been removed from the TS layer.
const RUST_ONLY_COMMANDS = new Set([
  "revoke_local_machine_access", // Runtime authority revocation; no renderer action currently.
  "watch_for_claude_session", // Dead after terminal unification (story 34.10); Rust removal pending
  "cancel_session_watcher", // Dead after terminal unification (story 34.10); Rust removal pending
  // RF-2: verify_installation removed (deprecated legacy install-health command,
  // deleted with the whole config-lock.yml command/reader surface).
  // Pre-existing on main after the SW-AU-77A rebase: these landed registered in
  // generate_handler![] with no TS wrapper (their own stories own the wrapper if
  // one is intended). Allow-listed here only so this branch's symmetry test is
  // green; not introduced by SW-AU-77A.
  // SW-AU-86B added the `workflowNodeKindCatalog` TS wrapper, so workflow_node_kind_catalog is no
  // longer Rust-only — it left this set and now counts as a both-sides command.
  // SW-OC-25c: the dev/test-gated orchestration_store_spike_probe / status_effect_probe were
  // deleted with the sprint auto-run, so they left this set.
  // SW-IS-F10 (S4): `set_forward_sync_default` + `set_forward_sync_overrides` now have
  // renderer wrappers (`setForwardSyncDefault` / `setForwardSyncOverrides`), driven by the
  // unified Sync settings surface, so they LEFT this Rust-only set and are both-sides commands.
  // SW-WV-B5: the eight scope-layer Tauri commands are registered in generate_handler![]
  // but ship with no renderer IPC wrapper yet (the FE scope/watch surface lands in a later
  // WV story) — Rust-only until then, so the symmetry check treats them like the probes.
  "cmd_wv_scope_get",
  "cmd_wv_scope_create",
  "cmd_wv_scope_update_artifact_ptr",
  "cmd_wv_scope_close",
  "cmd_wv_watch_upsert",
  "cmd_wv_watch_close",
  "cmd_wv_watch_mark_quiet",
  "cmd_wv_watch_list",
  // SW-WV-C6: the four decision-harvest-norm Tauri commands are controller-tier and
  // registered in generate_handler![] with no renderer IPC wrapper yet — Rust-only.
  "wv_set_harvest_artifact",
  "wv_approve_harvest",
  "wv_mark_harvest_not_required",
  "wv_list_overdue_harvests",
  // SW-WV-RT1: the signal-done bridge is a Tauri door onto the same signal_done hook
  // registry the MCP verb dispatches — reachable from the UI and the QH harness
  // (core.invoke). It has no renderer IPC wrapper yet (its first caller is the QH
  // harness / a later Board wiring), so it is Rust-only until then.
  "wv_signal_done_bridge",
  // SW-AV-27 removed the lease/controller/gate harness drivers (`wv_e2e_drive_lease`,
  // `wv_e2e_drive_posture`, `wv_e2e_drive_gate`, `wv_e2e_drive_e1`, `wv_e2e_drive_e13`) with
  // the control plane; SW-OC-19 removed the completion-reply drivers
  // (`wv_e2e_e1_reply_state`, `wv_e2e_drive_decoupling_reply`) with the reply-owed ledger.
  // SW-WA-E7: the harness-only Stage-2 red-path driver — an unverified dispatch cannot
  // fold. (SW-AV-27 removed the `wv_e2e_drive_tier_spawn` and `wv_e2e_drive_gate_open`
  // drivers with the tier/gate control plane.) Refused unless CODESENSE_E2E=1 and reached
  // only by the QH weft-e2e harness via core.invoke — no renderer IPC wrapper, so Rust-only.
  "wv_e2e_drive_fold",
  // SW-WA-F4: the harness-only open→run→read round-trip drivers. They drive the REAL
  // F1/F2/F3 MCP verb methods (open_terminal_tab → run_in_terminal_tab →
  // read_terminal_tab) on a fresh handler over the live app so the capstone's Act 3
  // operator round-trip + forged-target red path are provable in the weft-e2e harness.
  // Refused unless CODESENSE_E2E=1 and reached only by that harness via core.invoke —
  // no renderer IPC wrapper, so both are Rust-only. (open+run is one-shot; read is
  // polled because the ls output tees into the PTY ring asynchronously.)
  "wv_e2e_terminal_open_run",
  "wv_e2e_terminal_read",
  // SW-AV-27 removed the harness-only controller arm drivers (`wv_e2e_arm_controller`,
  // `wv_e2e_cold_open_bootstrap`) with the lease/controller control plane.
]);

// TypeScript wrappers that intentionally have no Rust handler YET — the handler
// lands in a paired, later-merging story. The parity check ignores these on both
// sides so a forward-declared FE binding does not redden the branch that ships it.
const TS_ONLY_COMMANDS = new Set<string>([
  // SW-WV-F7: `wv_dispatch_worker` was forward-declared TS-only by SW-WV-F2 (the
  // "Dispatch & release" button's `dispatchWeftWorker` wrapper shipped ahead of its
  // Rust handler). F7 lands `weft::dispatch_bridge::wv_dispatch_worker` and registers
  // it in generate_handler![], so the entry is REMOVED here — the verb is now a full
  // both-sides pair (folds DW-F2-3). No forward-declared TS wrapper remains.
]);

describe("Tauri IPC Contract", () => {
  const tsCommands = extractTypeScriptCommands();
  const rustHandlers = extractRustHandlers();
  const effectiveRustHandlers = rustHandlers.filter((cmd) => !RUST_ONLY_COMMANDS.has(cmd));
  // Forward-declared TS wrappers whose Rust handler ships in a paired later story are
  // excluded from the symmetry check (the stale-exception check below keeps the list honest).
  const effectiveTsCommands = tsCommands.filter((cmd) => !TS_ONLY_COMMANDS.has(cmd));

  it("TypeScript and Rust have the same number of active commands", () => {
    expect(effectiveTsCommands.length).toBe(effectiveRustHandlers.length);
  });

  it("does not register or wrap the retired provider-token command", () => {
    expect(tsCommands).not.toContain("set_provider_token");
    expect(rustHandlers).not.toContain("set_provider_token");
  });

  it("every TypeScript invoke has a matching Rust handler", () => {
    const missingInRust = effectiveTsCommands.filter((cmd) => !rustHandlers.includes(cmd));
    expect(missingInRust).toEqual([]);
  });

  it("every active Rust handler has a matching TypeScript wrapper", () => {
    const missingInTS = effectiveRustHandlers.filter((cmd) => !tsCommands.includes(cmd));
    expect(missingInTS).toEqual([]);
  });

  it("active commands match exactly (sorted comparison)", () => {
    expect(effectiveTsCommands).toEqual(effectiveRustHandlers);
  });

  it("has at least 59 commands registered (sanity check)", () => {
    expect(effectiveTsCommands.length).toBeGreaterThanOrEqual(59);
    expect(effectiveRustHandlers.length).toBeGreaterThanOrEqual(59);
  });

  // Check (a): every registration is one the parity checks can see.
  it("every generate_handler! entry is under a listed prefix", () => {
    const entries = parseHandlerEntries(readRepoFile("src-tauri/src/lib.rs"));
    expect(entries.length).toBeGreaterThanOrEqual(59);
    expect(unmatchedHandlerEntries(entries)).toEqual([]);
  });

  it("reports a handler entry under an unlisted prefix, cfg-gated entries included", () => {
    const libRs = [
      "tauri::generate_handler![",
      "    commands::a::x, // a comment, with a comma",
      "    agents::y,",
      "    zz_commands::z,",
      '    #[cfg(all(test, feature = "x"))] mcp::w',
      "])",
    ].join("\n");
    const entries = parseHandlerEntries(libRs);
    expect(entries).toEqual(["commands::a::x", "agents::y", "zz_commands::z", "mcp::w"]);
    expect(unmatchedHandlerEntries(entries)).toEqual(["agents::y", "zz_commands::z"]);
  });

  // Check (b): a literal invoke outside the wrapper files is a command the parity checks miss.
  it("no renderer file invokes a command outside the wrapper files", () => {
    const files = walkRepo("src", (path) => /\.tsx?$/.test(path));
    expect(files.length).toBeGreaterThan(EXTRACTOR_FILES.length);
    expect(strayInvokes(files)).toEqual([]);
  });

  it("flags a literal invoke in a feature file, in either quote style, but not in a mock or test", () => {
    expect(
      strayInvokes([
        { path: "src/features/x/y.tsx", text: 'await invoke<Foo>("bar");' },
        { path: "src/features/x/z.tsx", text: "await invoke('bar');" },
        { path: "src/app/mock/handlers/x.ts", text: 'await invoke<Foo>("bar");' },
        { path: "src/features/x/y.test.ts", text: "await invoke('bar');" },
        { path: "src/features/x/__tests__/w.ts", text: 'await invoke("bar");' },
        { path: "src/tauri/commands.ts", text: 'await invoke("bar");' },
        { path: "src/tauri/draft-commands.ts", text: 'await invoke("bar");' },
      ]),
    ).toEqual(["src/features/x/y.tsx", "src/features/x/z.tsx"]);
  });

  // Check (c): an exception that no longer holds would hide a one-sided command.
  it("every RUST_ONLY_COMMANDS and TS_ONLY_COMMANDS member still holds", () => {
    expect(staleExceptions(rustHandlers, tsCommands, RUST_ONLY_COMMANDS, TS_ONLY_COMMANDS)).toEqual(
      [],
    );
  });

  it("reports a wrapped Rust-only name, an unregistered Rust-only name and a handled TS-only name", () => {
    expect(
      staleExceptions(
        ["now_wrapped", "still_rust_only", "now_handled"],
        ["now_wrapped", "now_handled"],
        new Set(["now_wrapped", "still_rust_only", "typo_rust_only"]),
        new Set(["now_handled"]),
      ),
    ).toEqual([
      "RUST_ONLY_COMMANDS now_wrapped has a TS wrapper",
      "RUST_ONLY_COMMANDS typo_rust_only is not registered",
      "TS_ONLY_COMMANDS now_handled is registered",
    ]);
  });

  // Check (d): a command fn dropped from lib.rs and commands.ts together leaves both
  // parity checks green, so the fn itself is checked against the registrations.
  it("every #[tauri::command] fn outside tests is registered in generate_handler!", () => {
    const entries = parseHandlerEntries(readRepoFile("src-tauri/src/lib.rs"));
    const rustFiles = walkRepo("src-tauri/src", (path) => path.endsWith(".rs"));
    expect(unregisteredCommands(rustFiles, entries)).toEqual([]);
  });

  it("reports an annotated fn with no entry, skipping test modules and test files", () => {
    const text = [
      "#[tauri::command]",
      "pub async fn registered() {}",
      "",
      "#[tauri::command]",
      "#[allow(clippy::too_many_arguments)] // a trailing note",
      "pub(crate) fn dropped() {}",
      "",
      "// `#[tauri::command]` in a comment is not a command: fn not_a_command",
      "",
      "#[cfg(test)]",
      "mod tests {",
      '    const BRACE: &str = "}";',
      "    const CH: [char; 3] = ['}', '\\'', '\\u{7d}'];",
      '    const RAW: &str = r#"}"#; // }',
      "    #[tauri::command]",
      "    fn test_only() {}",
      "}",
      "",
      "#[tauri::command]",
      "fn after_tests() {}",
    ].join("\n");
    expect(
      unregisteredCommands(
        [
          { path: "src-tauri/src/commands/x.rs", text },
          { path: "src-tauri/src/commands/x/tests.rs", text: "#[tauri::command]\nfn t() {}" },
        ],
        ["commands::x::registered"],
      ),
    ).toEqual(["src-tauri/src/commands/x.rs::after_tests", "src-tauri/src/commands/x.rs::dropped"]);
  });
});

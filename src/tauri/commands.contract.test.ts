// SPDX-License-Identifier: MIT
/**
 * Tauri IPC Contract Test
 *
 * Validates that TypeScript command wrappers (commands.ts) stay in sync
 * with Rust handler registrations (lib.rs). Catches drift when someone
 * adds/removes a command on one side without updating the other.
 *
 * This test parses source files directly — no runtime Tauri needed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Parse TypeScript invoke calls from commands.ts
function extractTypeScriptCommands(): string[] {
  const source = [
    "commands.ts",
    "../features/dashboard/lib/verb-dispatch.ts",
    "../shared/stores/local-profile-store.ts",
    "../shared/lib/local-profile-session.ts",
    // SW-PB-9: the beta update wrappers (the commands are registered under the beta cfg).
    "../features/license/api.ts",
    // The two-window driver's wrappers (the commands are registered under `e2e-webdriver`).
    "../app/e2e-windows-control.ts",
  ]
    .map((file) => readFileSync(resolve(__dirname, file), "utf-8"))
    .join("\n");
  // Command names may contain digits (e.g. `wv_e2e_seed_dispatch`), so the char class
  // mirrors the Rust extractor's `\w` — `[a-z0-9_]` — not a digit-free `[a-z_]`.
  const invokePattern = /invoke\s*(?:<[^>]*>)?\s*\(\s*["']([a-z0-9_]+)["']/g;
  const commands: string[] = [];
  let match;
  while ((match = invokePattern.exec(source)) !== null) {
    commands.push(match[1]);
  }
  return [...new Set(commands)].sort();
}

// Parse Rust handler registrations from lib.rs
function extractRustHandlers(): string[] {
  const source = readFileSync(resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf-8");
  // Extract the generate_handler![] block contents. Use a balanced-bracket
  // approach because #[cfg(...)] attributes inside the block contain ']'
  // which breaks simple [^\]]+ patterns.
  const start = source.indexOf("generate_handler![");
  if (start === -1) throw new Error("Could not find generate_handler! block in lib.rs");
  const blockStart = start + "generate_handler![".length;
  let depth = 1;
  let i = blockStart;
  while (i < source.length && depth > 0) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") depth--;
    i++;
  }
  const handlerBlock = [null, source.slice(blockStart, i - 1)] as const;
  if (!handlerBlock[1]) throw new Error("Could not find generate_handler! block in lib.rs");

  // Match command paths like commands::install::create_symlink,
  // mcp::state::push_viewer_state, or single-segment modules like
  // menu::rebuild_menu (macOS menu, story C.16). Any allowed prefix may nest modules
  // (e.g. live_hub::files::file_surface_prepare_view):
  // `(?:::\w+)*` consumes every module segment greedily and the trailing `::(\w+)`
  // backtracks to capture the final command name at any depth.
  // Single-segment top-level command modules (like `menu`) are allow-listed by
  // name: `renderer_watchdog` hosts the SW-FX-64 `renderer_heartbeat` ack;
  // `mcp_registration` hosts the SW-AN-5 MCP integration-surface commands.
  // `weft` is a top-level module (like `menu`) that hosts `#[tauri::command]`s
  // registered as `weft::<sub>::<cmd>` (SW-WV-F2 `weft::preflight::preflight_wv_dispatch`).
  // `license::commands` hosts the SW-PB-9 beta license commands (registered under the beta cfg).
  // `gif::settings` hosts the GIF search settings and key commands.
  // `flags` hosts the release flags' boot-value commands.
  // `windows` hosts the window commands; `windows::commands` hosts the window registry's.
  const handlerPattern =
    /(?:commands|license::commands|dashboard_publish|verbs::commands|records::commands|mcp|mcp_registration|menu|renderer_watchdog|live_hub|weft|gif|flags|windows)(?:::\w+)*::(\w+)/g;
  const commands: string[] = [];
  let match;
  while ((match = handlerPattern.exec(handlerBlock[1])) !== null) {
    commands.push(match[1]);
  }
  return [...new Set(commands)].sort();
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
  // excluded from the symmetry check.
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
});

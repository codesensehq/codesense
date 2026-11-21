// SPDX-License-Identifier: MIT
//! Only a person in the native window writes a production MCP binding.
//!
//! The binding store (`commands/mcp_credentials.rs`, keychain service
//! `codesense-mcp`) is `pub`, so module privacy alone proves nothing. This
//! guard fails when any file under `src/mcp/` (every MCP tool handler and the
//! relay) or any embedded-page bridge verb file names the store, its keychain
//! service, a credential-store write or the keychain store. The relay and
//! `agent_get` read bindings only through the read-only `ProductionBindings`
//! trait.
//!
//! Std-only and source-driven, like the other guards: point
//! `CODESENSE_GUARD_ROOT` at another checkout's `src-tauri` to run it there.

use codesense_guards::guard_support::app_root;
use std::fs;
use std::path::{Path, PathBuf};

/// Names that reach the binding store or write a credential.
const FORBIDDEN: [&str; 5] = [
    "mcp_credentials",
    "\"codesense-mcp\"",
    "CredentialStore::set",
    "KeychainStore",
    "set_repairing",
];

/// The production binding commands, which no embedded page may name.
const COMMANDS: [&str; 6] = [
    "mcp_production_bind",
    "mcp_production_remove",
    "mcp_production_status",
    "mcpProductionBind",
    "mcpProductionRemove",
    "mcpProductionStatus",
];

/// Existing uses of a forbidden name that are not the binding store, each with
/// its exact count: the shell wrapper's `$0` label for a native stdio server.
const ALLOWED: [(&str, &str, usize); 1] = [("local_mcp_relay/native.rs", "\"codesense-mcp\"", 1)];

/// The files that hold the dashboard bridge verbs (embedded pages).
const BRIDGE_VERB_FILES: [&str; 3] = [
    "src/features/dashboard/lib/verb-dispatch.ts",
    "src/features/dashboard/lib/verb-policy.ts",
    "src/features/dashboard/lib/verb-registry.generated.ts",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|entry| entry.expect("read entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_mcp_or_bridge_path_reaches_the_binding_store() {
    let app = app_root();
    let mcp = app.join("src/mcp");
    let mut files = Vec::new();
    rust_files(&mcp, &mut files);
    assert!(
        files
            .iter()
            .any(|f| f.ends_with("local_mcp_relay/production.rs")),
        "the relay's production module moved; update this guard"
    );
    let mut offences = Vec::new();
    for file in &files {
        let text = fs::read_to_string(file).expect("read source");
        let label = file
            .strip_prefix(&mcp)
            .expect("under src/mcp")
            .to_string_lossy()
            .replace('\\', "/");
        for name in FORBIDDEN {
            let found = text.matches(name).count();
            let allowed = ALLOWED
                .iter()
                .find(|(path, allowed_name, _)| *path == label && *allowed_name == name)
                .map_or(0, |(_, _, count)| *count);
            if found > allowed {
                offences.push(format!("src/mcp/{label} names {name} ({found}x)"));
            }
        }
    }
    let repo = app.parent().expect("src-tauri has a parent");
    for relative in BRIDGE_VERB_FILES {
        let path = repo.join(relative);
        let text =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        for name in FORBIDDEN.iter().chain(COMMANDS.iter()) {
            if text.contains(name) {
                offences.push(format!("{relative} names {name}"));
            }
        }
    }
    assert!(
        offences.is_empty(),
        "only the native binding command may reach the production MCP binding store:\n{}",
        offences.join("\n")
    );
}

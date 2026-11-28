// SPDX-License-Identifier: MIT
//! The app-command ACL: the commands only `main` may call.
//!
//! A command is main-only when it writes app-wide state that `main` owns from its own copy, so a
//! second caller would clobber or duplicate it. A setting push qualifies only when it also re-runs
//! a global side effect (a warm-pool drain and refill). Every other command is satellite-callable.
//! The frontend keeps a satellite off these paths; this list is the Rust backstop, checked once in
//! the invoke wrapper ([`guarded`], composed into `shared::invoke_stats::counted`), never per command. A command of that kind joins
//! `command_acl.json` in the PR that registers it, with its reason.

use std::sync::LazyLock;

use serde::Deserialize;

use super::is_main;

/// A `command_acl.json` entry. Its `reason` is for readers; the list test checks it is there.
#[derive(Deserialize)]
struct Entry {
    name: String,
}

static ENTRIES: LazyLock<Vec<Entry>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("command_acl.json")).expect("command_acl.json parses")
});

/// The names of the main-only commands, from `command_acl.json`.
pub static MAIN_ONLY_COMMANDS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| ENTRIES.iter().map(|entry| entry.name.as_str()).collect());

/// Whether the window labelled `label` may invoke `command`.
pub fn allowed(label: &str, command: &str) -> bool {
    is_main(label) || !MAIN_ONLY_COMMANDS.iter().any(|name| *name == command)
}

/// The error a refused invoke is rejected with.
pub fn refusal(command: &str) -> String {
    format!("not allowed in this window: {command}")
}

/// Wrap the app's invoke handler so a refused command is rejected and runs nothing.
pub fn guarded<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let message = &invoke.message;
        let command = tauri::ipc::InvokeMessage::command(message);
        if allowed(message.webview_ref().label(), command) {
            return handler(invoke);
        }
        let error = refusal(command);
        invoke.resolver.reject(error);
        true
    }
}

#[cfg(test)]
mod list {
    use super::*;

    /// The command names registered in `lib.rs`'s `generate_handler!`, with every
    /// `#[cfg(...)]`-gated entry included.
    fn registered() -> Vec<String> {
        let lib = include_str!("../lib.rs");
        let start = lib
            .find("generate_handler![")
            .expect("generate_handler! not found")
            + "generate_handler![".len();
        let block = &lib[start..start + lib[start..].find("])").expect("registry end")];
        block
            .lines()
            .map(|line| line.split("//").next().unwrap_or_default())
            .flat_map(|line| line.split(','))
            .map(|entry| {
                let mut entry = entry.trim();
                while entry.starts_with("#[") {
                    entry = entry[entry.find(']').map_or(entry.len(), |i| i + 1)..].trim();
                }
                entry.rsplit("::").next().unwrap_or_default().to_string()
            })
            .filter(|name| !name.is_empty())
            .collect()
    }

    #[derive(Deserialize)]
    struct Listed {
        name: String,
        reason: String,
    }

    #[test]
    fn the_list_parses_from_its_json_with_a_reason_for_every_entry() {
        let listed: Vec<Listed> = serde_json::from_str(include_str!("command_acl.json"))
            .expect("command_acl.json parses");
        assert_eq!(
            listed
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            *MAIN_ONLY_COMMANDS
        );
        for entry in &listed {
            assert!(!entry.name.trim().is_empty(), "an entry has no name");
            assert!(
                !entry.reason.trim().is_empty(),
                "{} has no reason",
                entry.name
            );
        }
        let mut names = MAIN_ONLY_COMMANDS.clone();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            MAIN_ONLY_COMMANDS.len(),
            "a name is listed twice"
        );
    }

    #[test]
    fn the_parser_counts_cfg_gated_entries() {
        let registered = registered();
        for gated in [
            "dashboard_control_links",
            "check_for_update",
            "export_pdf_from_html",
        ] {
            assert!(
                registered.iter().any(|name| name == gated),
                "{gated} is missing"
            );
        }
    }

    #[test]
    fn every_entry_is_registered() {
        let registered = registered();
        for name in MAIN_ONLY_COMMANDS.iter() {
            assert!(
                registered.iter().any(|entry| entry == name),
                "{name} is listed in command_acl.json but not registered in generate_handler!"
            );
        }
    }

    #[test]
    fn allowed_refuses_main_only_commands_outside_main() {
        for (label, command, expected) in [
            (crate::windows::MAIN_LABEL, "save_app_state", true),
            ("pane-x", "save_app_state", false),
            ("pane-x", "load_app_state", true),
            ("pane-x", "patch_app_state_keys", true),
            ("pane-x", "not_a_registered_command", true),
        ] {
            assert_eq!(allowed(label, command), expected, "{label} {command}");
        }
        for name in MAIN_ONLY_COMMANDS.iter() {
            assert!(allowed(crate::windows::MAIN_LABEL, name));
            assert!(!allowed("pane-x", name));
        }
    }
}

#[cfg(test)]
mod capabilities {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Capability {
        windows: Vec<String>,
        permissions: Vec<String>,
    }

    fn parse(text: &str) -> Capability {
        serde_json::from_str(text).expect("capability parses")
    }

    #[test]
    fn pane_grants_exactly_its_set() {
        let pane = parse(include_str!("../../capabilities/pane.json"));
        assert_eq!(pane.windows, vec!["pane-*".to_owned()]);
        let mut granted = pane.permissions.clone();
        granted.sort_unstable();
        let mut expected = vec![
            "core:event:default",
            "core:window:default",
            "core:webview:default",
            "core:app:default",
            "core:path:default",
            "core:window:allow-start-dragging",
            "core:window:allow-set-title",
            "core:window:allow-set-focus",
            "core:window:allow-unminimize",
            "core:window:allow-close",
            "log:default",
            "opener:allow-open-url",
            "dialog:allow-open",
            "dialog:allow-save",
        ];
        expected.sort_unstable();
        assert_eq!(granted, expected);
        let dialogs: Vec<_> = granted
            .iter()
            .filter(|p| p.starts_with("dialog:"))
            .collect();
        assert_eq!(dialogs, ["dialog:allow-open", "dialog:allow-save"]);
        for denied in [
            "process:",
            "notification:",
            "set-badge-count",
            "core:default",
        ] {
            assert!(
                !granted.iter().any(|p| p.contains(denied)),
                "pane.json grants {denied}"
            );
        }
    }

    #[test]
    fn default_lists_only_main() {
        let default = parse(include_str!("../../capabilities/default.json"));
        assert_eq!(default.windows, vec![crate::windows::MAIN_LABEL.to_owned()]);
    }
}

#[cfg(test)]
mod enforce {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    use super::*;

    static SAVES: AtomicUsize = AtomicUsize::new(0);
    static PATCHES: AtomicUsize = AtomicUsize::new(0);

    #[tauri::command]
    fn save_app_state() {
        SAVES.fetch_add(1, Ordering::SeqCst);
    }

    #[tauri::command]
    fn patch_app_state_keys() {
        PATCHES.fetch_add(1, Ordering::SeqCst);
    }

    fn request(cmd: &str) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    #[test]
    fn the_wrapper_refuses_a_main_only_command_outside_main_and_runs_nothing() {
        let app = mock_builder()
            .invoke_handler(crate::shared::invoke_stats::counted(
                tauri::generate_handler![save_app_state, patch_app_state_keys],
            ))
            .build(mock_context(noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, crate::windows::MAIN_LABEL, Default::default())
            .build()
            .unwrap();
        let pane = WebviewWindowBuilder::new(&app, "pane-x", Default::default())
            .build()
            .unwrap();

        let refused = get_ipc_response(&pane, request("save_app_state"));
        assert_eq!(
            refused.err(),
            Some(serde_json::Value::String(refusal("save_app_state")))
        );
        assert_eq!(SAVES.load(Ordering::SeqCst), 0);

        assert!(get_ipc_response(&main, request("save_app_state")).is_ok());
        assert_eq!(SAVES.load(Ordering::SeqCst), 1);

        assert!(get_ipc_response(&pane, request("patch_app_state_keys")).is_ok());
        assert_eq!(PATCHES.load(Ordering::SeqCst), 1);
    }
}

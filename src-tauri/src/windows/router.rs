// SPDX-License-Identifier: MIT
//! `context-file-change`: the one place it is sent.
//!
//! [`route_path_event`] names the windows a file change goes to: `main`, always (its listener
//! bumps scope-wide refresh keys, not only its open tabs), plus every ready satellite holding a
//! `tab` item the change covers. A change covers a tab when the changed path is the tab's path
//! or a directory or root containing it, compared by path components (no case or symlink
//! folding). A tab's path is its id up to the first `?`; that split is for matching only, so
//! `a.md?x=1` and `a.md` stay two items and a change to `a.md` reaches both. The team is not
//! compared: a same-path change in another team's repo costs that satellite one refresh, which
//! its viewer's own change check absorbs.
//!
//! [`emit_path_event`] sends one event to those windows and counts it once. A JS `listen`
//! registers for every target, so Tauri hands it every emit whatever the filter: a satellite's
//! listener checks the payload against its own items too (`src/shared/windows/path-listeners.ts`).
//! Rust listeners on the app (`app.listen`, `listen_any`) still hear every change.

use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

use super::item_key::ItemKey;
use super::label::MAIN_LABEL;
use super::registry::{Locked, WindowRegistry};

/// The event a file change is sent on.
pub const CONTEXT_FILE_CHANGE_EVENT: &str = "context-file-change";

const TAB_KIND: &str = "tab";

/// A tab key's path: its id up to the first `?`.
fn tab_path(id: &str) -> &str {
    id.split_once('?').map_or(id, |(path, _)| path)
}

/// Whether a change to `changed` covers `key`: a `tab` whose path is `changed` or lies under it.
fn covers(changed: &Path, key: &ItemKey) -> bool {
    key.kind == TAB_KIND && Path::new(tab_path(&key.id)).starts_with(changed)
}

/// The windows a change to `file_path` goes to: `main`, then the sorted labels of the ready
/// satellites holding a `tab` item it covers.
pub fn route_path_event(registry: &WindowRegistry, file_path: &str) -> Vec<String> {
    let mut labels = vec![MAIN_LABEL.to_owned()];
    if str::is_empty(file_path) {
        return labels;
    }
    let changed = Path::new(file_path);
    let locked = WindowRegistry::locked(registry);
    labels.extend(Locked::satellites_holding(&locked, |key| {
        covers(changed, key)
    }));
    labels
}

/// Sends `payload` on `context-file-change` to the windows [`route_path_event`] names for its
/// `file_path` (`main` only when it has none), and counts one emit. With no registry managed
/// (a test app) no satellite exists, so it is sent unfiltered.
pub fn emit_path_event<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    emit_counted(
        app,
        payload,
        crate::content_engine::sync::residual_metrics::note_context_file_change_emit,
    );
}

fn emit_counted<R: Runtime>(app: &AppHandle<R>, payload: Value, note_emit: impl FnOnce()) {
    note_emit();
    let Some(registry) = Manager::try_state::<WindowRegistry>(app) else {
        if let Err(e) = Emitter::emit(app, CONTEXT_FILE_CHANGE_EVENT, payload) {
            log::warn!(target: "windows", "{CONTEXT_FILE_CHANGE_EVENT} not sent: {e}");
        }
        return;
    };
    let labels = match payload.get("file_path").and_then(Value::as_str) {
        Some(file_path) => route_path_event(&registry, file_path),
        None => vec![MAIN_LABEL.to_owned()],
    };
    let sent = Emitter::emit_filter(app, CONTEXT_FILE_CHANGE_EVENT, payload, |target| {
        reaches(target, &labels)
    });
    if let Err(e) = sent {
        log::warn!(target: "windows", "{CONTEXT_FILE_CHANGE_EVENT} not sent: {e}");
    }
}

/// Whether a listener registered for `target` hears an event sent to `labels`.
fn reaches(target: &EventTarget, labels: &[String]) -> bool {
    match target {
        EventTarget::Any | EventTarget::App => true,
        EventTarget::AnyLabel { label }
        | EventTarget::Window { label }
        | EventTarget::Webview { label }
        | EventTarget::WebviewWindow { label } => Iterator::any(&mut labels.iter(), |l| l == label),
        _ => false,
    }
}

#[cfg(test)]
mod fanout {
    use super::*;
    use crate::windows::registry::test_host::Recorder;
    use std::cell::Cell;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    fn tab(id: &str) -> ItemKey {
        ItemKey {
            kind: "tab".into(),
            team: "acme:docs".into(),
            id: id.into(),
        }
    }

    /// `main` plus a ready satellite for each `(label, held ids)`.
    fn reg(windows: &[(&str, &[&str])]) -> WindowRegistry {
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        for (label, ids) in windows {
            reg.add_satellite(&host, label).unwrap();
            reg.ready(&host, label).unwrap();
            for id in *ids {
                reg.reassign_item(&host, &tab(id), label).unwrap();
            }
        }
        reg
    }

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn main_and_every_satellite_holding_an_item_of_the_change() {
        let reg = reg(&[
            ("sat-1", &["/repo/notes/a.md"]),
            ("sat-2", &["/repo/notes/a.md?x=1"]),
            ("sat-3", &["/repo/notes/b.md"]),
        ]);
        assert_eq!(
            route_path_event(&reg, "/repo/notes/a.md"),
            labels(&["main", "sat-1", "sat-2"])
        );
    }

    #[test]
    fn a_held_query_tab_hears_a_change_to_its_path() {
        let reg = reg(&[("sat-1", &["/repo/notes/a.md?x=1"])]);
        assert_eq!(
            route_path_event(&reg, "/repo/notes/a.md"),
            labels(&["main", "sat-1"])
        );
    }

    #[test]
    fn a_containing_directory_or_root_reaches_the_holder_and_a_sibling_does_not() {
        let reg = reg(&[("sat-1", &["/repo/notes/a.md"])]);
        for dir in ["/repo/notes", "/repo", "/repo/notes/"] {
            assert_eq!(
                route_path_event(&reg, dir),
                labels(&["main", "sat-1"]),
                "{dir}"
            );
        }
        for other in [
            "/repo/other",
            "/repo/note",
            "/repo/notes/a.m",
            "/repo/notes/a.md.bak",
        ] {
            assert_eq!(route_path_event(&reg, other), labels(&["main"]), "{other}");
        }
    }

    #[test]
    fn no_match_and_no_path_reach_main_only() {
        let reg = reg(&[("sat-1", &["/repo/notes/a.md"])]);
        assert_eq!(route_path_event(&reg, "/elsewhere/a.md"), labels(&["main"]));
        assert_eq!(route_path_event(&reg, ""), labels(&["main"]));
    }

    #[test]
    fn a_pending_satellite_hears_nothing() {
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-1").unwrap();
        reg.reassign_item(&host, &tab("/repo/notes/a.md"), "sat-1")
            .unwrap();
        assert_eq!(
            route_path_event(&reg, "/repo/notes/a.md"),
            labels(&["main"])
        );
    }

    #[test]
    fn main_alone_gets_every_change() {
        let reg = WindowRegistry::new();
        assert_eq!(
            route_path_event(&reg, "/repo/notes/a.md"),
            labels(&["main"])
        );
    }

    #[test]
    fn only_tab_items_match() {
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-1").unwrap();
        reg.ready(&host, "sat-1").unwrap();
        let workspace = ItemKey {
            kind: "workspace".into(),
            team: "acme:docs".into(),
            id: "/repo/notes/a.md".into(),
        };
        reg.reassign_item(&host, &workspace, "sat-1").unwrap();
        assert_eq!(
            route_path_event(&reg, "/repo/notes/a.md"),
            labels(&["main"])
        );
    }

    type Heard = Arc<Mutex<Vec<String>>>;

    /// A mock app with a webview per label, each recording what it hears under its label, and
    /// app-level Rust listeners recorded as `app` and `any`.
    fn app_hearing(windows: &[&str]) -> (tauri::App<tauri::test::MockRuntime>, Heard) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let heard: Heard = Arc::default();
        for label in windows {
            let window =
                tauri::WebviewWindowBuilder::new(&app, *label, tauri::WebviewUrl::default())
                    .build()
                    .unwrap();
            let heard = heard.clone();
            let me = (*label).to_owned();
            window.listen(CONTEXT_FILE_CHANGE_EVENT, move |_| {
                heard.lock().unwrap().push(me.clone());
            });
        }
        let on_app = heard.clone();
        app.listen(CONTEXT_FILE_CHANGE_EVENT, move |_| {
            on_app.lock().unwrap().push("app".into());
        });
        let on_any = heard.clone();
        app.listen_any(CONTEXT_FILE_CHANGE_EVENT, move |_| {
            on_any.lock().unwrap().push("any".into());
        });
        (app, heard)
    }

    fn sorted(heard: &Heard) -> Vec<String> {
        let mut v = heard.lock().unwrap().clone();
        v.sort();
        v
    }

    #[test]
    fn two_matching_satellites_are_one_emit_and_one_count() {
        let (app, heard) = app_hearing(&["main", "sat-1", "sat-2", "sat-3"]);
        app.manage(reg(&[
            ("sat-1", &["/repo/notes/a.md"]),
            ("sat-2", &["/repo/notes/a.md?x=1"]),
            ("sat-3", &["/repo/notes/b.md"]),
        ]));
        let count = Cell::new(0);
        emit_counted(
            app.handle(),
            serde_json::json!({"repo_path": "/repo", "file_path": "/repo/notes/a.md"}),
            || count.set(count.get() + 1),
        );
        assert_eq!(count.get(), 1);
        assert_eq!(
            sorted(&heard),
            labels(&["any", "app", "main", "sat-1", "sat-2"])
        );
    }

    #[test]
    fn a_payload_with_no_file_path_reaches_main_only() {
        let (app, heard) = app_hearing(&["main", "sat-1"]);
        app.manage(reg(&[("sat-1", &["/repo/notes/a.md"])]));
        let count = Cell::new(0);
        emit_counted(
            app.handle(),
            serde_json::json!({"repo_path": "/repo"}),
            || count.set(count.get() + 1),
        );
        assert_eq!(count.get(), 1);
        assert_eq!(sorted(&heard), labels(&["any", "app", "main"]));
    }

    #[test]
    fn with_no_registry_managed_one_unfiltered_emit_reaches_main() {
        let (app, heard) = app_hearing(&["main"]);
        let count = Cell::new(0);
        emit_counted(
            app.handle(),
            serde_json::json!({"repo_path": "/repo", "file_path": "/repo/notes/a.md"}),
            || count.set(count.get() + 1),
        );
        assert_eq!(count.get(), 1);
        assert_eq!(sorted(&heard), labels(&["any", "app", "main"]));
    }

    #[test]
    fn with_no_registry_and_no_window_it_does_not_panic() {
        let (app, heard) = app_hearing(&[]);
        emit_path_event(
            app.handle(),
            serde_json::json!({"repo_path": "/repo", "file_path": "/repo/notes/a.md"}),
        );
        assert_eq!(sorted(&heard), labels(&["any", "app"]));
    }
}

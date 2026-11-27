// SPDX-License-Identifier: MIT
//! Window labels. `main` is the app's first window: it owns the app state, the MCP replies and
//! the human-window gates. Code outside this module names it only through [`MAIN_LABEL`],
//! [`main_window`] and [`is_main`] (`codesense-guards` `windows_main_label_guard`), so a second
//! window can never match a stray `"main"`.

use serde::Serialize;
use tauri::{Emitter, EventTarget, Manager, Runtime, WebviewWindow};

/// The label of the app's first window.
pub const MAIN_LABEL: &str = "main";

/// The `main` webview window, if it is open.
pub fn main_window<R: Runtime, M: Manager<R>>(manager: &M) -> Option<WebviewWindow<R>> {
    manager.get_webview_window(MAIN_LABEL)
}

/// Whether `label` is the `main` window's.
pub fn is_main(label: &str) -> bool {
    label == MAIN_LABEL
}

/// Send a request that one window answers to that window alone. With one window the owner is
/// always `main`; a window registry resolves it later.
///
/// Rust listeners and JS listeners bound to another window's target do not hear it. A JS
/// listener registered for any target still does, in every webview, which is why the frontend
/// registers those listeners `main-only` (`src/shared/windows/listener-inventory.ts`).
pub fn emit_to_owner<R: Runtime, E: Emitter<R>, S: Serialize + Clone>(
    emitter: &E,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    emitter.emit_to(EventTarget::labeled(MAIN_LABEL), event, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    type Heard = Arc<Mutex<Vec<String>>>;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    fn window(
        app: &tauri::App<tauri::test::MockRuntime>,
        label: &str,
    ) -> WebviewWindow<tauri::test::MockRuntime> {
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
            .build()
            .unwrap()
    }

    fn hear<L: Listener<tauri::test::MockRuntime>>(
        listener: &L,
        who: &'static str,
        event: &'static str,
        heard: &Heard,
    ) {
        let heard = heard.clone();
        listener.listen(event, move |_| {
            heard.lock().unwrap().push(format!("{who} {event}"));
        });
    }

    #[test]
    fn emit_to_owner_reaches_only_main_with_a_satellite_open() {
        let app = app();
        let main = window(&app, MAIN_LABEL);
        let pane = window(&app, "pane-x");
        let heard = Heard::default();
        for event in ["canvas:render-request", "document:read-rendered-request"] {
            hear(&main, "main", event, &heard);
            hear(&pane, "pane-x", event, &heard);
            hear(&app, "app", event, &heard);
        }

        emit_to_owner(
            app.handle(),
            "canvas:render-request",
            serde_json::json!({"requestId": "r1"}),
        )
        .unwrap();
        emit_to_owner(
            app.handle(),
            "document:read-rendered-request",
            serde_json::json!({"requestId": "r2"}),
        )
        .unwrap();

        assert_eq!(
            *heard.lock().unwrap(),
            vec![
                "main canvas:render-request".to_owned(),
                "main document:read-rendered-request".to_owned(),
            ]
        );
    }

    #[test]
    fn emit_to_owner_reaches_no_satellite_when_main_is_closed() {
        let app = app();
        let pane = window(&app, "pane-x");
        let heard = Heard::default();
        hear(&pane, "pane-x", "canvas:render-request", &heard);

        emit_to_owner(app.handle(), "canvas:render-request", serde_json::json!({})).unwrap();

        assert!(heard.lock().unwrap().is_empty());
    }

    #[test]
    fn main_window_and_is_main_name_main_alone() {
        let app = app();
        assert!(main_window(&app).is_none());
        window(&app, "pane-x");
        assert!(main_window(&app).is_none());
        window(&app, MAIN_LABEL);
        assert_eq!(main_window(&app).unwrap().label(), MAIN_LABEL);
        assert!(is_main(MAIN_LABEL));
        assert!(!is_main("pane-x"));
        assert!(!is_main(""));
    }
}

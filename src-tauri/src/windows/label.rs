// SPDX-License-Identifier: MIT
//! Window labels. `main` is the app's first window: it owns the app state, the MCP replies and
//! the human-window gates. Code outside this module names it only through [`MAIN_LABEL`],
//! [`main_window`] and [`is_main`] (`codesense-guards` `windows_main_label_guard`), so a second
//! window can never match a stray `"main"`.

use tauri::{Manager, Runtime, WebviewWindow};

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

#[cfg(test)]
mod tests {
    use super::*;

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

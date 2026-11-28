// SPDX-License-Identifier: MIT
//! A command acts as the window it was called from: `main` as `app`, any other window as
//! `app:<installId>:<label>`, and no window but `main` without an install id.

use super::*;

fn app_with(install: Option<InstallId>) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    if let Some(install) = install {
        app.manage(install);
    }
    app
}

fn window(
    app: &tauri::App<tauri::test::MockRuntime>,
    label: &str,
) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .build()
        .unwrap()
}

#[test]
fn each_window_is_its_own_viewer() {
    let app = app_with(Some(InstallId::new("i1")));
    let main = window(&app, "main");
    let pane = window(&app, "pane-x");

    assert_eq!(window_viewer(&main).unwrap(), main_viewer());
    assert_eq!(
        window_viewport(&main).unwrap(),
        viewport_for(&main_viewer())
    );
    assert_eq!(window_viewer(&pane).unwrap().as_str(), "app:i1:pane-x");
    assert_ne!(
        window_viewport(&pane).unwrap(),
        window_viewport(&main).unwrap()
    );
}

#[test]
fn without_an_install_id_only_main_has_a_viewer() {
    let app = app_with(None);
    let main = window(&app, "main");
    let pane = window(&app, "pane-x");

    assert_eq!(install_id(app.handle()), InstallId::unreadable());
    assert_eq!(window_viewer(&main).unwrap(), main_viewer());
    assert_eq!(window_viewer(&pane), Err(INSTALL_ID_UNREADABLE.to_string()));
    assert_eq!(
        window_viewport(&pane),
        Err(INSTALL_ID_UNREADABLE.to_string())
    );
}

struct Restored(Vec<String>);

impl RestoredLabels for Restored {
    fn labels(&self) -> Vec<String> {
        self.0.clone()
    }
}

#[test]
fn a_sweep_keeps_the_open_and_the_restored_windows() {
    let app = app_with(Some(InstallId::new("i1")));
    let _main = window(&app, "main");
    let _pane = window(&app, "pane-x");

    let mut kept = kept_labels(app.handle(), &Restored(vec!["pane-y".into()]));
    kept.sort();
    assert_eq!(kept, ["main", "pane-x", "pane-y"]);
    assert_eq!(
        kept_labels(app.handle(), &NoRestoredLabels).len(),
        2,
        "this run's open windows"
    );
}

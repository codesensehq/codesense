// SPDX-License-Identifier: MIT
//! The viewer, viewport and boot slot of each window.

use super::*;
use crate::windows::MAIN_LABEL;

fn install() -> InstallId {
    InstallId::new("i1")
}

#[test]
fn main_ids_identical() {
    let viewer = viewer_for(MAIN_LABEL, &install()).unwrap();
    assert_eq!(viewer.as_str(), "app");
    assert_eq!(viewer, main_viewer());
    assert_eq!(viewport_for(&viewer).as_str(), "webview");
    assert!(is_main_viewer(&viewer));
    // `main` needs no install id.
    assert_eq!(
        viewer_for(MAIN_LABEL, &InstallId::unreadable()).unwrap(),
        main_viewer()
    );
}

#[test]
fn another_window_has_its_own_viewer_and_viewport() {
    let viewer = viewer_for("pane-x", &install()).unwrap();
    assert_eq!(viewer.as_str(), "app:i1:pane-x");
    assert!(!is_main_viewer(&viewer));
    let viewport = viewport_for(&viewer);
    assert_ne!(viewport, viewport_for(&main_viewer()));
    assert_ne!(
        viewport,
        viewport_for(&viewer_for("pane-y", &install()).unwrap())
    );
    // Another install's window of the same label is another viewer.
    assert_ne!(viewer, viewer_for("pane-x", &InstallId::new("i2")).unwrap());
    assert_eq!(install().satellite_prefix().as_deref(), Some("app:i1:"));
    assert!(viewer
        .as_str()
        .starts_with(&install().satellite_prefix().unwrap()));
}

#[test]
fn an_unreadable_install_id_refuses_every_other_window() {
    for install in [
        InstallId::unreadable(),
        InstallId::new(""),
        InstallId::new("a:b"),
    ] {
        assert_eq!(
            viewer_for("pane-x", &install),
            Err(INSTALL_ID_UNREADABLE.to_string())
        );
        assert_eq!(install.satellite_prefix(), None);
    }
}

#[test]
fn one_boot_slot_per_viewer() {
    let boots = Boots::default();
    let main = main_viewer();
    let pane = viewer_for("pane-x", &install()).unwrap();
    let first = ClientBootId::new("first");
    assert!(boots.adopt(&main, &first), "main's first ask");
    assert!(!boots.adopt(&main, &first), "same boot polling");
    assert!(
        boots.adopt(&pane, &ClientBootId::new("pane")),
        "its own first ask"
    );
    // A reload of the other window never resets main's boot.
    assert!(boots.adopt(&pane, &ClientBootId::new("pane-reload")));
    assert_eq!(boots.of(&main), Some(first.clone()));
    assert_eq!(boots.of(&pane), Some(ClientBootId::new("pane-reload")));
    // A reload of main is a new boot for main alone.
    let reload = ClientBootId::new("reload");
    assert!(boots.adopt(&main, &reload), "webview reload");
    assert!(!boots.adopt(&main, &reload));
    assert_eq!(boots.of(&pane), Some(ClientBootId::new("pane-reload")));
    // A closed window's slot goes; main's stays.
    boots.forget(&pane);
    assert_eq!(boots.of(&pane), None);
    assert_eq!(boots.of(&main), Some(reload));
}

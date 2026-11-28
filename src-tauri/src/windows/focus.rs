// SPDX-License-Identifier: MIT
//! Which window has focus, and where a native menu click goes.
//!
//! - [`FocusTracker`] is the app's [`FocusSource`]: `lib.rs`'s window-event hook records each
//!   `WindowEvent::Focused` and clears a window on `WindowEvent::Destroyed`. It records pending
//!   windows too; skipping them is [`resolve_target`]'s job, so a satellite focused while it
//!   boots becomes the target once it is ready, with no new focus event.
//! - [`emit_menu_action`] sends `menu:action` with `emit_to` to the one window
//!   [`menu_target`] picks, never as a broadcast (`codesense-guards`
//!   `windows_no_broadcast_guard` scans this file and `menu.rs`). The frontend hears it on that
//!   window's own webview handle (`src/shared/windows/menu-listener.ts`), so one click runs
//!   once.
//!
//! Nothing here is macOS-only: `menu::on_event` is, and it calls [`emit_menu_action`]. Off
//! macOS the menu helpers have no caller outside the tests, so each carries an
//! `allow(dead_code)` with that reason rather than an OS `cfg` (the platform-cfg ratchet).

use std::sync::Mutex;

use tauri::{Emitter, Runtime};

use super::label::MAIN_LABEL;
use super::registry::WindowRegistry;
use super::target::{resolve_target, FocusSource, TargetAction};

/// The event a native menu click is sent on, to one window.
#[allow(
    dead_code,
    reason = "the caller, menu::on_event, is macOS-only; the routing tests use it on every platform"
)]
pub const MENU_ACTION_EVENT: &str = "menu:action";

#[derive(Debug, Default)]
struct Slots {
    focused: Option<String>,
    last_focused: Option<String>,
}

/// The focused window and the one focused before it, by label. Tauri managed state.
#[derive(Debug, Default)]
pub struct FocusTracker {
    slots: Mutex<Slots>,
}

impl FocusTracker {
    fn slots(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.slots.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `label` gained (`true`) or lost (`false`) focus. A window that takes focus from another
    /// makes that one the last-focused; a window that loses focus with none taking it becomes
    /// the last-focused, so a click with the app in the background still has a window.
    pub fn record_window_focus(&self, label: &str, focused: bool) {
        let mut slots = FocusTracker::slots(self);
        if focused {
            if slots.focused.as_deref() == Some(label) {
                return;
            }
            if let Some(previous) = slots.focused.take() {
                slots.last_focused = Some(previous);
            }
            slots.focused = Some(label.to_owned());
        } else if slots.focused.as_deref() == Some(label) {
            slots.focused = None;
            slots.last_focused = Some(label.to_owned());
        }
    }

    /// `label` was destroyed: it leaves both slots.
    pub fn clear_window_focus(&self, label: &str) {
        let mut slots = FocusTracker::slots(self);
        if slots.focused.as_deref() == Some(label) {
            slots.focused = None;
        }
        if slots.last_focused.as_deref() == Some(label) {
            slots.last_focused = None;
        }
    }
}

impl FocusSource for FocusTracker {
    fn focused_window(&self) -> Option<String> {
        FocusTracker::slots(self).focused.clone()
    }

    fn last_focused_window(&self) -> Option<String> {
        FocusTracker::slots(self).last_focused.clone()
    }
}

/// The one window a menu click goes to: [`resolve_target`]'s `Focused` choice (the focused
/// window if ready, else the last-focused if ready, else `main`), and `main` should it refuse.
#[allow(
    dead_code,
    reason = "the caller, menu::on_event, is macOS-only; the routing tests use it on every platform"
)]
pub fn menu_target(focus: &dyn FocusSource, registry: &WindowRegistry) -> String {
    target_or_main(resolve_target(registry, TargetAction::Focused, None, focus))
}

#[allow(
    dead_code,
    reason = "the caller, menu::on_event, is macOS-only; the routing tests use it on every platform"
)]
fn target_or_main(resolved: Result<String, String>) -> String {
    resolved.unwrap_or_else(|e| {
        log::warn!(target: "menu", "menu target: {e}; using main");
        MAIN_LABEL.to_owned()
    })
}

/// Sends the menu item `id` to the window [`menu_target`] picks, and to it alone.
#[allow(
    dead_code,
    reason = "the caller, menu::on_event, is macOS-only; the routing tests use it on every platform"
)]
pub fn emit_menu_action<R: Runtime, E: Emitter<R>>(
    emitter: &E,
    focus: &dyn FocusSource,
    registry: &WindowRegistry,
    id: String,
) {
    let label = menu_target(focus, registry);
    if let Err(e) = Emitter::emit_to(emitter, &*label, MENU_ACTION_EVENT, id) {
        log::warn!(target: "menu", "failed to send {MENU_ACTION_EVENT} to {label}: {e}");
    }
}

#[cfg(test)]
mod menu_routing {
    use super::*;
    use crate::windows::registry::test_host::Recorder;

    /// `main` and ready satellites `sat-1` and `sat-2`.
    fn reg(host: &Recorder) -> WindowRegistry {
        let reg = WindowRegistry::new();
        for label in ["sat-1", "sat-2"] {
            reg.add_satellite(host, label).unwrap();
            reg.ready(host, label).unwrap();
        }
        reg
    }

    fn target(tracker: &FocusTracker, reg: &WindowRegistry) -> String {
        menu_target(tracker, reg)
    }

    #[test]
    fn a_focused_satellite_is_the_target() {
        let host = Recorder::default();
        let reg = reg(&host);
        let tracker = FocusTracker::default();
        tracker.record_window_focus("main", true);
        tracker.record_window_focus("sat-1", true);
        assert_eq!(target(&tracker, &reg), "sat-1");
    }

    #[test]
    fn a_focused_main_is_the_target() {
        let host = Recorder::default();
        let reg = reg(&host);
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        tracker.record_window_focus("main", true);
        assert_eq!(target(&tracker, &reg), "main");
    }

    #[test]
    fn nothing_focused_and_nothing_focused_before_is_main() {
        let host = Recorder::default();
        assert_eq!(target(&FocusTracker::default(), &reg(&host)), "main");
    }

    #[test]
    fn a_blurred_window_with_none_taking_focus_stays_the_target() {
        let host = Recorder::default();
        let reg = reg(&host);
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        tracker.record_window_focus("sat-1", false);
        assert_eq!(tracker.focused_window(), None);
        assert_eq!(target(&tracker, &reg), "sat-1");
    }

    #[test]
    fn a_destroyed_last_focused_window_falls_back_to_main() {
        let host = Recorder::default();
        let reg = reg(&host);
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        tracker.record_window_focus("sat-1", false);
        tracker.clear_window_focus("sat-1");
        assert_eq!(tracker.last_focused_window(), None);
        assert_eq!(target(&tracker, &reg), "main");
    }

    #[test]
    fn a_destroyed_focused_window_leaves_both_slots() {
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        tracker.record_window_focus("sat-2", true);
        tracker.clear_window_focus("sat-2");
        tracker.clear_window_focus("sat-1");
        assert_eq!(tracker.focused_window(), None);
        assert_eq!(tracker.last_focused_window(), None);
    }

    #[test]
    fn a_pending_focused_satellite_falls_to_a_ready_last_focused_one() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.add_satellite(&host, "sat-3").unwrap();
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        tracker.record_window_focus("sat-3", true);
        assert_eq!(tracker.focused_window().as_deref(), Some("sat-3"));
        assert_eq!(target(&tracker, &reg), "sat-1");
    }

    #[test]
    fn a_pending_focused_satellite_with_no_last_focused_is_main() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.add_satellite(&host, "sat-3").unwrap();
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-3", true);
        assert_eq!(target(&tracker, &reg), "main");
    }

    #[test]
    fn a_pending_satellite_becomes_the_target_once_ready_with_no_new_focus_event() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.add_satellite(&host, "sat-3").unwrap();
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-3", true);
        assert_eq!(target(&tracker, &reg), "main");
        reg.ready(&host, "sat-3").unwrap();
        assert_eq!(target(&tracker, &reg), "sat-3");
    }

    #[test]
    fn a_refused_resolve_is_main() {
        assert_eq!(target_or_main(Err("unknown window".into())), "main");
        assert_eq!(target_or_main(Ok("sat-1".into())), "sat-1");
    }

    #[test]
    fn every_focus_history_has_exactly_one_target_and_it_is_a_ready_window() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.add_satellite(&host, "sat-3").unwrap();
        let labels = ["main", "sat-1", "sat-2", "sat-3", "pane-zzz"];
        for first in labels {
            for second in labels {
                for blur_second in [false, true] {
                    let tracker = FocusTracker::default();
                    tracker.record_window_focus(first, true);
                    tracker.record_window_focus(second, true);
                    if blur_second {
                        tracker.record_window_focus(second, false);
                    }
                    let got = target(&tracker, &reg);
                    let locked = WindowRegistry::locked(&reg);
                    assert!(
                        crate::windows::registry::Locked::has_window(&locked, &got)
                            && !crate::windows::registry::Locked::is_pending(&locked, &got),
                        "{first} then {second}: {got}"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod menu_delivery {
    use super::*;
    use crate::windows::registry::test_host::Recorder;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    type Heard = Arc<Mutex<Vec<String>>>;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    /// Opens `label` with a webview-handle `menu:action` listener, as the frontend registers
    /// it (`currentWebviewWindow().listen`).
    fn window(app: &tauri::App<tauri::test::MockRuntime>, label: &'static str, heard: &Heard) {
        let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let heard = heard.clone();
        window.listen(MENU_ACTION_EVENT, move |event| {
            heard
                .lock()
                .unwrap()
                .push(format!("{label} {}", event.payload()));
        });
    }

    fn setup() -> (tauri::App<tauri::test::MockRuntime>, WindowRegistry, Heard) {
        let app = app();
        let heard = Heard::default();
        window(&app, MAIN_LABEL, &heard);
        window(&app, "sat-1", &heard);
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-1").unwrap();
        reg.ready(&host, "sat-1").unwrap();
        (app, reg, heard)
    }

    #[test]
    fn a_click_with_the_satellite_focused_reaches_the_satellite_alone() {
        let (app, reg, heard) = setup();
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        emit_menu_action(
            app.handle(),
            &tracker,
            &reg,
            "viewer.toggle-terminal".into(),
        );
        assert_eq!(
            *heard.lock().unwrap(),
            vec!["sat-1 \"viewer.toggle-terminal\"".to_owned()]
        );
    }

    #[test]
    fn a_click_with_main_focused_reaches_main_alone() {
        let (app, reg, heard) = setup();
        let tracker = FocusTracker::default();
        tracker.record_window_focus("sat-1", true);
        tracker.record_window_focus("main", true);
        emit_menu_action(
            app.handle(),
            &tracker,
            &reg,
            "viewer.toggle-terminal".into(),
        );
        assert_eq!(
            *heard.lock().unwrap(),
            vec!["main \"viewer.toggle-terminal\"".to_owned()]
        );
    }
}

// SPDX-License-Identifier: MIT
//! SW-AU-34: background-on-close policy, so running agents keep working.
//!
//! Closing the window keeps the process — and thus the MCP host, the sync engine,
//! and `ActiveTeamState` — alive instead of quitting, the standard macOS
//! dock-resident behavior. "Open" comes to mean *process-alive*, not
//! *window-visible*, which is the contract a leave-it-running agent
//! needs. The window-close handler in `lib.rs` reads a single process-global flag
//! (the user's quit-on-close preference) to decide hide-vs-quit. On Linux, which
//! has no Dock, the window backgrounds only while the terminal-server tray item
//! shows (its own atomic, [`crate::commands::terminal_server_tray::tray_visible`]),
//! since that item is the only way back; otherwise close quits.
//!
//! The flag is mirrored from the frontend `settings.quitOnClose` via
//! [`set_quit_on_close`] — one value, one atomic, no `AppHandle`/`State`. That is what keeps the read on
//! the window-event (main/UI) thread a lock-free `Relaxed` load with no disk I/O
//! and no IPC round-trip, so window close never blocks a frame (the "no beachball"
//! contract). Cmd-Q / menu-Quit fire `RunEvent::ExitRequested`, NOT
//! `WindowEvent::CloseRequested`, so hiding on close can never swallow a real quit
//! and no "quitting" guard flag is needed.

use std::sync::atomic::{AtomicBool, Ordering};

/// Event emitted to the frontend the moment a close is handled as background — the
/// FE renders a one-time explainer toast (gated on a persisted "seen" flag) so the
/// user learns the app is still running. An emitted event, never a native dialog,
/// so the close handler stays non-blocking.
pub const BACKGROUND_MODE_ENTERED_EVENT: &str = "background-mode-entered";

/// The FE→Rust mirror of `settings.quitOnClose`. `false` (default) =
/// background-on-close (hide, keep the host alive); `true` = quit-on-close (a
/// window close exits the process). Defaults to `false` so a fresh profile behaves
/// as a normal dock-resident app until the FE pushes the setting — and, crucially,
/// so the close handler never has to touch disk to learn the preference. `AtomicBool`
/// has a const constructor, so this is a plain `static` with no lazy init (mirrors
/// the `reverse_cadence()` signals the same window handler already writes).
fn quit_on_close_cell() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}

/// Whether the user opted into quit-on-close. Relaxed load — a plain on/off gate
/// with nothing else ordered against it. Called on the window-event (main) thread
/// from the `CloseRequested` handler, so it must stay a bare atomic read.
pub fn quit_on_close() -> bool {
    quit_on_close_cell().load(Ordering::Relaxed)
}

/// FE→Rust push of the `quitOnClose` setting — one value, one atomic, no
/// `AppHandle`/`State`. Logs at `info` only on an actual change (via
/// `swap`) so a re-push on every settings save is not per-call spam.
#[tauri::command]
pub fn set_quit_on_close(quit_on_close: bool) {
    let prev = quit_on_close_cell().swap(quit_on_close, Ordering::Relaxed);
    if prev != quit_on_close {
        log::info!(
            target: "commands::background_mode",
            "quit-on-close set to {quit_on_close} by setting"
        );
    }
}

/// What the window-close handler should do. Factored out as a pure function so the
/// decision is unit-testable without a live Tauri window, and so the closure in
/// `lib.rs` stays a thin read-atomic-then-dispatch (the load-bearing shape for the
/// no-UI-thread-block contract).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum CloseAction {
    /// Hide the app; keep the process (MCP host + engine + state) alive.
    Background,
    /// Quit the process — the user opted into quit-on-close, or nothing could
    /// bring a hidden window back.
    Quit,
}

/// How a person brings a backgrounded window back on this OS.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Restore {
    /// The Dock icon (macOS), which is always there.
    Dock,
    /// The terminal-server tray item's Open CodeSense, there only while the item
    /// shows in a tray host.
    Tray,
}

impl Restore {
    /// The restore path of `os` (a `std::env::consts::OS` value).
    pub fn for_os(os: &str) -> Self {
        if os == "macos" {
            Self::Dock
        } else {
            Self::Tray
        }
    }

    /// The restore path of the running OS.
    pub fn current() -> Self {
        Self::for_os(std::env::consts::OS)
    }
}

/// Resolve the close action. `quit_on_close = true` ⇒ [`CloseAction::Quit`].
/// Otherwise the window backgrounds when it can be brought back: always with the
/// Dock, and with the tray only while its item shows (`tray_visible`). A tray OS
/// with no visible item quits, so a closed window is never stranded.
pub fn close_action(quit_on_close: bool, tray_visible: bool, restore: Restore) -> CloseAction {
    match (quit_on_close, restore) {
        (true, _) => CloseAction::Quit,
        (false, Restore::Dock) => CloseAction::Background,
        (false, Restore::Tray) if tray_visible => CloseAction::Background,
        (false, Restore::Tray) => CloseAction::Quit,
    }
}

/// Whether a hidden main window must be shown again now that the tray item is
/// (`tray_visible`) or isn't: on a tray OS a hidden window with no item has no
/// way back. The Dock always brings one back, so macOS never shows a window it
/// hid.
pub fn show_hidden_window(tray_visible: bool, window_hidden: bool, restore: Restore) -> bool {
    restore == Restore::Tray && window_hidden && !tray_visible
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_background_on_close() {
        // A fresh flag reads false → Background, so a fresh profile is dock-resident
        // (never a surprise quit) until the FE pushes an explicit quit-on-close.
        assert_eq!(
            close_action(false, false, Restore::Dock),
            CloseAction::Background
        );
    }

    #[test]
    fn quit_on_close_pref_maps_to_quit() {
        assert_eq!(close_action(true, true, Restore::Dock), CloseAction::Quit);
    }

    /// Every combination: the Dock always backgrounds unless quit-on-close; the
    /// tray backgrounds only while its item shows, and otherwise quits.
    #[test]
    fn close_action_covers_every_combination() {
        use CloseAction::{Background, Quit};
        for (quit, visible, restore, want) in [
            (false, false, Restore::Dock, Background),
            (false, true, Restore::Dock, Background),
            (true, false, Restore::Dock, Quit),
            (true, true, Restore::Dock, Quit),
            (false, false, Restore::Tray, Quit),
            (false, true, Restore::Tray, Background),
            (true, false, Restore::Tray, Quit),
            (true, true, Restore::Tray, Quit),
        ] {
            assert_eq!(
                close_action(quit, visible, restore),
                want,
                "quit_on_close={quit} tray_visible={visible} {restore:?}"
            );
        }
    }

    #[test]
    fn restore_follows_the_os() {
        assert_eq!(Restore::for_os("macos"), Restore::Dock);
        for os in ["linux", "windows", "freebsd"] {
            assert_eq!(Restore::for_os(os), Restore::Tray, "{os}");
        }
        assert_eq!(Restore::current(), Restore::for_os(std::env::consts::OS));
    }

    /// Only a tray OS shows a hidden window, and only once the item is gone.
    #[test]
    fn a_hidden_window_is_shown_when_the_tray_goes() {
        for (visible, hidden, restore, want) in [
            (false, true, Restore::Tray, true),
            (true, true, Restore::Tray, false),
            (false, false, Restore::Tray, false),
            (true, false, Restore::Tray, false),
            (false, true, Restore::Dock, false),
            (true, true, Restore::Dock, false),
            (false, false, Restore::Dock, false),
            (true, false, Restore::Dock, false),
        ] {
            assert_eq!(
                show_hidden_window(visible, hidden, restore),
                want,
                "tray_visible={visible} window_hidden={hidden} {restore:?}"
            );
        }
    }

    /// AC-7 guard: the window-close handler must never block the macOS UI thread —
    /// it is a lock-free atomic read plus native calls only. This scans the
    /// `CloseRequested` arm in `lib.rs` and fails if it ever grows a disk read, an
    /// IPC/command invoke, or a blocking dialog — the concrete ways a close could
    /// stall the event loop (a beachball). The `close_action` decision stays pure so
    /// the arm has no reason to reach for any of these.
    #[test]
    fn close_handler_arm_stays_non_blocking() {
        let lib_rs = include_str!("../lib.rs");
        let start = lib_rs
            .find("WindowEvent::CloseRequested")
            .expect("close-to-background arm present in lib.rs");
        // Bound the scan to the arm body: from the marker up to the `.plugin(` that
        // follows the closed `on_window_event` closure.
        let rest = &lib_rs[start..];
        let end = rest.find(".plugin(").unwrap_or(rest.len().min(1600));
        let arm = &rest[..end];
        for forbidden in [
            "std::fs",
            ".invoke",
            "tauri_plugin_dialog",
            "MessageDialog",
            "block_on",
            // The tray item's visibility is an atomic; the arm never locks the tray
            // or asks the session bus.
            "tray_by_id",
            "status_notifier_host_registered",
            "dbus",
        ] {
            assert!(
                !arm.contains(forbidden),
                "close handler must not block the UI thread; found `{forbidden}` in the CloseRequested arm"
            );
        }
    }

    #[test]
    fn set_quit_on_close_round_trips_through_the_atomic() {
        // Process-global, so set explicitly both ways to stay order-independent.
        set_quit_on_close(true);
        assert!(quit_on_close());
        assert_eq!(
            close_action(quit_on_close(), false, Restore::Dock),
            CloseAction::Quit
        );

        set_quit_on_close(false);
        assert!(!quit_on_close());
        assert_eq!(
            close_action(quit_on_close(), false, Restore::Dock),
            CloseAction::Background
        );
    }
}

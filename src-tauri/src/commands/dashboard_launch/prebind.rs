// SPDX-License-Identifier: MIT
//! The reservation a fresh managed launch holds until its session is bound. The launch
//! awaits between reserving a slot and committing its claim, and an MCP caller that goes
//! away drops the launch future at any of those awaits. Dropped before the commit, the
//! guard kills the tab the launch opened, if any, and aborts the reservation, so a
//! cancelled open leaves neither a dead registry row nor an orphaned tab.

use super::DashboardLaunchState;

/// What a dropped reservation does, so tests can run it without the app's terminal hosts.
pub(crate) trait PreBindPort {
    /// Kill the session the launch opened a tab for. Called from `Drop`, so it must not
    /// block, and it is idempotent: a session already gone, or never opened, is a no-op.
    fn kill(&self, session_id: &str);
    /// Drop the reservation and announce it.
    fn abort(&self, handle: &str);
}

/// The app's port: the kill choke off the async workers, then the notifying abort.
pub(crate) struct AppPreBindPort(pub tauri::AppHandle);

impl PreBindPort for AppPreBindPort {
    fn kill(&self, session_id: &str) {
        let (app, session_id) = (self.0.clone(), session_id.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            super::super::pty::kill_session(&app, &session_id);
        });
    }

    fn abort(&self, handle: &str) {
        use tauri::Manager;
        if let Some(state) = self.0.try_state::<DashboardLaunchState>() {
            super::abort_and_notify(&self.0, &state, handle);
        }
    }
}

/// Armed for a fresh launch from its reservation until [`commit`](Self::commit); a launch
/// that found its handle already running holds an unarmed one, which does nothing.
pub(crate) struct PreBindReservation<P: PreBindPort> {
    port: P,
    handle: String,
    armed: bool,
    opened: Option<String>,
}

impl<P: PreBindPort> PreBindReservation<P> {
    pub(crate) fn new(port: P, handle: &str, fresh: bool) -> Self {
        Self {
            port,
            handle: handle.to_string(),
            armed: fresh,
            opened: None,
        }
    }

    /// The launch is about to open a tab for `session_id`: a drop from here on kills it.
    pub(crate) fn opened(&mut self, session_id: &str) {
        self.opened = Some(session_id.to_string());
    }

    /// The session is bound: the registry owns it now, and the guard lets go.
    pub(crate) fn commit(&mut self) {
        self.armed = false;
    }
}

impl<P: PreBindPort> Drop for PreBindReservation<P> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(session_id) = self.opened.take() {
            self.port.kill(&session_id);
        }
        self.port.abort(&self.handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::Listener;

    /// Records each kill, and aborts through the real notifying abort on a mock app.
    struct RecordingPort {
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        state: Arc<DashboardLaunchState>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl PreBindPort for RecordingPort {
        fn kill(&self, session_id: &str) {
            self.calls.lock().unwrap().push(format!("kill {session_id}"));
        }

        fn abort(&self, handle: &str) {
            self.calls.lock().unwrap().push(format!("abort {handle}"));
            super::super::abort_and_notify(&self.app, &self.state, handle);
        }
    }

    struct Fixture {
        _app: tauri::App<tauri::test::MockRuntime>,
        port: Option<RecordingPort>,
        state: Arc<DashboardLaunchState>,
        calls: Arc<Mutex<Vec<String>>>,
        changed: mpsc::Receiver<()>,
    }

    impl Fixture {
        /// A launch that reserved `launch`, as `launch_managed_dir_session_typed` does.
        fn new() -> Self {
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let (send, changed) = mpsc::channel();
            app.listen(super::super::SESSION_STATE_CHANGED, move |_| {
                let _ = send.send(());
            });
            let state = Arc::new(DashboardLaunchState::new(1));
            assert!(state.begin("launch").unwrap());
            let calls = Arc::new(Mutex::new(Vec::new()));
            let port = RecordingPort {
                app: app.handle().clone(),
                state: state.clone(),
                calls: calls.clone(),
            };
            Self {
                _app: app,
                port: Some(port),
                state,
                calls,
                changed,
            }
        }

        fn guard(&mut self, fresh: bool) -> PreBindReservation<RecordingPort> {
            PreBindReservation::new(self.port.take().unwrap(), "launch", fresh)
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn announced(&self) -> bool {
            self.changed.recv_timeout(Duration::from_secs(3)).is_ok()
        }

        fn quiet(&self) -> bool {
            self.changed.recv_timeout(Duration::from_millis(50)).is_err()
        }
    }

    #[test]
    fn a_launch_dropped_before_its_tab_opens_aborts_without_a_kill() {
        let mut fixture = Fixture::new();
        drop(fixture.guard(true));
        assert_eq!(fixture.calls(), ["abort launch"]);
        assert!(fixture.announced());
        assert!(fixture.quiet());
        assert_eq!(fixture.state.available(), 1, "the reserved slot is freed");
        assert!(fixture.state.snapshot().is_empty());
    }

    #[test]
    fn a_launch_dropped_after_its_tab_opens_kills_it_then_aborts() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(true);
        guard.opened("launch-session");
        drop(guard);
        assert_eq!(fixture.calls(), ["kill launch-session", "abort launch"]);
        assert!(fixture.announced());
        assert!(fixture.quiet());
        assert_eq!(fixture.state.available(), 1);
    }

    #[test]
    fn a_committed_launch_is_left_alone() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(true);
        guard.opened("launch-session");
        fixture
            .state
            .bind("launch", "launch-session", None)
            .unwrap();
        guard.commit();
        drop(guard);
        assert!(fixture.calls().is_empty());
        assert!(fixture.quiet());
        assert_eq!(
            fixture.state.resolve("launch").as_deref(),
            Some("launch-session")
        );
    }

    #[test]
    fn a_launch_that_found_its_handle_running_holds_an_unarmed_guard() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(false);
        guard.opened("launch-session");
        drop(guard);
        assert!(fixture.calls().is_empty());
        assert!(fixture.quiet());
        assert_eq!(fixture.state.available(), 0, "the reservation is kept");
    }
}

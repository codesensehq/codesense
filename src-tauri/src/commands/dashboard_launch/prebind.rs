// SPDX-License-Identifier: MIT
//! The reservation a fresh managed launch holds until its session is bound. The launch
//! awaits between reserving a slot and committing its claim, and an MCP caller that goes
//! away drops the launch future at any of those awaits. Dropped before the commit, the
//! guard kills the tab the launch opened, if any, and aborts the reservation, so a
//! cancelled open leaves neither a dead registry row nor an orphaned tab.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::DashboardLaunchState;

/// How long a dropped launch's kill waits for its tab's open to finish. The open spawns
/// the CLI on a blocking thread that a drop cannot stop, and a kill that lands first finds
/// no session to kill, so the tab would come up with no registry row behind it.
pub(crate) const OPEN_SETTLE_LIMIT: Duration = Duration::from_secs(30);

/// Whether a launch's tab open has finished, shared by the open and the guard's kill.
#[derive(Clone, Default)]
pub(crate) struct OpenLatch(Arc<(Mutex<bool>, Condvar)>);

impl OpenLatch {
    fn finish(&self) {
        let (done, changed) = &*self.0;
        *done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        changed.notify_all();
    }

    /// Block until the open finishes or `limit` passes: true when it finished.
    pub(crate) fn wait_finished(&self, limit: Duration) -> bool {
        let (done, changed) = &*self.0;
        let done = done.lock().unwrap_or_else(|e| e.into_inner());
        let (done, _) = changed
            .wait_timeout_while(done, limit, |done| !*done)
            .unwrap_or_else(|e| e.into_inner());
        *done
    }
}

/// Held by the task that opens the tab, and dropped when that open ends, however it
/// ends: the guard's kill waits for it.
pub(crate) struct OpenFinished(OpenLatch);

impl Drop for OpenFinished {
    fn drop(&mut self) {
        self.0.finish();
    }
}

/// Run `kill` once the open behind `open` has finished, or after `limit` if it is still
/// running then, so the kill finds the session the open spawned.
pub(crate) fn kill_once_open(
    open: &OpenLatch,
    session_id: &str,
    limit: Duration,
    kill: impl FnOnce(),
) {
    if !open.wait_finished(limit) {
        log::warn!(
            "launch {session_id}: its tab was still opening after {}s; killing it anyway",
            limit.as_secs()
        );
    }
    kill();
}

/// What a dropped reservation does, so tests can run it without the app's terminal hosts.
pub(crate) trait PreBindPort {
    /// Kill the session the launch opened a tab for, once `open` says that open has
    /// finished. Called from `Drop`, so it must not block, and it is idempotent: a session
    /// already gone, or never opened, is a no-op.
    fn kill(&self, session_id: &str, open: OpenLatch);
    /// Drop the reservation and announce it.
    fn abort_reserved(&self, handle: &str);
}

/// The app's port. Its kill waits for the open and runs the kill choke on a blocking
/// thread, and its abort is the notifying one.
pub(crate) struct AppPreBindPort(pub tauri::AppHandle);

impl PreBindPort for AppPreBindPort {
    fn kill(&self, session_id: &str, open: OpenLatch) {
        let (app, session_id) = (self.0.clone(), session_id.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            kill_once_open(&open, &session_id, OPEN_SETTLE_LIMIT, || {
                super::super::pty::kill_session(&app, &session_id);
            });
        });
    }

    fn abort_reserved(&self, handle: &str) {
        use tauri::Manager;
        if let Some(state) = self.0.try_state::<DashboardLaunchState>() {
            super::abort_and_notify(&self.0, &state, handle);
        }
    }
}

/// Armed for a fresh launch from its reservation until
/// [`claim_committed`](Self::claim_committed); a launch that found its handle already
/// running holds an unarmed one, which does nothing.
pub(crate) struct PreBindReservation<P: PreBindPort> {
    port: P,
    handle: String,
    armed: bool,
    opened: Option<(String, OpenLatch)>,
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

    /// The launch is about to open a tab for `session_id`: a drop from here on kills it,
    /// once the open the returned value is held by has finished.
    pub(crate) fn opening_tab(&mut self, session_id: &str) -> OpenFinished {
        let open = OpenLatch::default();
        self.opened = Some((session_id.to_string(), open.clone()));
        OpenFinished(open)
    }

    /// The session is bound: the registry owns it now, and the guard lets go.
    pub(crate) fn claim_committed(&mut self) {
        self.armed = false;
    }
}

impl<P: PreBindPort> Drop for PreBindReservation<P> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some((session_id, open)) = self.opened.take() {
            self.port.kill(&session_id, open);
        }
        self.port.abort_reserved(&self.handle);
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Announcements;
    use super::*;

    /// Records each kill and the open it waits on, and aborts through the real notifying
    /// abort on a mock app.
    struct RecordingPort {
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        state: Arc<DashboardLaunchState>,
        calls: Arc<Mutex<Vec<String>>>,
        open: Arc<Mutex<Option<OpenLatch>>>,
    }

    impl PreBindPort for RecordingPort {
        fn kill(&self, session_id: &str, open: OpenLatch) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("kill {session_id}"));
            *self.open.lock().unwrap() = Some(open);
        }

        fn abort_reserved(&self, handle: &str) {
            self.calls.lock().unwrap().push(format!("abort {handle}"));
            super::super::abort_and_notify(&self.app, &self.state, handle);
        }
    }

    struct Fixture {
        _app: tauri::App<tauri::test::MockRuntime>,
        port: Option<RecordingPort>,
        state: Arc<DashboardLaunchState>,
        calls: Arc<Mutex<Vec<String>>>,
        open: Arc<Mutex<Option<OpenLatch>>>,
        announcements: Announcements,
    }

    impl Fixture {
        /// A launch that reserved `launch`, as `launch_managed_dir_session_typed` does.
        fn new() -> Self {
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let announcements = Announcements::on(&app);
            let state = Arc::new(DashboardLaunchState::new(1));
            assert!(state.begin("launch").unwrap());
            let calls = Arc::new(Mutex::new(Vec::new()));
            let open = Arc::new(Mutex::new(None));
            let port = RecordingPort {
                app: app.handle().clone(),
                state: state.clone(),
                calls: calls.clone(),
                open: open.clone(),
            };
            Self {
                _app: app,
                port: Some(port),
                state,
                calls,
                open,
                announcements,
            }
        }

        fn guard(&mut self, fresh: bool) -> PreBindReservation<RecordingPort> {
            PreBindReservation::new(self.port.take().unwrap(), "launch", fresh)
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        /// The open the port's kill was handed.
        fn killed_open(&self) -> OpenLatch {
            self.open
                .lock()
                .unwrap()
                .clone()
                .expect("the drop killed the opened tab")
        }
    }

    #[test]
    fn a_launch_dropped_before_its_tab_opens_aborts_without_a_kill() {
        let mut fixture = Fixture::new();
        drop(fixture.guard(true));
        assert_eq!(fixture.calls(), ["abort launch"]);
        assert!(fixture.announcements.once());
        assert_eq!(fixture.state.available(), 1, "the reserved slot is freed");
        assert!(fixture.state.snapshot().is_empty());
    }

    #[test]
    fn a_launch_dropped_after_its_tab_opens_kills_it_then_aborts() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(true);
        drop(guard.opening_tab("launch-session"));
        drop(guard);
        assert_eq!(fixture.calls(), ["kill launch-session", "abort launch"]);
        assert!(fixture.announcements.once());
        assert_eq!(fixture.state.available(), 1);
    }

    #[test]
    fn a_committed_launch_is_left_alone() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(true);
        drop(guard.opening_tab("launch-session"));
        fixture
            .state
            .bind("launch", "launch-session", None)
            .unwrap();
        guard.claim_committed();
        drop(guard);
        assert!(fixture.calls().is_empty());
        assert!(fixture.announcements.quiet());
        assert_eq!(
            fixture.state.resolve("launch").as_deref(),
            Some("launch-session")
        );
    }

    #[test]
    fn a_launch_that_found_its_handle_running_holds_an_unarmed_guard() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(false);
        drop(guard.opening_tab("launch-session"));
        drop(guard);
        assert!(fixture.calls().is_empty());
        assert!(fixture.announcements.quiet());
        assert_eq!(fixture.state.available(), 0, "the reservation is kept");
    }

    #[test]
    fn a_launch_dropped_mid_open_kills_only_once_the_open_finishes() {
        let mut fixture = Fixture::new();
        let mut guard = fixture.guard(true);
        let finished = guard.opening_tab("launch-session");
        // The caller goes away while the open is still running on its own thread.
        drop(guard);
        assert_eq!(fixture.calls(), ["kill launch-session", "abort launch"]);
        assert!(fixture.announcements.once());
        let open = fixture.killed_open();
        assert!(
            !open.wait_finished(Duration::from_millis(20)),
            "the open is still running"
        );

        let order = Arc::new(Mutex::new(Vec::new()));
        let killer = {
            let order = order.clone();
            std::thread::spawn(move || {
                kill_once_open(&open, "launch-session", Duration::from_secs(3), || {
                    order.lock().unwrap().push("kill");
                });
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        order.lock().unwrap().push("open finished");
        drop(finished);
        killer.join().unwrap();
        assert_eq!(*order.lock().unwrap(), ["open finished", "kill"]);
    }

    #[test]
    fn a_kill_behind_an_open_that_never_finishes_runs_at_the_limit() {
        let open = OpenLatch::default();
        let _finished = OpenFinished(open.clone());
        let killed = std::cell::Cell::new(false);
        kill_once_open(&open, "launch-session", Duration::from_millis(20), || {
            killed.set(true);
        });
        assert!(killed.get(), "a wedged open does not hold the kill forever");
    }
}

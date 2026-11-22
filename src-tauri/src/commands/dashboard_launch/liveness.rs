// SPDX-License-Identifier: MIT
//! The one rule for whether a launch-registry row is alive, and the one probe it asks.
//! The live hub, the roster, the live-session check and the deadline sweep all read
//! liveness through [`registry_rows`] or [`SessionProbe`], so they cannot disagree.

use std::collections::{HashMap, HashSet};

use tauri::{AppHandle, Runtime};

use super::super::pty_backend::{self, Liveness};
use super::{
    is_live_headless, remote_agent_row, session_row, union_registry_and_live_pty,
    DashboardLaunchState, SessionRow, SessionSnapshot,
};

/// Which of a batch of local sessions have a running child, asked in one call. A
/// session the terminal hosts cannot answer for is [`Liveness::Unknown`].
pub(crate) trait SessionProbe {
    fn alive(&self, ids: &[&str]) -> HashMap<String, Liveness<bool>>;
}

/// The app's probe: the terminal hosts, through [`pty_backend::alive_session_ids`],
/// which never waits on a sidecar that is not answering.
pub(crate) struct HostProbe<'a, R: Runtime>(pub &'a AppHandle<R>);

impl<R: Runtime> SessionProbe for HostProbe<'_, R> {
    fn alive(&self, ids: &[&str]) -> HashMap<String, Liveness<bool>> {
        per_session(ids, &pty_backend::alive_session_ids(self.0, ids))
    }
}

/// One batched host answer, split per session.
fn per_session(ids: &[&str], alive: &Liveness<HashSet<String>>) -> HashMap<String, Liveness<bool>> {
    ids.iter()
        .map(|id| {
            let answer = match alive {
                Liveness::Known(running) => Liveness::Known(running.contains(*id)),
                Liveness::Unknown => Liveness::Unknown,
            };
            ((*id).to_string(), answer)
        })
        .collect()
}

/// `id`'s answer from one probe call.
pub(crate) fn probe_one(probe: &dyn SessionProbe, id: &str) -> Liveness<bool> {
    probe.alive(&[id]).remove(id).unwrap_or(Liveness::Unknown)
}

/// Where the caller's machine layouts place a registry row.
pub(crate) enum Remote {
    /// A session on this Mac: the probe decides.
    Local,
    /// A remote launch its connected machine no longer shows: not listed.
    Hidden,
    /// A remote agent, judged by its machine's layout.
    Row {
        alive: bool,
        session: Option<String>,
    },
}

/// Whether a local registry row is alive. An unbound reservation never is. A headless
/// run is alive while bound (it has no terminal child to probe). Any
/// other session is alive unless the probe knows it gone: an unanswered probe leaves
/// it alive, so a roster never offers to dismiss a session that may still run.
fn local_alive(row: &SessionSnapshot, answers: &HashMap<String, Liveness<bool>>) -> bool {
    if is_live_headless(row.kind, row.session_id.as_deref()) {
        return true;
    }
    row.session_id
        .as_deref()
        .is_some_and(|id| answers.get(id).is_none_or(|answer| answer.may_be_true()))
}

/// The registry's rows with their liveness, plus a row for each live session the
/// registry does not hold. `remote` places each row from the machine layouts the
/// caller already holds; `live_pty` is every live registry-less candidate, or the
/// error that stops the read. Local sessions are probed in one batched call, none
/// when nothing local is bound.
pub(crate) fn registry_rows(
    snapshot: Vec<SessionSnapshot>,
    probe: &dyn SessionProbe,
    remote: impl Fn(&SessionSnapshot) -> Remote,
    live_pty: Result<HashSet<String>, String>,
) -> Result<Vec<SessionRow>, String> {
    let placed: Vec<(SessionSnapshot, Remote)> = snapshot
        .into_iter()
        .map(|row| {
            let place = remote(&row);
            (row, place)
        })
        .collect();
    let answers = {
        let ids: Vec<&str> = placed
            .iter()
            .filter(|(row, place)| {
                matches!(place, Remote::Local)
                    && !is_live_headless(row.kind, row.session_id.as_deref())
            })
            .filter_map(|(row, _)| row.session_id.as_deref())
            .collect();
        if ids.is_empty() {
            HashMap::new()
        } else {
            probe.alive(&ids)
        }
    };
    let rows = placed
        .into_iter()
        .filter_map(|(row, place)| match place {
            Remote::Local => {
                let alive = local_alive(&row, &answers);
                Some(session_row(row, alive))
            }
            Remote::Hidden => None,
            Remote::Row { alive, session } => Some(remote_agent_row(row, alive, session)),
        })
        .collect();
    union_registry_and_live_pty(rows, live_pty)
}

/// Whether `session_id` runs now: a headless run by its registry entry, any other
/// session by the probe. A session kept only for its replay reads gone.
pub(crate) fn session_liveness_with(
    launch: Option<&DashboardLaunchState>,
    probe: &dyn SessionProbe,
    session_id: &str,
) -> Liveness<bool> {
    if launch.is_some_and(|launch| launch.has_live_headless_session(session_id)) {
        return Liveness::Known(true);
    }
    probe_one(probe, session_id)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::commands::dashboard_launch::DashboardLaunchState;
    use std::cell::Cell;

    /// A probe with fixed answers that counts its calls. An id it holds no answer for
    /// reads `Unknown`, as an unanswering host does.
    #[derive(Default)]
    pub(crate) struct StubProbe {
        pub answers: HashMap<String, Liveness<bool>>,
        pub calls: Cell<usize>,
    }

    impl StubProbe {
        pub(crate) fn with(answers: &[(&str, Liveness<bool>)]) -> Self {
            Self {
                answers: answers
                    .iter()
                    .map(|(id, answer)| ((*id).to_string(), answer.clone()))
                    .collect(),
                calls: Cell::new(0),
            }
        }
    }

    impl SessionProbe for StubProbe {
        fn alive(&self, ids: &[&str]) -> HashMap<String, Liveness<bool>> {
            self.calls.set(self.calls.get() + 1);
            ids.iter()
                .map(|id| {
                    let answer = self.answers.get(*id).cloned().unwrap_or(Liveness::Unknown);
                    ((*id).to_string(), answer)
                })
                .collect()
        }
    }

    fn local(_: &SessionSnapshot) -> Remote {
        Remote::Local
    }

    fn bound(launch: &DashboardLaunchState, handle: &str, session: &str) {
        assert!(launch.begin(handle).unwrap());
        launch.bind(handle, session, None).unwrap();
    }

    fn headless(launch: &DashboardLaunchState, handle: &str, session: &str) {
        bound(launch, handle, session);
        launch.mark_headless(
            handle,
            std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        );
    }

    fn alive_of(rows: &[SessionRow], handle: &str) -> bool {
        rows.iter()
            .find(|row| row.handle == handle)
            .unwrap_or_else(|| panic!("no row for {handle}"))
            .alive
    }

    #[test]
    fn a_known_answer_decides_a_bound_session() {
        let launch = DashboardLaunchState::new(4);
        bound(&launch, "up", "s-up");
        bound(&launch, "gone", "s-gone");
        let probe = StubProbe::with(&[
            ("s-up", Liveness::Known(true)),
            ("s-gone", Liveness::Known(false)),
        ]);
        let rows = registry_rows(launch.snapshot(), &probe, local, Ok(HashSet::new())).unwrap();
        assert!(alive_of(&rows, "up"));
        assert!(!alive_of(&rows, "gone"));
        assert_eq!(probe.calls.get(), 1, "one batched probe call per read");
    }

    #[test]
    fn an_unknown_answer_leaves_a_row_alive() {
        let launch = DashboardLaunchState::new(4);
        bound(&launch, "w", "s-w");
        let probe = StubProbe::default();
        let rows = registry_rows(launch.snapshot(), &probe, local, Ok(HashSet::new())).unwrap();
        assert!(alive_of(&rows, "w"));
    }

    #[test]
    fn an_unbound_reservation_is_dead() {
        let launch = DashboardLaunchState::new(4);
        assert!(launch.begin("reserved").unwrap());
        let probe = StubProbe::default();
        let rows = registry_rows(launch.snapshot(), &probe, local, Ok(HashSet::new())).unwrap();
        assert!(!alive_of(&rows, "reserved"));
        assert_eq!(probe.calls.get(), 0, "nothing bound, nothing probed");
    }

    #[test]
    fn a_headless_run_is_alive_only_while_bound_and_not_exited() {
        let launch = DashboardLaunchState::new(4);
        headless(&launch, "hl", "headless-1");
        // The probe knows no terminal child for it; its registry entry decides.
        let probe = StubProbe::with(&[("headless-1", Liveness::Known(false))]);
        let rows = registry_rows(launch.snapshot(), &probe, local, Ok(HashSet::new())).unwrap();
        assert!(alive_of(&rows, "hl"));
        assert_eq!(probe.calls.get(), 0, "a headless run is never probed");

        launch.mark_headless_exited("headless-1");
        let rows = registry_rows(launch.snapshot(), &probe, local, Ok(HashSet::new())).unwrap();
        assert!(!alive_of(&rows, "hl"));
    }

    #[test]
    fn a_registry_less_live_session_is_alive() {
        let launch = DashboardLaunchState::new(4);
        let probe = StubProbe::default();
        let rows = registry_rows(
            launch.snapshot(),
            &probe,
            local,
            Ok(HashSet::from(["pty-1".to_string()])),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(alive_of(&rows, "pty-1"));
        assert_eq!(rows[0].session_id.as_deref(), Some("pty-1"));
    }

    #[test]
    fn a_remote_row_is_placed_by_the_caller_and_never_probed() {
        let launch = DashboardLaunchState::new(4);
        bound(&launch, "shown", "s-shown");
        bound(&launch, "hidden", "s-hidden");
        let probe = StubProbe::default();
        let rows = registry_rows(
            launch.snapshot(),
            &probe,
            |row| match row.handle.as_str() {
                "hidden" => Remote::Hidden,
                _ => Remote::Row {
                    alive: false,
                    session: Some("remote-session".into()),
                },
            },
            Ok(HashSet::new()),
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!alive_of(&rows, "shown"));
        assert_eq!(rows[0].session_id.as_deref(), Some("remote-session"));
        assert_eq!(probe.calls.get(), 0);
    }

    #[test]
    fn the_live_session_error_stops_the_read() {
        let launch = DashboardLaunchState::new(4);
        let probe = StubProbe::default();
        let read = registry_rows(launch.snapshot(), &probe, local, Err("hosts down".into()));
        assert_eq!(read.unwrap_err(), "hosts down");
    }
}

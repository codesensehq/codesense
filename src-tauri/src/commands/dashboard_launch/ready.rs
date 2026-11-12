// SPDX-License-Identifier: MIT
//! Whether a launched agent session is input-ready: past every startup screen its CLI
//! can show (folder trust, MCP approval, onboarding), none of which runs a hook. The
//! signal is the activity owner's observed bit, set by the CLI's first lifecycle hook,
//! read from its snapshot at the moment of asking so a hub rebuild that has not run yet
//! cannot hide it. A page launch types nothing into its agent until this says ready.

use std::future::Future;
use std::time::Duration;

use codesense_pty_core::activity::{Snapshot, State};
use serde::Serialize;

/// The longest a caller may ask the wait to run.
pub(crate) const MAX_READY_WAIT_MS: u64 = 120_000;
/// How often an unready session is looked at again.
pub(crate) const READY_POLL: Duration = Duration::from_millis(250);

/// One look at a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadyProbe {
    /// No sign yet: still on a startup screen, not yet bound, or not known at all.
    Pending,
    Ready,
    /// The agent's process ended.
    Exited,
}

/// The wire answer: `{ready:true}`, or `{ready:false, reason:"startup"|"exited"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AgentReadiness {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

impl AgentReadiness {
    const READY: Self = Self {
        ready: true,
        reason: None,
    };
    const STARTUP: Self = Self {
        ready: false,
        reason: Some("startup"),
    };
    const EXITED: Self = Self {
        ready: false,
        reason: Some("exited"),
    };
}

/// What a session's activity snapshot says. An exit wins over the observed bit, and a
/// crashed agent is exited even before its exit is recorded.
pub(crate) fn probe_of(snapshot: Option<&Snapshot>) -> ReadyProbe {
    match snapshot {
        Some(snapshot) if snapshot.exit.is_some() || snapshot.state == State::Crashed => {
            ReadyProbe::Exited
        }
        Some(snapshot) if snapshot.observed => ReadyProbe::Ready,
        _ => ReadyProbe::Pending,
    }
}

/// Ask `probe` until it says ready or exited, or `timeout` passes (not ready: startup).
/// Looks at least once, however short the timeout.
pub(crate) async fn await_ready_with<F, Fut>(
    timeout: Duration,
    interval: Duration,
    mut probe: F,
) -> AgentReadiness
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ReadyProbe>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match probe().await {
            ReadyProbe::Ready => return AgentReadiness::READY,
            ReadyProbe::Exited => return AgentReadiness::EXITED,
            ReadyProbe::Pending => {}
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return AgentReadiness::STARTUP;
        }
        tokio::time::sleep(interval.min(deadline - now)).await;
    }
}

/// `session`'s snapshot: its own host's activity owner first, read now; then the live hub's
/// last read of every host, for a session a local read cannot name (a remote one).
pub(crate) fn session_snapshot(app: &tauri::AppHandle, session: &str) -> Option<Snapshot> {
    use tauri::Manager;
    local_or_hub(
        crate::mcp::activity::session_snapshot(app, session),
        &app.state::<crate::live_hub::LiveHub>(),
        session,
    )
}

/// The local owner's read when it has one, else the hub's last read of any host.
fn local_or_hub(
    local: Option<Snapshot>,
    hub: &crate::live_hub::LiveHub,
    session: &str,
) -> Option<Snapshot> {
    local.or_else(|| hub.activity_snapshot_of(session))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn snapshot(observed: bool, exited: bool) -> Snapshot {
        snapshot_of("s", "idle", observed, exited)
    }

    fn snapshot_of(session: &str, state: &str, observed: bool, exited: bool) -> Snapshot {
        serde_json::from_value(serde_json::json!({
            "session":session, "identity":{"hostBootId":"boot", "sessionIncarnation":"pty", "invocationId":"run"},
            "revision":1, "turnGeneration":0, "provider":"claude",
            "state":state, "observed":observed, "limited":false,
            "exit": if exited { serde_json::json!({"code":0,"signal":null,"requested":false}) } else { serde_json::Value::Null },
            "asks":[]
        }))
        .unwrap()
    }

    const SHORT: Duration = Duration::from_millis(60);
    const TICK: Duration = Duration::from_millis(5);

    #[test]
    fn the_probe_reads_the_observed_bit_and_the_exit_directly() {
        // Bound and never observed: still on a startup screen.
        assert_eq!(probe_of(Some(&snapshot(false, false))), ReadyProbe::Pending);
        assert_eq!(probe_of(Some(&snapshot(true, false))), ReadyProbe::Ready);
        // A session the owner does not know is never ready.
        assert_eq!(probe_of(None), ReadyProbe::Pending);
        // The process ended, observed or not.
        assert_eq!(probe_of(Some(&snapshot(false, true))), ReadyProbe::Exited);
        assert_eq!(probe_of(Some(&snapshot(true, true))), ReadyProbe::Exited);
        // Crashed (its engine lost) before the exit is recorded: exited, never pending.
        assert_eq!(
            probe_of(Some(&snapshot_of("s", "crashed", false, false))),
            ReadyProbe::Exited
        );
    }

    #[test]
    fn a_remote_session_reads_ready_from_the_hubs_last_read() {
        // A remote row: the local owner can't name it, and the hub holds the read of the
        // host it runs on, among other hosts.
        let hub = crate::live_hub::LiveHub::default();
        hub.hold_host_activity("local", Ok(vec![snapshot_of("here", "idle", false, false)]));
        hub.hold_host_activity("down", Err("activity owner unavailable".into()));
        hub.hold_host_activity(
            "remote",
            Ok(vec![snapshot_of("there", "idle", true, false)]),
        );
        let read = local_or_hub(None, &hub, "there");
        assert_eq!(read.as_ref().map(|s| s.session.as_str()), Some("there"));
        assert_eq!(probe_of(read.as_ref()), ReadyProbe::Ready);
        // Not yet observed there: still on its startup screen.
        hub.hold_host_activity(
            "remote",
            Ok(vec![snapshot_of("there", "idle", false, false)]),
        );
        assert_eq!(
            probe_of(local_or_hub(None, &hub, "there").as_ref()),
            ReadyProbe::Pending
        );
        // The local owner's read wins over the hub's, which may lag.
        let local = snapshot_of("there", "idle", true, false);
        assert!(local_or_hub(Some(local), &hub, "there").unwrap().observed);
        // A session no host holds is never ready.
        assert_eq!(
            probe_of(local_or_hub(None, &hub, "nowhere").as_ref()),
            ReadyProbe::Pending
        );
    }

    #[tokio::test]
    async fn bound_and_never_observed_is_startup_at_the_timeout() {
        let looks = AtomicUsize::new(0);
        let answer = await_ready_with(SHORT, TICK, || async {
            looks.fetch_add(1, Ordering::SeqCst);
            probe_of(Some(&snapshot(false, false)))
        })
        .await;
        assert_eq!(answer, AgentReadiness::STARTUP);
        assert!(looks.load(Ordering::SeqCst) > 1, "it kept looking");
    }

    #[tokio::test]
    async fn observed_during_the_wait_is_ready_before_the_timeout() {
        let looks = AtomicUsize::new(0);
        let answer = await_ready_with(Duration::from_secs(30), TICK, || async {
            // Observed on the third look, with no hub rebuild in between.
            let observed = looks.fetch_add(1, Ordering::SeqCst) >= 2;
            probe_of(Some(&snapshot(observed, false)))
        })
        .await;
        assert_eq!(answer, AgentReadiness::READY);
        assert_eq!(looks.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_child_that_exits_is_exited_at_once() {
        let answer = await_ready_with(Duration::from_secs(30), TICK, || async {
            probe_of(Some(&snapshot(false, true)))
        })
        .await;
        assert_eq!(answer, AgentReadiness::EXITED);
    }

    #[tokio::test]
    async fn an_unknown_or_not_yet_bound_session_never_reads_ready() {
        // A session neither the owner nor the hub has seen, or a never-bound id, reads as
        // no snapshot: the wait runs to its timeout and ends startup.
        let answer = await_ready_with(SHORT, TICK, || async { probe_of(None) }).await;
        assert_eq!(answer, AgentReadiness::STARTUP);
    }

    #[tokio::test]
    async fn a_zero_timeout_still_looks_once() {
        let ready = await_ready_with(Duration::ZERO, TICK, || async { ReadyProbe::Ready }).await;
        assert_eq!(ready, AgentReadiness::READY);
        let pending =
            await_ready_with(Duration::ZERO, TICK, || async { ReadyProbe::Pending }).await;
        assert_eq!(pending, AgentReadiness::STARTUP);
    }

    #[test]
    fn the_wire_shape_names_the_reason_only_when_not_ready() {
        assert_eq!(
            serde_json::to_value(AgentReadiness::READY).unwrap(),
            serde_json::json!({"ready": true})
        );
        assert_eq!(
            serde_json::to_value(AgentReadiness::STARTUP).unwrap(),
            serde_json::json!({"ready": false, "reason": "startup"})
        );
        assert_eq!(
            serde_json::to_value(AgentReadiness::EXITED).unwrap(),
            serde_json::json!({"ready": false, "reason": "exited"})
        );
    }

    /// The command waits through the live hub and the activity owner, never a name: no CLI
    /// is spelled out in this module, and the wait is not CLI-specific.
    #[test]
    fn the_command_is_registered_and_reads_the_snapshot_directly() {
        let launch = include_str!("../dashboard_launch.rs");
        let start = launch
            .find("pub async fn agent_session_await_ready(")
            .unwrap();
        let body = &launch[start..];
        assert!(body[..body.find("\n}\n").unwrap()].contains("ready::session_snapshot("));
        let lib = include_str!("../../lib.rs");
        assert!(lib.contains("commands::dashboard_launch::agent_session_await_ready,"));
    }
}

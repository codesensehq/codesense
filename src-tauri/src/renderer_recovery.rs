// SPDX-License-Identifier: MIT
//! Architecture: posted reloads are checked and surviving renderers require fresh ownership proof.
//!
//! Every reload names its window. The kill step runs only for `main` and only while `main` is
//! the only window ([`kill_allowed`]): WebKit runs one WebContent process per webview and
//! Tauri does not say which is which, so with a satellite open no pid is provably `main`'s.
use crate::renderer_watchdog::{ReloadCause, RendererLiveness, WindowLiveness};
use crate::windows::registry::{Locked, WindowRegistry};
use std::{
    collections::BTreeSet,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;

// Policy: check the first reload after 5 s; allow recovery 30 s, dispatch at most 5 s.
const CHECK_DELAY: Duration = Duration::from_secs(5);
pub(crate) const RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);
/// The labels whose reload dispatch is outstanding: a stuck dispatch holds its own window only.
static DISPATCHING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// `label`'s outstanding dispatch; dropping it frees the label.
struct DispatchClaim(String);

impl Drop for DispatchClaim {
    fn drop(&mut self) {
        let mut labels = DISPATCHING.lock().unwrap_or_else(|p| p.into_inner());
        BTreeSet::remove(&mut *labels, &self.0);
    }
}

/// Claims `label`'s dispatch, or `None` while one is outstanding for it.
fn claim_dispatch(label: &str) -> Option<DispatchClaim> {
    let mut labels = DISPATCHING.lock().unwrap_or_else(|p| p.into_inner());
    BTreeSet::insert(&mut *labels, label.to_owned()).then(|| DispatchClaim(label.to_owned()))
}

/// Whether the kill step may run: only while `main` is the only registered window.
pub(crate) fn kill_allowed(registry: &WindowRegistry) -> bool {
    let locked = WindowRegistry::locked(registry);
    Iterator::all(&mut Locked::window_labels(&locked).iter(), |label| {
        crate::windows::is_main(label)
    })
}

/// Whether a `cause` reload of `label` may end in the kill step: a `ProcessDeath` of `main`
/// while it is the only window. Gates the pre-reload pid snapshot.
fn may_kill(registry: &WindowRegistry, label: &str, cause: ReloadCause) -> bool {
    cause == ReloadCause::ProcessDeath && crate::windows::is_main(label) && kill_allowed(registry)
}

/// How the kill step reads and signals renderers. Production passes
/// [`production_ops`]; a test injects a fixed pid list and counts signals.
pub(crate) struct RendererOps<'a> {
    pub snapshot: &'a dyn Fn() -> Vec<u32>,
    pub responsible: &'a dyn Fn(u32) -> Option<u32>,
    /// `Err` of kind `NotFound` means the process had already exited.
    pub signal: &'a mut dyn FnMut(u32) -> std::io::Result<()>,
}

fn webcontent_pids() -> Vec<u32> {
    crate::memory_metrics::renderer_webcontent_snapshot().1
}

/// `SIGKILL` to `pid`. A process that already exited (`ESRCH`) is `ErrorKind::NotFound`, so
/// [`terminate_survivors`] tells it apart without a platform check of its own. Off unix it
/// signals nothing.
fn sigkill(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, error));
        }
        return Err(error);
    }
    let _ = pid;
    Ok(())
}

/// The process table, the responsible-app check and `SIGKILL`.
fn production_ops<R>(run: impl FnOnce(&mut RendererOps<'_>) -> R) -> R {
    let mut signal = sigkill;
    let mut ops = RendererOps {
        snapshot: &webcontent_pids,
        responsible: &crate::memory_metrics::responsible,
        signal: &mut signal,
    };
    run(&mut ops)
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Recovered,
    Gone,
    Refuse,
    Terminate,
    TimedOut,
}

fn decide(
    elapsed: Duration,
    recovered: bool,
    alive: bool,
    in_snapshot: bool,
    owned: bool,
) -> Action {
    if recovered {
        Action::Recovered
    } else if elapsed >= RECOVERY_TIMEOUT {
        Action::TimedOut
    } else if !alive {
        Action::Gone
    } else if !in_snapshot || !owned {
        Action::Refuse
    } else {
        Action::Terminate
    }
}

async fn blocking<T: Send + 'static>(
    budget: Duration,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::time::timeout(
        budget,
        crate::commands::await_blocking("renderer recovery", work),
    )
    .await
    .map_err(|_| "renderer recovery operation timed out".to_string())?
}

async fn post_reload(
    app: tauri::AppHandle,
    label: String,
    budget: Duration,
) -> Result<u64, String> {
    // Architecture: a stuck dispatcher can occupy only one blocking thread, never a runtime worker.
    let Some(claim) = claim_dispatch(&label) else {
        return Err(format!(
            "previous reload dispatch for {label:?} is still outstanding"
        ));
    };
    let until = Instant::now() + budget;
    blocking(budget, move || {
        let _claim = claim;
        let win = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("no {label:?} webview window to reload"))?;
        if Instant::now() >= until {
            return Err("reload dispatch expired before posting".into());
        }
        // Architecture: only a heartbeat received after posting proves recovery.
        let posted_at = crate::runtime::now_ms();
        win.reload().map_err(|e| e.to_string())?;
        Ok(posted_at)
    })
    .await
}

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        pid > 1
            && (unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn terminate_survivors(
    liveness: &RendererLiveness,
    original: &[u32],
    started: Instant,
    ack: u64,
    still_allowed: &dyn Fn() -> bool,
    ops: &mut RendererOps<'_>,
) -> Result<usize, String> {
    let current = (ops.snapshot)();
    let own_pid = std::process::id();
    let mut killed = 0;
    for &pid in original {
        let recovered = RendererLiveness::last_ack_ms(liveness) > ack;
        // Architecture: membership in BOTH snapshots plus a direct app responsibility check.
        // Revalidate immediately before the signal; a name alone never grants ownership.
        let owned = pid > 1 && pid != own_pid && (ops.responsible)(pid) == Some(own_pid);
        match decide(
            started.elapsed(),
            recovered,
            alive(pid),
            current.contains(&pid),
            owned,
        ) {
            Action::Recovered => return Ok(killed),
            Action::TimedOut => return Err("renderer recovery expired before termination".into()),
            Action::Gone => {
                log::info!(target: "webview-watchdog", "old renderer pid={pid} exited after initial reload")
            }
            Action::Refuse => {
                log::warn!(target: "webview-watchdog", "refusing renderer termination pid={pid}: current snapshot/ownership proof missing")
            }
            Action::Terminate => {
                // A satellite registered since the last signal may own a reused pid: stop.
                if !still_allowed() {
                    log::warn!(target: "webview-watchdog", "renderer termination stopped before pid={pid}: a second window is registered");
                    return Ok(killed);
                }
                if let Err(error) = (ops.signal)(pid) {
                    if std::io::Error::kind(&error) == std::io::ErrorKind::NotFound {
                        log::info!(target: "webview-watchdog", "renderer pid={pid} exited before termination");
                        continue;
                    }
                    return Err(format!("terminate renderer pid={pid}: {error}"));
                }
                killed += 1;
                log::warn!(target: "webview-watchdog", "terminated surviving renderer pid={pid}; verified snapshot and responsible app pid={own_pid}");
            }
        }
    }
    Ok(killed)
}

/// The kill step of `label`'s recovery: nothing unless [`may_kill`] still holds (a satellite
/// may have opened since the reload), else [`terminate_survivors`] on `original`, which
/// rechecks [`kill_allowed`] before each signal.
fn kill_step(
    registry: &WindowRegistry,
    label: &str,
    liveness: &RendererLiveness,
    original: &[u32],
    started: Instant,
    ack: u64,
    ops: &mut RendererOps<'_>,
) -> Result<usize, String> {
    if !may_kill(registry, label, ReloadCause::ProcessDeath) {
        return Ok(0);
    }
    terminate_survivors(
        liveness,
        original,
        started,
        ack,
        &|| kill_allowed(registry),
        ops,
    )
}

fn last_ack_of(app: &tauri::AppHandle, label: &str) -> u64 {
    let windows = app.state::<WindowLiveness>();
    RendererLiveness::last_ack_ms(&WindowLiveness::liveness_of(&windows, label))
}

/// `main`'s `ProcessDeath` recovery after the first reload: wait for a heartbeat, else kill the
/// old renderers (while `main` is the only window) and reload once more.
async fn recover(
    app: tauri::AppHandle,
    label: String,
    original: Vec<u32>,
    ack: u64,
    started: Instant,
) {
    let result = tokio::time::timeout(RECOVERY_TIMEOUT.saturating_sub(started.elapsed()), async {
        tokio::time::sleep(CHECK_DELAY).await;
        if last_ack_of(&app, &label) > ack { return Ok::<_, String>(()); }
        let check_app = app.clone();
        let check_label = label.clone();
        let killed = blocking(RECOVERY_TIMEOUT.saturating_sub(started.elapsed()), move || {
            let registry = check_app.state::<WindowRegistry>();
            let windows = check_app.state::<WindowLiveness>();
            let liveness = WindowLiveness::liveness_of(&windows, &check_label);
            production_ops(|ops| kill_step(&registry, &check_label, &liveness, &original, started, ack, ops))
        }).await?;
        if killed > 0 {
            post_reload(app.clone(), label.clone(), DISPATCH_TIMEOUT.min(RECOVERY_TIMEOUT.saturating_sub(started.elapsed()))).await?;
            log::info!(target: "webview-watchdog", "replacement reload posted after terminating {killed} renderer(s); awaiting heartbeat");
        }
        while last_ack_of(&app, &label) <= ack {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    }).await;
    match result {
        Ok(Ok(())) => {
            log::info!(target: "webview-watchdog", "renderer recovery complete: heartbeat resumed")
        }
        Ok(Err(error)) => {
            log::error!(target: "webview-watchdog", "renderer recovery failed: {error}")
        }
        Err(_) => {
            log::error!(target: "webview-watchdog", "renderer recovery timed out after 30 s; no heartbeat received")
        }
    }
}

/// Reloads `label`'s webview in place. Returns whether the reload was posted. A `ProcessDeath`
/// of `main` also starts [`recover`]; any other window's recovery is the reload alone, and its
/// heartbeat wait is the watchdog's (`renderer_watchdog::watch_step`).
pub(crate) async fn reload(app: tauri::AppHandle, label: &str, cause: ReloadCause) -> bool {
    let kill = may_kill(&app.state::<WindowRegistry>(), label, cause);
    let original = if kill || crate::memory_metrics::memory_enabled() {
        match blocking(DISPATCH_TIMEOUT, || {
            Ok(crate::memory_metrics::renderer_webcontent_snapshot())
        })
        .await
        {
            Ok((rss, pids)) => {
                // Architecture: recovery and the reload forensic line share one off-thread snapshot.
                if crate::memory_metrics::memory_enabled() {
                    log::debug!(target: "memory", "reload window={label} cause={} pre_pids={:?} pre_rss={}", cause.as_str(), pids, rss);
                }
                if kill {
                    pids
                } else {
                    Vec::new()
                }
            }
            Err(error) => {
                log::error!(target: "webview-watchdog", "pre-reload renderer snapshot failed: {error}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    match post_reload(app.clone(), label.to_owned(), DISPATCH_TIMEOUT).await {
        Err(error) => {
            log::error!(target: "webview-watchdog", "webview reload of {label} failed: {error}");
            false
        }
        Ok(ack) => {
            log::info!(target: "webview-watchdog", "initial reload of {label} posted; old renderer pids={original:?}");
            if cause == ReloadCause::ProcessDeath && crate::windows::is_main(label) {
                tauri::async_runtime::spawn(recover(
                    app,
                    label.to_owned(),
                    original,
                    ack,
                    Instant::now(),
                ));
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn blocked_gateway_times_out_without_pinning_the_runtime() {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let operation = blocking(Duration::from_millis(50), move || {
            let _ = entered.send(());
            // Architecture: release even on assertion failure so the test cannot leak a worker.
            let _ = held.recv_timeout(Duration::from_secs(2));
            let _ = finished.send(());
            Ok(())
        });
        let sibling = async {
            ready.await.unwrap();
            tokio::task::yield_now().await;
            true
        };
        let (result, progressed) = tokio::join!(operation, sibling);
        assert!(progressed);
        assert!(result.unwrap_err().contains("timed out"));
        release.send(()).unwrap();
        done.await.unwrap();
    }

    #[test]
    fn only_a_live_proven_renderer_can_be_terminated() {
        assert_eq!(
            decide(Duration::ZERO, false, true, true, true),
            Action::Terminate
        );
        assert_eq!(
            decide(Duration::ZERO, false, false, true, true),
            Action::Gone
        );
        assert_eq!(
            decide(Duration::ZERO, false, true, false, true),
            Action::Refuse
        );
        assert_eq!(
            decide(Duration::ZERO, false, true, true, false),
            Action::Refuse
        );
    }

    #[test]
    fn recovered_or_expired_attempts_never_terminate() {
        assert_eq!(
            decide(Duration::ZERO, true, true, true, true),
            Action::Recovered
        );
        assert_eq!(
            decide(Duration::from_secs(30), false, true, true, true),
            Action::TimedOut
        );
    }
}

#[cfg(test)]
mod scope {
    use super::*;
    use crate::windows::registry::test_host::Recorder;

    /// `main` alone, or with a ready `sat-1`.
    fn reg(with_satellite: bool) -> WindowRegistry {
        let reg = WindowRegistry::new();
        if with_satellite {
            let host = Recorder::default();
            reg.add_satellite(&host, "sat-1").unwrap();
            reg.ready(&host, "sat-1").unwrap();
        }
        reg
    }

    /// Unix only: off unix `alive` reports no process, so nothing is ever signalled.
    /// Runs the kill step for `label` on a live child process the injected ops report as a
    /// WebContent pid this app is responsible for. Returns the signals sent.
    #[cfg(unix)]
    fn signals(registry: &WindowRegistry, label: &str) -> u32 {
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let pid = child.id();
        let snapshot = move || vec![pid];
        let responsible = |_: u32| Some(std::process::id());
        let mut sent = 0;
        let mut signal = |_: u32| -> std::io::Result<()> {
            sent += 1;
            Ok(())
        };
        let liveness = <RendererLiveness as Default>::default();
        let result = kill_step(
            registry,
            label,
            &liveness,
            &[pid],
            Instant::now(),
            0,
            &mut RendererOps {
                snapshot: &snapshot,
                responsible: &responsible,
                signal: &mut signal,
            },
        );
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.is_ok(), "{result:?}");
        sent
    }

    #[test]
    fn the_kill_step_needs_main_to_be_the_only_window() {
        assert!(kill_allowed(&reg(false)));
        assert!(!kill_allowed(&reg(true)));
    }

    #[cfg(unix)]
    #[test]
    fn with_a_satellite_open_no_renderer_is_signalled() {
        let reg = reg(true);
        assert_eq!(signals(&reg, "main"), 0);
        assert_eq!(signals(&reg, "sat-1"), 0);
    }

    #[cfg(unix)]
    #[test]
    fn with_main_alone_a_proven_renderer_is_signalled_once() {
        assert_eq!(signals(&reg(false), "main"), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_satellite_registered_after_the_first_signal_stops_the_rest() {
        let reg = reg(false);
        let host = Recorder::default();
        let mut children: Vec<std::process::Child> = Iterator::collect((0..3).map(|_| {
            std::process::Command::new("sleep")
                .arg("5")
                .spawn()
                .unwrap()
        }));
        let pids: Vec<u32> = Iterator::collect(children.iter().map(std::process::Child::id));
        let snapshot = || pids.clone();
        let responsible = |_: u32| Some(std::process::id());
        let mut sent = 0;
        let mut signal = |_: u32| -> std::io::Result<()> {
            sent += 1;
            if sent == 1 {
                reg.add_satellite(&host, "sat-1").unwrap();
            }
            Ok(())
        };
        let liveness = <RendererLiveness as Default>::default();
        let result = kill_step(
            &reg,
            "main",
            &liveness,
            &pids,
            Instant::now(),
            0,
            &mut RendererOps {
                snapshot: &snapshot,
                responsible: &responsible,
                signal: &mut signal,
            },
        );
        for child in &mut children {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_eq!(result, Ok(1));
        assert_eq!(sent, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_renderer_that_exited_before_its_signal_is_not_an_error() {
        let reg = reg(false);
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let pid = child.id();
        let snapshot = move || vec![pid];
        let responsible = |_: u32| Some(std::process::id());
        let mut signal = |_: u32| -> std::io::Result<()> {
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        };
        let liveness = <RendererLiveness as Default>::default();
        let result = kill_step(
            &reg,
            "main",
            &liveness,
            &[pid],
            Instant::now(),
            0,
            &mut RendererOps {
                snapshot: &snapshot,
                responsible: &responsible,
                signal: &mut signal,
            },
        );
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(result, Ok(0));
    }

    #[test]
    fn a_satellite_reload_never_reaches_the_kill_step() {
        let reg = reg(false);
        assert!(may_kill(&reg, "main", ReloadCause::ProcessDeath));
        assert!(!may_kill(&reg, "main", ReloadCause::RenderStall));
        assert!(!may_kill(&reg, "sat-1", ReloadCause::ProcessDeath));
    }

    #[test]
    fn one_windows_stuck_dispatch_does_not_refuse_another() {
        let held = claim_dispatch("scope-main").unwrap();
        assert!(claim_dispatch("scope-main").is_none());
        let other = claim_dispatch("scope-sat-1");
        assert!(other.is_some());
        drop(held);
        assert!(claim_dispatch("scope-main").is_some());
    }
}

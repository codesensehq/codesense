// SPDX-License-Identifier: MIT
//! The git-ai capability's entry points, always compiled.
//!
//! The parts of attribution that run the git-ai binary or need a unix host (`install`,
//! `managed`, `watcher`, `catch_up`, `checkpoints`, `detect`, `metrics_db` and `git_ai`'s
//! drain) are compiled only with `cfg(cap_git_ai)`. Everything outside them reaches them through
//! here (and through `launch`'s own entry points). Each entry point decides at runtime from a
//! caps answer, [`Caps::live`] at the call site: with `git-ai` off a read reports it not
//! available and a write does nothing, logged once. Only the call into the gated part sits
//! under `cfg(cap_git_ai)`, so a build without the capability compiles everything else.
//!
//! The types those parts share with the always-compiled ones live here too.

use super::git_ai::GitAiSource;
use super::AttributionStatus;
use crate::platform_caps::{Caps, GIT_AI};
use crate::session_usage::UsageStore;
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What one checkpoint import read and stored.
#[derive(Debug, Default)]
pub(crate) struct Stats {
    pub records: usize,
    pub malformed: usize,
    pub partial: usize,
    pub bytes_read: usize,
    pub logs_seen: usize,
    pub logs_new: usize,
    pub rows_stored: usize,
    pub session_mapping_rows_stored: usize,
}

/// `describe_setup.attribution.capture`: the last checkpoint capture pass (see `catch_up`'s
/// status rule).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub last_sweep_at: Option<u64>,
    pub trigger: Option<&'static str>,
    pub clones_swept: usize,
    pub logs_seen: usize,
    pub logs_new: usize,
    pub trace_rows_stored: usize,
    pub session_mapping_rows_stored: usize,
    pub last_error: Option<String>,
    pub watch_errors: usize,
}

/// Persisted rollback facts, also returned by the attribution doctor.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousBinary {
    pub version: String,
    pub replacement: String,
    pub path: PathBuf,
}

/// Who is reading the one-time replacement notice: `describe_setup` acknowledges it; a passive
/// read (the dashboards' `setup` query) peeks and leaves the receipt untouched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReplacementNotice {
    Acknowledge,
    Peek,
}

/// What asked for the bundled git-ai to be installed.
#[cfg_attr(not(cap_git_ai), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trigger {
    Startup,
    Launch,
    OnDemand,
}

/// Whether `caps` has git-ai on.
pub(crate) fn enabled(caps: &Caps<'_>) -> bool {
    caps.enabled(GIT_AI)
}

/// What attribution reports where git-ai is off: not supported on this platform.
pub(crate) fn off_status() -> AttributionStatus {
    AttributionStatus::Unsupported {
        reason: "platform".into(),
    }
}

/// Logs, once per entry point in this process, that `entry` did nothing because git-ai is off.
pub(crate) fn skipped(entry: &'static str) {
    static LOGGED: Mutex<BTreeSet<&'static str>> = Mutex::new(BTreeSet::new());
    let first = LOGGED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(entry);
    if first {
        log::info!(target: "attribution", "git-ai is off on this platform; {entry} does nothing");
    }
}

/// At app start: registers the bundled git-ai and starts its install, the metrics-db pruning
/// and the checkpoint watcher.
pub(crate) fn start(caps: &Caps<'_>, app: &tauri::AppHandle, home: PathBuf, path: Option<&OsStr>) {
    if !enabled(caps) {
        return skipped("startup");
    }
    #[cfg(cap_git_ai)]
    {
        super::install::initialize(app, &home, path);
        super::install::ensure_installed(&home, path, Trigger::Startup);
        super::metrics_db::start(&home);
        super::watcher::start(app, home);
    }
    #[cfg(not(cap_git_ai))]
    let _ = (app, home, path);
}

/// Installs the bundled git-ai if it is missing, and the install's status.
pub(crate) fn ensure_installed(
    caps: &Caps<'_>,
    home: &Path,
    path: Option<&OsStr>,
    trigger: Trigger,
) -> Option<AttributionStatus> {
    if !enabled(caps) {
        skipped("install");
        return Some(off_status());
    }
    #[cfg(cap_git_ai)]
    let status = super::install::ensure_installed(home, path, trigger);
    #[cfg(not(cap_git_ai))]
    let status = {
        let _ = (home, path, trigger);
        Some(off_status())
    };
    status
}

/// Stops the checkpoint watchers, at a graceful exit.
pub(crate) fn shutdown(caps: &Caps<'_>) {
    if !enabled(caps) {
        return skipped("shutdown");
    }
    #[cfg(cap_git_ai)]
    super::watcher::shutdown();
}

/// Has the checkpoint watcher for `home` re-read which clones it watches.
pub(crate) fn refresh_watcher(caps: &Caps<'_>, home: &Path) {
    if !enabled(caps) {
        return skipped("watcher refresh");
    }
    #[cfg(cap_git_ai)]
    super::watcher::refresh(home);
    #[cfg(not(cap_git_ai))]
    let _ = home;
}

/// The attachment identity checkpoints are kept under for `repo`; `None` without git-ai.
pub(crate) fn repository_key(
    caps: &Caps<'_>,
    repo: &Path,
    key: Option<&str>,
    store: &mut UsageStore,
) -> Result<Option<String>, String> {
    if !enabled(caps) {
        return Ok(None);
    }
    #[cfg(cap_git_ai)]
    let found = super::checkpoints::repository_key(repo, key, store);
    #[cfg(not(cap_git_ai))]
    let found = {
        let _ = (repo, key, store);
        Ok(None)
    };
    found
}

/// Imports the checkpoints that name `commits`; nothing is imported without git-ai.
pub(crate) fn harvest(
    caps: &Caps<'_>,
    repo: &Path,
    key: &str,
    store: &mut UsageStore,
    commits: &BTreeSet<String>,
) -> Result<Stats, String> {
    if !enabled(caps) {
        skipped("checkpoint import");
        return Ok(Default::default());
    }
    #[cfg(cap_git_ai)]
    let stats = super::checkpoints::harvest(repo, key, store, commits);
    #[cfg(not(cap_git_ai))]
    let stats = {
        let _ = (repo, key, store, commits);
        Ok(Default::default())
    };
    stats
}

/// Whether a checkpoint log was seen for `commit`; never without git-ai.
pub(crate) fn covered(
    caps: &Caps<'_>,
    repo: &Path,
    key: &str,
    commit: &str,
    store: &UsageStore,
) -> Result<bool, String> {
    if !enabled(caps) {
        return Ok(false);
    }
    #[cfg(cap_git_ai)]
    let seen = super::checkpoints::covered(repo, key, commit, store);
    #[cfg(not(cap_git_ai))]
    let seen = {
        let _ = (repo, key, commit, store);
        Ok(false)
    };
    seen
}

/// The notes source a read uses: with `drain`, one that first has git-ai finish the commits it
/// queued for `home`. Without git-ai there is nothing to drain.
pub(crate) fn notes_source(caps: &Caps<'_>, home: &Path, drain: bool) -> GitAiSource {
    if !drain || !enabled(caps) {
        return GitAiSource::default();
    }
    #[cfg(cap_git_ai)]
    let source = GitAiSource::for_home(home);
    #[cfg(not(cap_git_ai))]
    let source = {
        let _ = home;
        GitAiSource::default()
    };
    source
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attribution::launch::{self, Reapplied};
    use crate::platform_caps::caps_with_off;

    /// Every file under `dir`, so a test can show nothing was written there.
    fn files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect()
    }

    /// With git-ai off a read answers "not available" from the caps answer alone, on any host.
    #[test]
    fn with_git_ai_off_a_read_reports_it_not_available() {
        let off = caps_with_off(&[GIT_AI]);
        let caps = Caps(&off);
        let home = tempfile::tempdir().unwrap();
        let doctor = launch::doctor_with_caps(&caps, home.path(), None, ReplacementNotice::Peek);
        assert_eq!(doctor.status, off_status());
        assert_eq!(doctor.binary, None);
        assert!(!doctor.daemon_reachable);
        assert!(doctor.warnings.is_empty());
        assert_eq!(doctor.capture, Capture::default());
        let usage = tempfile::tempdir().unwrap();
        let mut store = UsageStore::open(&usage.path().join("usage.sqlite")).unwrap();
        assert_eq!(
            covered(
                &caps,
                home.path(),
                "github.com/acme/api",
                "0123abcd",
                &store
            ),
            Ok(false)
        );
        assert_eq!(
            repository_key(&caps, home.path(), Some("github.com/acme/api"), &mut store),
            Ok(None)
        );
        assert!(files(home.path()).is_empty(), "a read writes nothing");
    }

    /// With git-ai off a write does nothing (no install, no config, no import, no watcher) and
    /// still answers.
    #[test]
    fn with_git_ai_off_a_write_does_nothing() {
        let off = caps_with_off(&[GIT_AI]);
        let caps = Caps(&off);
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_installed(&caps, home.path(), None, Trigger::OnDemand),
            Some(off_status())
        );
        assert_eq!(
            launch::reapply_config_with_caps(&caps, home.path()),
            Reapplied::Pending
        );
        refresh_watcher(&caps, home.path());
        shutdown(&caps);
        let usage = tempfile::tempdir().unwrap();
        let mut store = UsageStore::open(&usage.path().join("usage.sqlite")).unwrap();
        let stats = harvest(
            &caps,
            home.path(),
            "github.com/acme/api",
            &mut store,
            &BTreeSet::from(["0123abcd".to_owned()]),
        )
        .unwrap();
        assert_eq!((stats.records, stats.rows_stored), (0, 0));
        assert!(files(home.path()).is_empty(), "nothing was written");
    }

    /// The hook constants outside callers use do not depend on git-ai being compiled in.
    #[test]
    fn the_hook_constants_are_there_without_git_ai() {
        assert_eq!(launch::HOOK_TIMEOUT, 5);
        assert_eq!(
            launch::CODEX_HOOK_EVENTS,
            ["PreToolUse", "PostToolUse", "Stop"]
        );
        assert_eq!(super::super::git_ai::NOTES_REF, "sense");
    }
}

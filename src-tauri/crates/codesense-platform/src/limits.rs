// SPDX-License-Identifier: MIT
//! The open-file soft limit. A long-lived host raises its own soft
//! limit toward the hard limit (wide workspace walks, many sessions and their
//! pipes); the PTY children it spawns get the ORIGINAL soft limit back, as a
//! login would give them.
//!
//! The child's limit is set IN THE CHILD, never by lowering the
//! live host's. `portable-pty` offers no pre-exec hook, so a host that serves
//! [`EXEC_ARG`] (its entry point runs [`exec_with_limit`] first) launches each
//! PTY command through its own executable: `<host> --nofile-exec <original>
//! <program> -- <argv…>` sets the soft limit and execs the command in the same
//! process. Lowering the host's own limit around the fork, as before, made any
//! descriptor the host opened in that window (the spawn's own, or another
//! thread's) fail with EMFILE once the host held more than the original limit.
//!
//! Windows has no per-process soft limit on handles to raise or hand down
//! (the C runtime's `_setmaxstdio` covers only its stdio streams, which
//! nothing here uses), so its arm does nothing: [`raise`], [`child_argv`] and
//! [`usage`] return `None`; [`serve_child_limit`], [`inherit_original_limit`]
//! and [`watch`] do nothing; [`exec_with_limit`] returns an `Unsupported`
//! error, which no Windows path reaches because nothing passes [`EXEC_ARG`]
//! there.
//!
//! [`is_descriptor_exhaustion`] tells an error that hit the limit, on every OS.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use self::unix as sys;
#[cfg(unix)]
pub use self::unix::{
    child_argv, exec_with_limit, inherit_original_limit, raise, serve_child_limit, usage, watch,
};
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as sys;
#[cfg(windows)]
pub use self::windows::{
    child_argv, exec_with_limit, inherit_original_limit, raise, serve_child_limit, usage, watch,
};

/// The first argument of the child-limit shim (see [`exec_with_limit`]). With
/// the argv after it, a frozen contract across versions: a running host may
/// launch through a newer (or older) binary at its path, so never change it.
pub const EXEC_ARG: &str = "--nofile-exec";

/// One process's open-file budget: its soft and hard limits (`hard: None` is
/// unlimited) and the descriptors it holds (`None` when they cannot be counted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Usage {
    pub soft: u64,
    pub hard: Option<u64>,
    pub open: Option<u64>,
}

/// The share of the soft limit that raises the warning, in tenths.
const WARN_AT_TENTHS: u64 = 8;
/// The share it must fall below before the warning can be raised again.
const REARM_BELOW_TENTHS: u64 = 7;

/// The early warning: raised once when the open count reaches 80% of the soft
/// limit, and again only after it has fallen below 70%.
#[derive(Debug)]
pub struct Alarm {
    armed: bool,
}

impl Default for Alarm {
    fn default() -> Self {
        Self { armed: true }
    }
}

impl Alarm {
    /// Whether `usage` raises the warning now.
    pub fn observe(&mut self, usage: Usage) -> bool {
        let Some(open) = usage.open else {
            return false;
        };
        let tenths = open.saturating_mul(10);
        if self.armed && tenths >= usage.soft.saturating_mul(WARN_AT_TENTHS) {
            self.armed = false;
            return true;
        }
        if !self.armed && tenths < usage.soft.saturating_mul(REARM_BELOW_TENTHS) {
            self.armed = true;
        }
        false
    }
}

/// The warning `process` logs when [`Alarm::observe`] raises it.
pub fn warning(process: &str, usage: Usage) -> String {
    format!(
        "open-file limit: {process} (pid {}) holds {} of its soft limit {} (80% or more); new terminals and agents fail at the limit",
        std::process::id(),
        usage.open.map_or_else(|| "an unknown number".into(), |open| open.to_string()),
        usage.soft,
    )
}

/// A plain account of `process` reaching its open-file limit, with its counts
/// now, for an error that was EMFILE.
pub fn limit_reached(process: &str) -> String {
    let counts = usage().map_or_else(
        || "its limit could not be read".to_string(),
        |usage| {
            format!(
                "{} open of soft limit {}, hard {}",
                usage
                    .open
                    .map_or_else(|| "unknown".into(), |open| open.to_string()),
                usage.soft,
                usage
                    .hard
                    .map_or_else(|| "unlimited".into(), |hard| hard.to_string()),
            )
        },
    );
    format!(
        "open-file limit reached in {process} (pid {}): {counts}",
        std::process::id()
    )
}

/// Whether `error`, or any error in its `source()` chain, is this process
/// running out of descriptors: the OS error `EMFILE` on unix,
/// `ERROR_TOO_MANY_OPEN_FILES` on Windows, as an [`std::io::Error`] or as the
/// `code: <n>,` that `openpty` reports it with only in its message.
pub fn is_descriptor_exhaustion(error: &(dyn std::error::Error + 'static)) -> bool {
    let code = sys::TOO_MANY_OPEN_FILES;
    std::iter::successors(Some(error), |cause| cause.source()).any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::raw_os_error)
            == Some(code)
            // `openpty` reports its errno only in its message (`{:?}` of it).
            || str::contains(&cause.to_string(), &format!("code: {code},"))
    })
}

#[cfg(test)]
mod tests {
    use super::{Alarm, Usage};

    fn at(open: u64) -> Usage {
        Usage {
            soft: 100,
            hard: None,
            open: Some(open),
        }
    }

    #[test]
    fn the_alarm_warns_once_at_80_percent_and_rearms_below_70() {
        let mut alarm = Alarm::default();
        assert!(!alarm.observe(at(79)));
        assert!(alarm.observe(at(80)), "80% raises the warning");
        assert!(!alarm.observe(at(95)), "once, not on every sample");
        assert!(!alarm.observe(at(70)), "70% is not below 70%");
        assert!(!alarm.observe(at(85)), "still not re-armed");
        assert!(!alarm.observe(at(69)), "below 70% re-arms quietly");
        assert!(alarm.observe(at(80)), "and the next crossing warns again");
        assert!(
            !alarm.observe(Usage {
                open: None,
                ..at(0)
            }),
            "an uncountable process never warns"
        );
    }
}

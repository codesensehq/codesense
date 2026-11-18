// SPDX-License-Identifier: MIT
//! Linux process setup that must run before the webview exists.

use std::ffi::OsStr;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

const DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Set beside `WEBKIT_DISABLE_DMABUF_RENDERER` when the app supplied the value. An update
/// relaunch (`app.restart()`) hands the app's own environment to the new instance; the marker
/// tells that instance the `1` is still the app's, not the user's.
const MARKER: &str = "CODESENSE_WEBKIT_DMABUF_DEFAULT";

/// The names the app sets for itself and keeps out of children.
const APP_OWNED_NAMES: [&str; 2] = [DMABUF_VAR, MARKER];

/// Whether this process set `WEBKIT_DISABLE_DMABUF_RENDERER` itself. Written only by
/// [`apply_webkit_env_defaults`] (and the test seam), so it stays false off Linux.
static APP_OWNED: AtomicBool = AtomicBool::new(false);

/// What startup does with the WebKit default: the value to set (with the marker), if any, and
/// whether the variable is the app's to keep out of children.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub set: Option<&'static str>,
    pub app_owned: bool,
}

/// Decides the WebKit default from the variable and the marker the process started with. The
/// app owns the variable when it is absent (set it and the marker) or when both are exactly `1`
/// (the app's own relaunch: set nothing). Any other value is the user's (`0` included): set
/// nothing and pass it on unchanged. WebKitGTK's DMABUF renderer renders a blank window in many
/// VMs.
pub fn webkit_env_plan(user_value: Option<&OsStr>, marker: Option<&OsStr>) -> Plan {
    let one = Some(OsStr::new("1"));
    match user_value {
        None => Plan {
            set: Some("1"),
            app_owned: true,
        },
        Some(_) => Plan {
            set: None,
            app_owned: user_value == one && marker == one,
        },
    }
}

/// Applies the WebKitGTK defaults on Linux and does nothing elsewhere. Call first in `main`,
/// before any thread starts.
pub fn apply_webkit_env_defaults() {
    if std::env::consts::OS != "linux" {
        return;
    }
    let plan = webkit_env_plan(
        std::env::var_os(DMABUF_VAR).as_deref(),
        std::env::var_os(MARKER).as_deref(),
    );
    if let Some(value) = plan.set {
        // Safe to mutate the environment here: this crate is edition 2021, where `set_var` is
        // not `unsafe`, and the call runs before any thread starts, which is the condition
        // edition 2024 makes callers uphold with an `unsafe` block.
        std::env::set_var(DMABUF_VAR, value);
        std::env::set_var(MARKER, "1");
    }
    APP_OWNED.store(plan.app_owned, Ordering::Relaxed);
}

/// The variables the app set for its own webview, which shells, agents and tools it starts must
/// not inherit: they get the user's environment, while the app keeps its default (and the
/// marker, for its relaunch). Empty when the user set the variable, and always off Linux.
pub fn app_owned_env() -> &'static [&'static str] {
    if APP_OWNED.load(Ordering::Relaxed) {
        &APP_OWNED_NAMES
    } else {
        &[]
    }
}

/// Removes the app-owned WebKit variables from `command`'s environment. Call before adding the
/// spawn's own variables, so an explicit value still wins.
pub fn remove_app_webkit_env(command: &mut Command) {
    for name in app_owned_env() {
        command.env_remove(name);
    }
}

/// Restores the ownership flag (and releases the env lock) when a forced-ownership test ends.
#[cfg(test)]
pub(crate) struct ForcedOwnership {
    previous: bool,
    _env: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for ForcedOwnership {
    fn drop(&mut self) {
        APP_OWNED.store(self.previous, Ordering::Relaxed);
    }
}

/// Forces ownership for a test. Holds the process-wide env lock until the guard drops, so
/// forced-ownership tests serialize; don't take `env_guard()` again while holding it.
#[cfg(test)]
pub(crate) fn force_app_owned_for_test(owned: bool) -> ForcedOwnership {
    let env = crate::content_engine::test_support::env_guard();
    let previous = APP_OWNED.swap(owned, Ordering::Relaxed);
    ForcedOwnership {
        previous,
        _env: env,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(set: Option<&'static str>, app_owned: bool) -> Plan {
        Plan { set, app_owned }
    }

    #[test]
    fn webkit_env_plan_table() {
        fn v(s: &str) -> Option<&OsStr> {
            Some(OsStr::new(s))
        }
        let rows = [
            ((None, None), plan(Some("1"), true)),
            ((None, v("1")), plan(Some("1"), true)),
            ((v("1"), v("1")), plan(None, true)),
            ((v("1"), None), plan(None, false)),
            ((v("0"), None), plan(None, false)),
            ((v(""), None), plan(None, false)),
            ((v("0"), v("1")), plan(None, false)),
            ((v("1"), v("0")), plan(None, false)),
        ];
        for ((value, marker), expected) in rows {
            assert_eq!(
                webkit_env_plan(value, marker),
                expected,
                "value {value:?}, marker {marker:?}"
            );
        }
    }

    fn removals(command: &Command) -> Vec<String> {
        command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn helper_removes_both_names_when_owned() {
        let _owned = force_app_owned_for_test(true);
        let mut command = Command::new("true");
        remove_app_webkit_env(&mut command);
        let mut names = removals(&command);
        names.sort();
        assert_eq!(names, [MARKER, DMABUF_VAR]);
    }

    #[test]
    fn helper_removes_nothing_when_not_owned() {
        let _owned = force_app_owned_for_test(false);
        let mut command = Command::new("true");
        remove_app_webkit_env(&mut command);
        assert!(removals(&command).is_empty());
        assert!(app_owned_env().is_empty());
    }
}

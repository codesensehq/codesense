// SPDX-License-Identifier: MIT
//! SW-LN-35: the Settings → Terminal shell override, and what Settings shows
//! about the shell. The shell itself is resolved by the host a terminal runs on
//! ([`codesense_pty_core::shell`]); the override travels to it in the spawn
//! intent.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use codesense_platform::{cli, fs, user};
use codesense_pty_core::shell::{
    resolve_shell_from, shell_kind, ShellKind, ShellRow, ShellSource, ShellTable,
};
use serde::Serialize;
use tauri::Manager;

use crate::terminal::warm_pool::WarmPoolState;

/// The Settings → Terminal override, set by the frontend. `None` = detect.
static SHELL_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

/// The Settings → Terminal override, for a spawn's intent.
pub(crate) fn current_override() -> Option<String> {
    SHELL_OVERRIDE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// What Settings → Terminal shows about the shell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellInfo {
    /// The shell new terminals spawn.
    pub path: String,
    pub kind: ShellKind,
    pub source: ShellSource,
    /// The shell detected without the override (the host OS's table, e.g.
    /// `$SHELL` → passwd → zsh on macOS).
    pub detected_path: String,
    /// The override currently set, verbatim.
    pub override_path: Option<String>,
    /// The override is set but is not an executable shell of an accepted kind,
    /// so it is ignored.
    pub override_rejected: bool,
    /// A login shell (`$SHELL` or passwd) of a kind this OS does not accept,
    /// which is why the fallback is in use.
    pub unsupported_shell: Option<String>,
    /// The shell kinds this OS accepts from the override or a login shell.
    pub accepted_kinds: &'static [ShellKind],
}

pub(crate) fn shell_info_from(
    table: &'static ShellTable,
    override_shell: Option<&str>,
    env_shell: Option<&str>,
    passwd: impl Fn() -> Option<String>,
    env: impl Fn(&str) -> Option<OsString>,
    candidates: impl Fn(&OsStr, &str) -> Vec<PathBuf>,
    usable: impl Fn(&Path) -> bool,
) -> TerminalShellInfo {
    let resolve = |override_shell| {
        resolve_shell_from(
            table,
            override_shell,
            env_shell,
            &passwd,
            &env,
            &candidates,
            &usable,
        )
    };
    let effective = resolve(override_shell);
    let detected = resolve(None);
    let override_path = override_shell
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let override_rejected = override_path.is_some() && effective.source != ShellSource::Override;
    // Only a login shell of a kind the table does not accept is "unsupported";
    // a missing or stale path of an accepted kind just falls through to
    // detection. A table that reads no login shell (Windows) has none.
    let reads = |row| table.rows.contains(&row);
    let unsupported_shell = if detected.source == ShellSource::Fallback {
        env_shell
            .filter(|_| reads(ShellRow::EnvShell))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| reads(ShellRow::Passwd).then(&passwd).flatten())
            .map(|s| s.trim().to_string())
            .filter(|s| {
                !s.is_empty() && shell_kind(Path::new(s)).is_none_or(|kind| !table.accepts(kind))
            })
    } else {
        None
    };
    TerminalShellInfo {
        path: effective.path.to_string_lossy().into_owned(),
        kind: effective.kind,
        source: effective.source,
        detected_path: detected.path.to_string_lossy().into_owned(),
        override_path,
        override_rejected,
        unsupported_shell,
        accepted_kinds: table.kinds,
    }
}

fn current_shell_info() -> TerminalShellInfo {
    shell_info_from(
        ShellTable::host(),
        current_override().as_deref(),
        std::env::var("SHELL").ok().as_deref(),
        user::login_shell,
        |name: &str| std::env::var_os(name),
        cli::candidates,
        fs::is_executable,
    )
}

/// Settings → Terminal: the shell new terminals spawn, and where it came from.
#[tauri::command]
pub async fn terminal_shell_info() -> Result<TerminalShellInfo, String> {
    super::await_blocking("terminal_shell_info", || Ok(current_shell_info())).await
}

/// Settings → Terminal: set (or clear, with `None`/blank) the shell override.
/// Terminals opened afterwards use it, including the next one served from the
/// warm pool: pre-spawned shells of the old shell are never handed out, and the
/// frontend's follow-up `reconfigure` replaces them.
#[tauri::command]
pub async fn set_terminal_shell_override(
    app: tauri::AppHandle,
    shell: Option<String>,
) -> Result<TerminalShellInfo, String> {
    let shell = shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    apply_shell_override(app.try_state::<WarmPoolState>().as_deref(), shell);
    super::await_blocking("set_terminal_shell_override", || Ok(current_shell_info())).await
}

/// SW-LN-B31: store the override and hand it to the warm pool in one step, so no
/// terminal opened in between can get a member spawned with the old shell.
fn apply_shell_override(pool: Option<&WarmPoolState>, shell: Option<String>) {
    let mut guard = SHELL_OVERRIDE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(pool) = pool {
        pool.set_shell(shell.clone());
    }
    *guard = shell;
}

/// The shell a spawn runs. SW-LN-B31: a warm-pool member runs the shell its slot
/// was reserved with (`member_shell`), so the pool can tell a stale member from a
/// current one; everything else runs the Settings override.
pub(crate) fn spawn_shell(
    member_shell: Option<Option<String>>,
    current: impl FnOnce() -> Option<String>,
) -> Option<String> {
    member_shell.unwrap_or_else(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use codesense_pty_core::shell::{MACOS, WINDOWS};

    fn usable_set(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p: &Path| paths.iter().any(|x| Path::new(x) == p)
    }

    /// Settings' view with the macOS table, whose rows read no variable or
    /// `PATH`.
    fn macos_info(
        override_shell: Option<&str>,
        env_shell: Option<&str>,
        passwd: impl Fn() -> Option<String>,
        usable: impl Fn(&Path) -> bool,
    ) -> TerminalShellInfo {
        shell_info_from(
            &MACOS,
            override_shell,
            env_shell,
            passwd,
            |_: &str| None,
            |_: &OsStr, _: &str| Vec::new(),
            usable,
        )
    }

    #[test]
    fn apply_shell_override_moves_the_pool_to_the_new_shell() {
        let pool = WarmPoolState::default();
        apply_shell_override(Some(&pool), Some("/bin/bash".into()));
        assert_eq!(current_override().as_deref(), Some("/bin/bash"));
        apply_shell_override(Some(&pool), None);
        assert_eq!(current_override(), None);
    }

    #[test]
    fn a_pool_member_spawns_with_its_reserved_shell() {
        assert_eq!(
            spawn_shell(Some(Some("/bin/bash".into())), || Some("/bin/zsh".into())),
            Some("/bin/bash".into())
        );
        assert_eq!(spawn_shell(Some(None), || Some("/bin/zsh".into())), None);
        // Not a pool member: the Settings override.
        assert_eq!(
            spawn_shell(None, || Some("/bin/zsh".into())),
            Some("/bin/zsh".into())
        );
    }

    #[test]
    fn info_reports_rejected_override_and_unsupported_shell() {
        let info = macos_info(
            Some("/nope/bash"),
            Some("/bin/tcsh"),
            || Some("/bin/tcsh".into()),
            usable_set(&["/bin/tcsh"]),
        );
        assert!(info.override_rejected);
        assert_eq!(info.override_path.as_deref(), Some("/nope/bash"));
        assert_eq!(info.source, ShellSource::Fallback);
        assert_eq!(info.unsupported_shell.as_deref(), Some("/bin/tcsh"));
    }

    #[test]
    fn info_does_not_call_a_missing_supported_shell_unsupported() {
        // $SHELL names a Homebrew fish that was uninstalled.
        let info = macos_info(
            None,
            Some("/opt/homebrew/bin/fish"),
            || None,
            |_: &Path| false,
        );
        assert_eq!(info.source, ShellSource::Fallback);
        assert!(info.unsupported_shell.is_none());
    }

    #[test]
    fn info_reports_an_unsupported_passwd_shell_when_env_is_blank() {
        let info = macos_info(
            None,
            Some("  "),
            || Some("/bin/tcsh".into()),
            |_: &Path| true,
        );
        assert_eq!(info.unsupported_shell.as_deref(), Some("/bin/tcsh"));
    }

    #[test]
    fn info_for_a_plain_bash_user() {
        let info = macos_info(None, Some("/bin/bash"), || None, usable_set(&["/bin/bash"]));
        assert_eq!(info.path, "/bin/bash");
        assert_eq!(info.detected_path, "/bin/bash");
        assert_eq!(info.kind, ShellKind::Bash);
        assert!(!info.override_rejected);
        assert!(info.unsupported_shell.is_none());
        assert_eq!(
            info.accepted_kinds,
            [ShellKind::Zsh, ShellKind::Bash, ShellKind::Fish]
        );
    }

    /// pwsh is a known kind but not one macOS accepts: it is still the
    /// unsupported login shell, as before it was a kind at all.
    #[test]
    fn info_calls_a_pwsh_login_shell_on_macos_unsupported() {
        let info = macos_info(
            None,
            Some("/opt/homebrew/bin/pwsh"),
            || None,
            usable_set(&["/opt/homebrew/bin/pwsh", "/bin/zsh"]),
        );
        assert_eq!(info.path, "/bin/zsh");
        assert_eq!(info.source, ShellSource::Fallback);
        assert_eq!(
            info.unsupported_shell.as_deref(),
            Some("/opt/homebrew/bin/pwsh")
        );
    }

    #[test]
    fn info_on_windows_lists_its_kinds_and_reads_no_login_shell() {
        let info = shell_info_from(
            &WINDOWS,
            None,
            Some("/usr/bin/tcsh"),
            || panic!("passwd consulted on Windows"),
            |_: &str| None,
            |_: &OsStr, _: &str| Vec::new(),
            |_: &Path| false,
        );
        assert_eq!(info.path, "cmd.exe");
        assert_eq!(info.kind, ShellKind::Cmd);
        assert!(info.unsupported_shell.is_none());
        assert_eq!(
            info.accepted_kinds,
            [ShellKind::Pwsh, ShellKind::PowerShell, ShellKind::Cmd]
        );
        let wire = serde_json::to_value(&info).unwrap();
        assert_eq!(
            wire["acceptedKinds"],
            serde_json::json!(["pwsh", "powershell", "cmd"])
        );
        assert_eq!(wire["kind"], "cmd");
    }
}

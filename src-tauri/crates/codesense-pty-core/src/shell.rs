// SPDX-License-Identifier: MIT
//! Which shell a terminal runs, resolved by the host it runs on.
//!
//! Terminals run the user's own shell rather than always zsh. One resolver,
//! [`resolve_shell_from`], walks the rows of the host OS's [`ShellTable`]: on
//! macOS and Linux the Settings → Terminal override (carried in the spawn
//! intent), the host's `$SHELL`, the passwd entry for the user the host runs
//! as, then fixed paths; on Windows the override, `pwsh` on `PATH`, then the
//! PowerShell and `%ComSpec%` paths. A candidate is used only when it is an
//! absolute path to an executable file whose basename is a shell kind the table
//! accepts; anything else falls through to the next row, so a stale or
//! unsupported `$SHELL` never leaves the user without a terminal. Every table
//! ends in a bare name, resolved on `PATH` at spawn.
//!
//! The tables are data, selected by [`std::env::consts::OS`], so each one runs
//! as a unit test on every OS.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The shells a terminal can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
    /// PowerShell 7 (`pwsh`).
    Pwsh,
    /// Windows PowerShell 5.1 (`powershell`).
    PowerShell,
    Cmd,
}

impl ShellKind {
    /// Every kind.
    pub const ALL: [ShellKind; 6] = [
        ShellKind::Zsh,
        ShellKind::Bash,
        ShellKind::Fish,
        ShellKind::Pwsh,
        ShellKind::PowerShell,
        ShellKind::Cmd,
    ];

    /// Extension of this shell's bundled integration script
    /// (`resources/shell-integration/codesense-shell-init.<ext>`); `None` for
    /// a shell with no bundled script (PowerShell and cmd).
    pub fn init_script_ext(self) -> Option<&'static str> {
        match self {
            ShellKind::Zsh => Some("zsh"),
            ShellKind::Bash => Some("bash"),
            ShellKind::Fish => Some("fish"),
            ShellKind::Pwsh | ShellKind::PowerShell | ShellKind::Cmd => None,
        }
    }

    /// Whether `<shell> -l -c <command>` runs CodeSense's POSIX-style command
    /// strings unchanged. fish, PowerShell and cmd have their own syntax, so
    /// non-interactive commands for their users run under the table's
    /// [`ShellTable::posix_runner`] instead.
    pub fn runs_posix_commands(self) -> bool {
        matches!(self, ShellKind::Zsh | ShellKind::Bash)
    }
}

/// Where the resolved shell came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellSource {
    Override,
    Env,
    Passwd,
    Fallback,
}

/// The shell a terminal spawns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserShell {
    pub path: PathBuf,
    pub kind: ShellKind,
    pub source: ShellSource,
}

/// One row of a [`ShellTable`]: where a candidate shell comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellRow {
    /// The Settings → Terminal override.
    Setting,
    /// The host's `$SHELL`.
    EnvShell,
    /// The login shell in the user's passwd entry.
    Passwd,
    /// The first install of this name on the host's `PATH`.
    OnPath(&'static str),
    /// This path.
    Fixed(&'static str),
    /// The value of the environment variable, joined with these components.
    InVar(&'static str, &'static [&'static str]),
}

/// The shell that runs CodeSense's POSIX command strings for a user whose own
/// shell does not: the first usable path, else the bare name on `PATH`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PosixRunner {
    pub paths: &'static [&'static str],
    pub last: &'static str,
}

/// How one OS picks its default shell.
#[derive(Debug, PartialEq, Eq)]
pub struct ShellTable {
    /// The kinds a row other than the last may resolve to.
    pub kinds: &'static [ShellKind],
    /// The rows, tried in order.
    pub rows: &'static [ShellRow],
    /// The unconditional last row: a bare name resolved on `PATH` at spawn,
    /// and its kind.
    pub last: (&'static str, ShellKind),
    /// The POSIX command runner; `None` on an OS without one.
    pub posix_runner: Option<PosixRunner>,
}

/// macOS: the user's shell, then zsh.
pub static MACOS: ShellTable = ShellTable {
    kinds: &[ShellKind::Zsh, ShellKind::Bash, ShellKind::Fish],
    rows: &[
        ShellRow::Setting,
        ShellRow::EnvShell,
        ShellRow::Passwd,
        ShellRow::Fixed("/bin/zsh"),
    ],
    last: ("zsh", ShellKind::Zsh),
    posix_runner: Some(PosixRunner {
        paths: &["/bin/zsh"],
        last: "zsh",
    }),
};

/// Linux and every other unix: the user's shell, then bash, then zsh.
pub static LINUX: ShellTable = ShellTable {
    kinds: &[ShellKind::Zsh, ShellKind::Bash, ShellKind::Fish],
    rows: &[
        ShellRow::Setting,
        ShellRow::EnvShell,
        ShellRow::Passwd,
        ShellRow::Fixed("/bin/bash"),
        ShellRow::Fixed("/bin/zsh"),
    ],
    last: ("bash", ShellKind::Bash),
    posix_runner: Some(PosixRunner {
        paths: &["/bin/bash", "/bin/zsh"],
        last: "bash",
    }),
};

/// Windows: PowerShell 7, then Windows PowerShell, then cmd. Windows has no
/// `$SHELL` or passwd entry, and no POSIX shell to run command strings.
pub static WINDOWS: ShellTable = ShellTable {
    kinds: &[ShellKind::Pwsh, ShellKind::PowerShell, ShellKind::Cmd],
    rows: &[
        ShellRow::Setting,
        ShellRow::OnPath("pwsh"),
        ShellRow::InVar("ProgramFiles", &["PowerShell", "7", "pwsh.exe"]),
        ShellRow::InVar(
            "SystemRoot",
            &["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
        ),
        ShellRow::InVar("ComSpec", &[]),
    ],
    last: ("cmd.exe", ShellKind::Cmd),
    posix_runner: None,
};

impl ShellTable {
    /// The table for `os`, a [`std::env::consts::OS`] value.
    pub fn for_os(os: &str) -> &'static ShellTable {
        match os {
            "macos" => &MACOS,
            "windows" => &WINDOWS,
            _ => &LINUX,
        }
    }

    /// This host's table.
    pub fn host() -> &'static ShellTable {
        Self::for_os(std::env::consts::OS)
    }

    /// Whether a row other than the last may resolve to `kind`.
    pub fn accepts(&self, kind: ShellKind) -> bool {
        self.kinds.contains(&kind)
    }

    /// The shell that runs a command line for a user whose own shell does
    /// not run POSIX commands; `None` when this OS has none.
    pub fn posix_runner(&self, usable: impl Fn(&Path) -> bool) -> Option<PathBuf> {
        let runner = self.posix_runner?;
        let found = runner.paths.iter().map(Path::new).find(|path| usable(path));
        Some(found.map_or_else(|| PathBuf::from(runner.last), Path::to_path_buf))
    }
}

/// The shell kind named by `path`'s basename, ignoring case and an `.exe`
/// extension, if it is one.
pub fn shell_kind(path: &Path) -> Option<ShellKind> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "zsh" => Some(ShellKind::Zsh),
        "bash" => Some(ShellKind::Bash),
        "fish" => Some(ShellKind::Fish),
        "pwsh" => Some(ShellKind::Pwsh),
        "powershell" => Some(ShellKind::PowerShell),
        "cmd" => Some(ShellKind::Cmd),
        _ => None,
    }
}

/// A trimmed, non-empty source value as a path.
fn given(raw: Option<&str>) -> Option<PathBuf> {
    raw.map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
}

/// Pure resolution over `table` and injected sources, so the precedence is
/// testable on every OS without mutating the process environment: `env`
/// looks up a variable (`PATH` and the table's own), `candidates` lists the
/// installs of a name on a `PATH` value, and `usable` checks a candidate's
/// file. `passwd` is only consulted when every earlier row fails.
pub fn resolve_shell_from(
    table: &ShellTable,
    override_shell: Option<&str>,
    env_shell: Option<&str>,
    passwd: impl FnOnce() -> Option<String>,
    env: impl Fn(&str) -> Option<OsString>,
    candidates: impl Fn(&OsStr, &str) -> Vec<PathBuf>,
    usable: impl Fn(&Path) -> bool,
) -> UserShell {
    let accept = |path: PathBuf| -> Option<(PathBuf, ShellKind)> {
        if !path.is_absolute() {
            return None;
        }
        let kind = shell_kind(&path).filter(|kind| table.accepts(*kind))?;
        usable(&path).then_some((path, kind))
    };
    let mut passwd = Some(passwd);
    for row in table.rows {
        let (candidate, source) = match *row {
            ShellRow::Setting => (given(override_shell), ShellSource::Override),
            ShellRow::EnvShell => (given(env_shell), ShellSource::Env),
            ShellRow::Passwd => {
                let shell = passwd.take().and_then(|passwd| passwd());
                (given(shell.as_deref()), ShellSource::Passwd)
            }
            ShellRow::OnPath(name) => (
                env("PATH").and_then(|path| candidates(&path, name).into_iter().next()),
                ShellSource::Fallback,
            ),
            ShellRow::Fixed(path) => (Some(PathBuf::from(path)), ShellSource::Fallback),
            ShellRow::InVar(var, components) => (
                env(var).filter(|value| !value.is_empty()).map(|value| {
                    components
                        .iter()
                        .fold(PathBuf::from(value), |p, c| p.join(c))
                }),
                ShellSource::Fallback,
            ),
        };
        if let Some((path, kind)) = candidate.and_then(accept) {
            return UserShell { path, kind, source };
        }
    }
    let (path, kind) = table.last;
    UserShell {
        path: PathBuf::from(path),
        kind,
        source: ShellSource::Fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usable_set(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p: &Path| paths.iter().any(|x| Path::new(x) == p)
    }

    fn usable_paths(paths: Vec<PathBuf>) -> impl Fn(&Path) -> bool {
        move |p: &Path| paths.iter().any(|x| x == p)
    }

    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    fn not_on_path(_: &OsStr, _: &str) -> Vec<PathBuf> {
        Vec::new()
    }

    /// Resolution with the macOS table and no `PATH` or table variables, as
    /// every macOS and Linux row reads none.
    fn on_macos(
        override_shell: Option<&str>,
        env_shell: Option<&str>,
        passwd: impl FnOnce() -> Option<String>,
        usable: impl Fn(&Path) -> bool,
    ) -> UserShell {
        resolve_shell_from(
            &MACOS,
            override_shell,
            env_shell,
            passwd,
            no_env,
            not_on_path,
            usable,
        )
    }

    fn shell(path: &str, kind: ShellKind, source: ShellSource) -> UserShell {
        UserShell {
            path: PathBuf::from(path),
            kind,
            source,
        }
    }

    #[test]
    fn kinds_classify_by_basename_ignoring_case_and_exe() {
        for (name, kind) in [
            ("/bin/zsh", Some(ShellKind::Zsh)),
            ("/bin/bash", Some(ShellKind::Bash)),
            ("/opt/homebrew/bin/fish", Some(ShellKind::Fish)),
            ("pwsh.exe", Some(ShellKind::Pwsh)),
            ("PWSH.EXE", Some(ShellKind::Pwsh)),
            ("pwsh", Some(ShellKind::Pwsh)),
            ("powershell.exe", Some(ShellKind::PowerShell)),
            ("PowerShell.exe", Some(ShellKind::PowerShell)),
            ("cmd.exe", Some(ShellKind::Cmd)),
            ("CMD.EXE", Some(ShellKind::Cmd)),
            ("bash.exe", Some(ShellKind::Bash)),
            ("/bin/tcsh", None),
            ("zsh.sh", None),
            ("pwsh.exe.bak", None),
            ("", None),
        ] {
            assert_eq!(shell_kind(Path::new(name)), kind, "{name}");
        }
        let joined = std::env::temp_dir()
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe");
        assert_eq!(shell_kind(&joined), Some(ShellKind::Pwsh));
    }

    #[test]
    fn kinds_serialize_lowercase_and_all_lists_each_once() {
        let names: Vec<String> = ShellKind::ALL
            .iter()
            .map(|kind| serde_json::to_string(kind).unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "\"zsh\"",
                "\"bash\"",
                "\"fish\"",
                "\"pwsh\"",
                "\"powershell\"",
                "\"cmd\""
            ]
        );
        for kind in ShellKind::ALL {
            let name = serde_json::to_string(&kind).unwrap();
            assert_eq!(shell_kind(Path::new(name.trim_matches('"'))), Some(kind));
        }
    }

    #[test]
    fn only_zsh_and_bash_run_posix_commands() {
        let posix: Vec<ShellKind> = ShellKind::ALL
            .into_iter()
            .filter(|kind| kind.runs_posix_commands())
            .collect();
        assert_eq!(posix, [ShellKind::Zsh, ShellKind::Bash]);
    }

    #[test]
    fn only_zsh_bash_and_fish_have_an_init_script() {
        let scripts: Vec<(ShellKind, Option<&str>)> = ShellKind::ALL
            .into_iter()
            .map(|kind| (kind, kind.init_script_ext()))
            .collect();
        assert_eq!(
            scripts,
            [
                (ShellKind::Zsh, Some("zsh")),
                (ShellKind::Bash, Some("bash")),
                (ShellKind::Fish, Some("fish")),
                (ShellKind::Pwsh, None),
                (ShellKind::PowerShell, None),
                (ShellKind::Cmd, None),
            ]
        );
    }

    #[test]
    fn each_os_has_its_table() {
        assert_eq!(ShellTable::for_os("macos"), &MACOS);
        assert_eq!(ShellTable::for_os("linux"), &LINUX);
        assert_eq!(ShellTable::for_os("freebsd"), &LINUX);
        assert_eq!(ShellTable::for_os("windows"), &WINDOWS);
        assert_eq!(ShellTable::host(), ShellTable::for_os(std::env::consts::OS));
        // Each last row is a bare name of its own kind.
        for table in [&MACOS, &LINUX, &WINDOWS] {
            let (name, kind) = table.last;
            assert!(!Path::new(name).is_absolute(), "{name}");
            assert_eq!(shell_kind(Path::new(name)), Some(kind));
        }
    }

    #[test]
    fn env_shell_wins_over_passwd() {
        let got = on_macos(
            None,
            Some("/opt/homebrew/bin/fish"),
            || Some("/bin/bash".into()),
            usable_set(&["/opt/homebrew/bin/fish", "/bin/bash"]),
        );
        assert_eq!(
            got,
            shell("/opt/homebrew/bin/fish", ShellKind::Fish, ShellSource::Env)
        );
    }

    #[test]
    fn override_wins_over_env() {
        let got = on_macos(
            Some("/bin/bash"),
            Some("/bin/zsh"),
            || None,
            usable_set(&["/bin/bash", "/bin/zsh"]),
        );
        assert_eq!(got.path, PathBuf::from("/bin/bash"));
        assert_eq!(got.source, ShellSource::Override);
    }

    #[test]
    fn missing_env_falls_back_to_passwd() {
        let got = on_macos(
            None,
            None,
            || Some("/bin/bash".into()),
            usable_set(&["/bin/bash"]),
        );
        assert_eq!(got.path, PathBuf::from("/bin/bash"));
        assert_eq!(got.source, ShellSource::Passwd);
    }

    #[test]
    fn stale_env_shell_falls_through() {
        // $SHELL names a Homebrew fish that was uninstalled.
        let got = on_macos(
            None,
            Some("/opt/homebrew/bin/fish"),
            || Some("/bin/bash".into()),
            usable_set(&["/bin/bash"]),
        );
        assert_eq!(got.path, PathBuf::from("/bin/bash"));
        assert_eq!(got.source, ShellSource::Passwd);
    }

    #[test]
    fn unsupported_or_relative_shells_fall_back_to_zsh() {
        let got = on_macos(
            Some("bash"),
            Some("/bin/tcsh"),
            || Some("/bin/tcsh".into()),
            |_: &Path| true,
        );
        assert_eq!(
            got,
            shell("/bin/zsh", ShellKind::Zsh, ShellSource::Fallback)
        );
    }

    #[test]
    fn passwd_is_not_consulted_when_env_is_usable() {
        let got = on_macos(
            None,
            Some("/bin/zsh"),
            || panic!("passwd consulted"),
            usable_set(&["/bin/zsh"]),
        );
        assert_eq!(got.source, ShellSource::Env);
    }

    /// Today's macOS results, row by row.
    #[test]
    fn macos_table_golden() {
        let zsh_bash_fish = &["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"];
        type Passwd = Option<&'static str>;
        let rows: [(Option<&str>, Option<&str>, Passwd, &[&str], UserShell); 9] = [
            // The override, when usable, over everything.
            (
                Some(" /bin/bash "),
                Some("/bin/zsh"),
                None,
                zsh_bash_fish,
                shell("/bin/bash", ShellKind::Bash, ShellSource::Override),
            ),
            // A relative override is ignored.
            (
                Some("bash"),
                Some("/opt/homebrew/bin/fish"),
                None,
                zsh_bash_fish,
                shell("/opt/homebrew/bin/fish", ShellKind::Fish, ShellSource::Env),
            ),
            // pwsh as $SHELL is skipped exactly as before, onto passwd.
            (
                None,
                Some("/opt/homebrew/bin/pwsh"),
                Some("/bin/zsh"),
                &["/opt/homebrew/bin/pwsh", "/bin/zsh"],
                shell("/bin/zsh", ShellKind::Zsh, ShellSource::Passwd),
            ),
            // ... and onto the fallback when passwd names it too.
            (
                None,
                Some("/opt/homebrew/bin/pwsh"),
                Some("/opt/homebrew/bin/pwsh"),
                &["/opt/homebrew/bin/pwsh", "/bin/zsh"],
                shell("/bin/zsh", ShellKind::Zsh, ShellSource::Fallback),
            ),
            // A pwsh override is rejected the same way.
            (
                Some("/opt/homebrew/bin/pwsh"),
                None,
                Some("/bin/bash"),
                &["/opt/homebrew/bin/pwsh", "/bin/bash"],
                shell("/bin/bash", ShellKind::Bash, ShellSource::Passwd),
            ),
            // A Windows shell name is not a macOS shell.
            (
                None,
                Some("/usr/local/bin/cmd.exe"),
                None,
                &["/usr/local/bin/cmd.exe", "/bin/zsh"],
                shell("/bin/zsh", ShellKind::Zsh, ShellSource::Fallback),
            ),
            // A blank $SHELL falls through to passwd.
            (
                None,
                Some("  "),
                Some("/bin/bash"),
                zsh_bash_fish,
                shell("/bin/bash", ShellKind::Bash, ShellSource::Passwd),
            ),
            // Nothing usable: /bin/zsh.
            (
                None,
                Some("/bin/tcsh"),
                Some("/bin/tcsh"),
                &["/bin/tcsh", "/bin/zsh"],
                shell("/bin/zsh", ShellKind::Zsh, ShellSource::Fallback),
            ),
            // Not even /bin/zsh: zsh on PATH.
            (
                None,
                None,
                None,
                &[],
                shell("zsh", ShellKind::Zsh, ShellSource::Fallback),
            ),
        ];
        for (override_shell, env_shell, passwd, usable, want) in rows {
            let usable = move |p: &Path| usable.iter().any(|x| Path::new(x) == p);
            let got = on_macos(override_shell, env_shell, || passwd.map(Into::into), usable);
            assert_eq!(got, want, "{override_shell:?} {env_shell:?} {passwd:?}");
        }
    }

    #[test]
    fn linux_table_prefers_bash_then_zsh() {
        let linux = |env_shell: Option<&str>, usable: &'static [&'static str]| {
            resolve_shell_from(
                &LINUX,
                None,
                env_shell,
                || Some("/usr/bin/pwsh".into()),
                no_env,
                not_on_path,
                usable_set(usable),
            )
        };
        assert_eq!(
            linux(Some("/usr/bin/fish"), &["/usr/bin/fish", "/bin/bash"]),
            shell("/usr/bin/fish", ShellKind::Fish, ShellSource::Env)
        );
        // pwsh, as $SHELL and in passwd, is skipped.
        assert_eq!(
            linux(
                Some("/usr/bin/pwsh"),
                &["/usr/bin/pwsh", "/bin/bash", "/bin/zsh"]
            ),
            shell("/bin/bash", ShellKind::Bash, ShellSource::Fallback)
        );
        assert_eq!(
            linux(None, &["/usr/bin/pwsh", "/bin/zsh"]),
            shell("/bin/zsh", ShellKind::Zsh, ShellSource::Fallback)
        );
    }

    #[test]
    fn linux_table_with_no_usable_row_is_bash_on_path() {
        // NixOS: neither /bin/bash nor /bin/zsh.
        let got = resolve_shell_from(
            &LINUX,
            None,
            None,
            || None,
            no_env,
            not_on_path,
            |_: &Path| false,
        );
        assert_eq!(got, shell("bash", ShellKind::Bash, ShellSource::Fallback));
    }

    /// A Windows host's variables, rooted in a temp dir so every path is
    /// absolute on the OS the test runs on.
    struct WindowsHost {
        _tmp: tempfile::TempDir,
        root: PathBuf,
    }

    impl WindowsHost {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().to_path_buf();
            Self { _tmp: tmp, root }
        }

        fn pwsh_on_path(&self) -> PathBuf {
            self.root.join("Scoop").join("shims").join("pwsh.exe")
        }

        fn program_files_pwsh(&self) -> PathBuf {
            self.root
                .join("Program Files")
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe")
        }

        fn windows_powershell(&self) -> PathBuf {
            self.root
                .join("Windows")
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        }

        fn comspec(&self) -> PathBuf {
            self.root.join("Windows").join("System32").join("cmd.exe")
        }

        fn env(&self) -> impl Fn(&str) -> Option<OsString> + '_ {
            move |name: &str| match name {
                "PATH" => Some(OsString::from("windows-path")),
                "ProgramFiles" => Some(self.root.join("Program Files").into_os_string()),
                "SystemRoot" => Some(self.root.join("Windows").into_os_string()),
                "ComSpec" => Some(self.comspec().into_os_string()),
                _ => None,
            }
        }

        fn candidates(&self) -> impl Fn(&OsStr, &str) -> Vec<PathBuf> + '_ {
            move |path: &OsStr, name: &str| {
                assert_eq!(path, "windows-path");
                if name == "pwsh" {
                    vec![self.pwsh_on_path()]
                } else {
                    Vec::new()
                }
            }
        }

        fn resolve(&self, override_shell: Option<&str>, usable: Vec<PathBuf>) -> UserShell {
            resolve_shell_from(
                &WINDOWS,
                override_shell,
                Some("/usr/bin/bash"),
                || panic!("passwd consulted on Windows"),
                self.env(),
                self.candidates(),
                usable_paths(usable),
            )
        }
    }

    fn found(path: PathBuf, kind: ShellKind, source: ShellSource) -> UserShell {
        UserShell { path, kind, source }
    }

    #[test]
    fn windows_table_rows_in_order() {
        let host = WindowsHost::new();
        let all = vec![
            host.pwsh_on_path(),
            host.program_files_pwsh(),
            host.windows_powershell(),
            host.comspec(),
        ];
        for skip in 0..all.len() {
            let usable = all[skip..].to_vec();
            let want = match skip {
                0 => found(host.pwsh_on_path(), ShellKind::Pwsh, ShellSource::Fallback),
                1 => found(
                    host.program_files_pwsh(),
                    ShellKind::Pwsh,
                    ShellSource::Fallback,
                ),
                2 => found(
                    host.windows_powershell(),
                    ShellKind::PowerShell,
                    ShellSource::Fallback,
                ),
                _ => found(host.comspec(), ShellKind::Cmd, ShellSource::Fallback),
            };
            assert_eq!(host.resolve(None, usable), want, "row {skip}");
        }
    }

    #[test]
    fn windows_table_takes_a_windows_shell_setting_only() {
        let host = WindowsHost::new();
        let setting = host.windows_powershell();
        let got = host.resolve(setting.to_str(), vec![setting.clone(), host.pwsh_on_path()]);
        assert_eq!(
            got,
            found(setting, ShellKind::PowerShell, ShellSource::Override)
        );
        // A bash setting, or $SHELL, is not a Windows shell.
        let bash = host.root.join("Git").join("bin").join("bash.exe");
        let got = host.resolve(bash.to_str(), vec![bash.clone(), host.pwsh_on_path()]);
        assert_eq!(
            got,
            found(host.pwsh_on_path(), ShellKind::Pwsh, ShellSource::Fallback)
        );
    }

    #[test]
    fn windows_table_with_no_usable_row_is_cmd_on_path() {
        let host = WindowsHost::new();
        assert_eq!(
            host.resolve(None, Vec::new()),
            shell("cmd.exe", ShellKind::Cmd, ShellSource::Fallback)
        );
        // With %ComSpec% and the other variables unset.
        let got = resolve_shell_from(
            &WINDOWS,
            None,
            None,
            || panic!("passwd consulted on Windows"),
            no_env,
            |_: &OsStr, _: &str| panic!("no PATH to search"),
            |_: &Path| true,
        );
        assert_eq!(got, shell("cmd.exe", ShellKind::Cmd, ShellSource::Fallback));
    }

    #[test]
    fn each_table_names_its_posix_runner() {
        let none = |_: &Path| false;
        assert_eq!(
            MACOS.posix_runner(usable_set(&["/bin/zsh"])),
            Some(PathBuf::from("/bin/zsh"))
        );
        assert_eq!(MACOS.posix_runner(none), Some(PathBuf::from("zsh")));
        assert_eq!(
            LINUX.posix_runner(usable_set(&["/bin/bash", "/bin/zsh"])),
            Some(PathBuf::from("/bin/bash"))
        );
        assert_eq!(
            LINUX.posix_runner(usable_set(&["/bin/zsh"])),
            Some(PathBuf::from("/bin/zsh"))
        );
        assert_eq!(LINUX.posix_runner(none), Some(PathBuf::from("bash")));
        assert_eq!(WINDOWS.posix_runner(|_: &Path| true), None);
    }
}

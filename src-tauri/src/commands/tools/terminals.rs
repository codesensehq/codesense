// SPDX-License-Identifier: MIT
//! The external terminals per OS, as data: how each is found and the argv that opens it in a
//! folder. The folder is always one argv element plus the child's working directory, never shell
//! text. The OS is a runtime value (`std::env::consts::OS`), so every OS's rows are tested on
//! every host.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};

use super::Tool;
use crate::shared::opener::{Launch, LAUNCH_LIMIT};

/// How a terminal is found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Find {
    /// `/Applications/<app>.app` exists; run `program`.
    MacApp {
        app: &'static str,
        program: &'static str,
    },
    /// Always there; run this program.
    Always(&'static str),
    /// The first install of this name on `PATH`.
    OnPath(&'static str),
    /// The program this variable names: a bare name on `PATH` or an absolute executable.
    EnvVar(&'static str),
}

impl Find {
    /// The name the "no terminal found" error lists.
    fn tried_name(&self) -> String {
        match self {
            Self::MacApp { app, .. } => (*app).to_string(),
            Self::Always(program) | Self::OnPath(program) => (*program).to_string(),
            Self::EnvVar(var) => format!("${var}"),
        }
    }
}

/// One argv element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Arg {
    Lit(&'static str),
    /// The folder, as its own element.
    Cwd,
    /// The folder appended to a prefix, as one element (`--working-directory=<cwd>`).
    Joined(&'static str),
    /// The folder as its own element for an AppleScript that types it into the login shell
    /// through `quoted form of`. That is POSIX quoting, which fish reads differently for `\`, and
    /// typed control bytes act before any quoting (`^U` kills the line, `^C` drops it). Bash's
    /// readline in a non-UTF-8 locale strips the eighth bit, so a byte >= 0x80 can act as one
    /// too (0x95 as `^U`, 0x9b as ESC). A folder holding `\`, a C0 control byte, DEL or a byte
    /// of 0x80 or more is refused.
    ShellQuotedCwd,
}

/// How a row runs a command: its own program and argv, with the command appended last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CommandForm {
    pub program: &'static str,
    pub argv: &'static [Arg],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalRow {
    pub id: &'static str,
    pub label: &'static str,
    pub find: Find,
    pub argv: &'static [Arg],
    /// Wait for the launch, at most [`LAUNCH_LIMIT`], so a launcher that fails says so.
    pub waited: bool,
    /// How the row runs a command. A macOS row without one puts the command on the clipboard.
    pub with_command: Option<CommandForm>,
}

const fn row(
    id: &'static str,
    label: &'static str,
    find: Find,
    argv: &'static [Arg],
) -> TerminalRow {
    TerminalRow {
        id,
        label,
        find,
        argv,
        waited: false,
        with_command: None,
    }
}

/// A macOS row that opens the folder with `open -a <bundle> <folder>`, waited, and runs a command
/// through its AppleScript. With no command nothing is typed into a shell, so any folder name
/// opens.
const fn open_app_row(
    id: &'static str,
    label: &'static str,
    find: Find,
    argv: &'static [Arg],
    script: &'static [Arg],
) -> TerminalRow {
    TerminalRow {
        id,
        label,
        find,
        argv,
        waited: true,
        with_command: Some(CommandForm {
            program: "/usr/bin/osascript",
            argv: script,
        }),
    }
}

/// Terminal's bundle, always there on macOS. `open -a` is handed the bundle detection relies
/// on, so LaunchServices can't pick another app of the same name.
pub(crate) const TERMINAL_APP: &str = "/System/Applications/Utilities/Terminal.app";

/// iTerm2's bundle, the one `Find::MacApp { app: "iTerm", .. }` checks.
pub(crate) const ITERM_APP: &str = "/Applications/iTerm.app";

/// iTerm2: a new window whose session `cd`s to the folder (argv item 1) and runs the command
/// (item 2) or the login shell. The folder never appears in the script or the shell text.
pub(crate) const ITERM2_SCRIPT: &str = r#"on run argv
    set shellCommand to "cd " & quoted form of (item 1 of argv)
    if (count of argv) > 1 then
        set shellCommand to shellCommand & " && " & (item 2 of argv)
    else
        set shellCommand to shellCommand & " && exec $SHELL"
    end if
    tell application "iTerm2"
        create window with default profile
        tell current session of current window
            write text shellCommand
        end tell
    end tell
end run"#;

/// Terminal: the same command, in a new Terminal window.
pub(crate) const TERMINAL_SCRIPT: &str = r#"on run argv
    set shellCommand to "cd " & quoted form of (item 1 of argv)
    if (count of argv) > 1 then
        set shellCommand to shellCommand & " && " & (item 2 of argv)
    else
        set shellCommand to shellCommand & " && exec $SHELL"
    end if
    tell application "Terminal"
        do script shellCommand
        activate
    end tell
end run"#;

const MACOS: &[TerminalRow] = &[
    row(
        "ghostty",
        "Ghostty",
        Find::MacApp {
            app: "Ghostty",
            program: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        },
        &[Arg::Joined("--working-directory=")],
    ),
    open_app_row(
        "iterm2",
        "iTerm2",
        Find::MacApp {
            app: "iTerm",
            program: "/usr/bin/open",
        },
        &[Arg::Lit("-a"), Arg::Lit(ITERM_APP), Arg::Cwd],
        &[Arg::Lit("-e"), Arg::Lit(ITERM2_SCRIPT), Arg::ShellQuotedCwd],
    ),
    // Terminal.app is always there on macOS.
    open_app_row(
        "terminal",
        "Terminal",
        Find::Always("/usr/bin/open"),
        &[Arg::Lit("-a"), Arg::Lit(TERMINAL_APP), Arg::Cwd],
        &[
            Arg::Lit("-e"),
            Arg::Lit(TERMINAL_SCRIPT),
            Arg::ShellQuotedCwd,
        ],
    ),
];

/// x-terminal-emulator first (the distribution's choice; its target varies, so no flags), then
/// `$TERMINAL`, then the known terminals with their own folder flags (gnome-terminal and
/// xfce4-terminal are single-instance servers that ignore the working directory), then xterm.
const LINUX: &[TerminalRow] = &[
    row(
        "x-terminal-emulator",
        "x-terminal-emulator",
        Find::OnPath("x-terminal-emulator"),
        &[],
    ),
    row("env-terminal", "$TERMINAL", Find::EnvVar("TERMINAL"), &[]),
    row(
        "gnome-terminal",
        "GNOME Terminal",
        Find::OnPath("gnome-terminal"),
        &[Arg::Joined("--working-directory=")],
    ),
    row(
        "ptyxis",
        "Ptyxis",
        Find::OnPath("ptyxis"),
        &[
            Arg::Lit("--new-window"),
            Arg::Joined("--working-directory="),
        ],
    ),
    row(
        "kgx",
        "Console",
        Find::OnPath("kgx"),
        &[Arg::Joined("--working-directory=")],
    ),
    row(
        "konsole",
        "Konsole",
        Find::OnPath("konsole"),
        &[Arg::Lit("--workdir"), Arg::Cwd],
    ),
    row(
        "xfce4-terminal",
        "Xfce Terminal",
        Find::OnPath("xfce4-terminal"),
        &[Arg::Joined("--working-directory=")],
    ),
    row(
        "tilix",
        "Tilix",
        Find::OnPath("tilix"),
        &[Arg::Joined("--working-directory=")],
    ),
    row(
        "terminator",
        "Terminator",
        Find::OnPath("terminator"),
        &[Arg::Joined("--working-directory=")],
    ),
    row(
        "kitty",
        "kitty",
        Find::OnPath("kitty"),
        &[Arg::Lit("--directory"), Arg::Cwd],
    ),
    row(
        "alacritty",
        "Alacritty",
        Find::OnPath("alacritty"),
        &[Arg::Lit("--working-directory"), Arg::Cwd],
    ),
    row(
        "wezterm",
        "WezTerm",
        Find::OnPath("wezterm"),
        &[Arg::Lit("start"), Arg::Lit("--cwd"), Arg::Cwd],
    ),
    row(
        "foot",
        "foot",
        Find::OnPath("foot"),
        &[Arg::Joined("--working-directory=")],
    ),
    row(
        "ghostty",
        "Ghostty",
        Find::OnPath("ghostty"),
        &[Arg::Joined("--working-directory=")],
    ),
    row("xterm", "xterm", Find::OnPath("xterm"), &[]),
];

/// The terminals `os` knows, in the order they are preferred. Windows has none yet.
pub(crate) fn terminal_rows(os: &str) -> &'static [TerminalRow] {
    match os {
        "macos" => MACOS,
        "linux" => LINUX,
        _ => &[],
    }
}

/// A row that was found, with the program to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Detected {
    pub row: TerminalRow,
    pub program: PathBuf,
}

impl Detected {
    /// What Settings lists: `$TERMINAL`'s row is labelled with the program it names.
    pub(crate) fn tool(&self) -> Tool {
        let label = match self.row.find {
            Find::EnvVar(_) => self
                .program
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.row.label.to_string()),
            _ => self.row.label.to_string(),
        };
        Tool {
            id: self.row.id.into(),
            label,
        }
    }
}

/// Every row of `os` that `found` finds, in table order.
pub(crate) fn detect(os: &str, found: &dyn Fn(&Find) -> Option<PathBuf>) -> Vec<Detected> {
    terminal_rows(os)
        .iter()
        .filter_map(|row| found(&row.find).map(|program| Detected { row: *row, program }))
        .collect()
}

/// The terminal Settings starts with. macOS prefers the one this app was started from
/// (`$TERM_PROGRAM`), as before; elsewhere the first found; `""` when none.
pub(crate) fn default_terminal(os: &str, detected: &[Detected], term_program: &str) -> String {
    let has = |id: &str| detected.iter().any(|d| d.row.id == id);
    let term_program = term_program.to_lowercase();
    if os == "macos" {
        if term_program.contains("ghostty") && has("ghostty") {
            return "ghostty".into();
        }
        if term_program.contains("iterm") && has("iterm2") {
            return "iterm2".into();
        }
    }
    detected
        .first()
        .map(|d| d.row.id.to_string())
        .unwrap_or_default()
}

/// The program `$TERMINAL` names, if it is safe to run as one: a bare name found on `PATH`, or
/// an absolute path to an executable. A value with spaces or arguments, or a relative path, is
/// ignored: never split, never handed to a shell.
pub(crate) fn env_terminal(
    value: &OsStr,
    on_path: &dyn Fn(&str) -> Option<PathBuf>,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let value = value.to_str()?;
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return None;
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return is_executable(path).then(|| path.to_path_buf());
    }
    if value.contains('/') {
        return None;
    }
    on_path(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TerminalError {
    NotAbsolute(PathBuf),
    NotADirectory(PathBuf),
    NotInstalled {
        label: String,
    },
    NoTerminal {
        tried: Vec<String>,
    },
    Unsupported {
        os: String,
    },
    RunCommandUnsupported {
        os: String,
    },
    ShellUnsafe {
        label: String,
        cwd: PathBuf,
        what: &'static str,
    },
}

impl fmt::Display for TerminalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute(cwd) => {
                write!(
                    f,
                    "Can't open a terminal in {}: not an absolute path",
                    cwd.display()
                )
            }
            Self::NotADirectory(cwd) => {
                write!(
                    f,
                    "Can't open a terminal in {}: not a folder",
                    cwd.display()
                )
            }
            Self::NotInstalled { label } => write!(f, "{label} is not installed"),
            Self::NoTerminal { tried } => write!(
                f,
                "No terminal found (tried {}); install one or set TERMINAL",
                tried.join(", ")
            ),
            Self::Unsupported { os } => {
                write!(
                    f,
                    "Opening an external terminal isn't supported on {os} yet"
                )
            }
            Self::RunCommandUnsupported { os } => write!(
                f,
                "Running a command in an external terminal isn't supported on {os}"
            ),
            Self::ShellUnsafe { label, cwd, what } => write!(
                f,
                "{label} can't open {}: the path contains {what}",
                cwd.display()
            ),
        }
    }
}

impl From<TerminalError> for String {
    fn from(e: TerminalError) -> Self {
        e.to_string()
    }
}

/// What in `cwd` the AppleScript rows can't type safely: a backslash, a C0 control byte, DEL, or
/// a byte >= 0x80 (see [`Arg::ShellQuotedCwd`]).
fn shell_unsafe(cwd: &Path) -> Option<&'static str> {
    let bytes = cwd.as_os_str().as_encoded_bytes();
    if bytes.contains(&b'\\') {
        Some("a backslash")
    } else if bytes.iter().any(|&b| b < 0x20 || b == 0x7f) {
        Some("a control character")
    } else if bytes.iter().any(|&b| b >= 0x80) {
        Some("a non-ASCII character")
    } else {
        None
    }
}

/// The launch for `row`'s `program` in `cwd`: the folder is one argv element and the working
/// directory, never shell text.
pub(crate) fn plan(row: &TerminalRow, program: &Path, cwd: &Path) -> Result<Launch, TerminalError> {
    let launch = plan_argv(row.label, program, row.argv, cwd)?;
    Ok(if row.waited {
        launch.waited(LAUNCH_LIMIT)
    } else {
        launch
    })
}

/// `program` with `argv` in `cwd`; `label` names the row when the folder is refused.
fn plan_argv(
    label: &str,
    program: &Path,
    argv: &[Arg],
    cwd: &Path,
) -> Result<Launch, TerminalError> {
    let mut args = Vec::with_capacity(argv.len());
    for arg in argv {
        args.push(match arg {
            Arg::Lit(lit) => (*lit).into(),
            Arg::Cwd => cwd.as_os_str().to_os_string(),
            Arg::Joined(prefix) => {
                let mut joined = std::ffi::OsString::from(prefix);
                joined.push(cwd.as_os_str());
                joined
            }
            Arg::ShellQuotedCwd => {
                if let Some(what) = shell_unsafe(cwd) {
                    return Err(TerminalError::ShellUnsafe {
                        label: label.into(),
                        cwd: cwd.into(),
                        what,
                    });
                }
                cwd.as_os_str().to_os_string()
            }
        });
    }
    let mut launch = Launch::new(program, args);
    launch.cwd = Some(cwd.to_path_buf());
    Ok(launch)
}

/// What `open_terminal` runs: the launch, and on macOS Ghostty the command to put on the
/// clipboard first (as before).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalLaunch {
    pub label: String,
    pub launch: Launch,
    pub clipboard: Option<Clipboard>,
}

/// `text` written to `launch`'s stdin: `/usr/bin/pbcopy`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Clipboard {
    pub launch: Launch,
    pub text: String,
}

/// Picks and plans the terminal for `id` in `cwd` on `os`:
/// - `cwd` must be an absolute, existing folder;
/// - a detected row of that id is launched; a known row that isn't installed is an error naming
///   it; an empty or unknown id (the legacy `terminal` on Linux too) takes the first detected
///   row; none detected is an error naming every row tried;
/// - `run_command` is macOS only. A row with a [`CommandForm`] (Terminal, iTerm2) runs it through
///   that form, its AppleScript; Ghostty puts it on the clipboard. With no command, Terminal and
///   iTerm2 open the folder with `open -a`.
pub(crate) fn terminal_launch(
    os: &str,
    id: &str,
    cwd: &Path,
    run_command: &str,
    found: &dyn Fn(&Find) -> Option<PathBuf>,
    is_dir: &dyn Fn(&Path) -> bool,
) -> Result<TerminalLaunch, TerminalError> {
    let rows = terminal_rows(os);
    if rows.is_empty() {
        return Err(TerminalError::Unsupported { os: os.into() });
    }
    if !run_command.is_empty() && os != "macos" {
        return Err(TerminalError::RunCommandUnsupported { os: os.into() });
    }
    if !cwd.is_absolute() {
        return Err(TerminalError::NotAbsolute(cwd.into()));
    }
    if !is_dir(cwd) {
        return Err(TerminalError::NotADirectory(cwd.into()));
    }
    let detected = detect(os, found);
    let chosen = match rows.iter().find(|row| row.id == id) {
        Some(row) => detected
            .iter()
            .find(|d| d.row.id == row.id)
            .ok_or_else(|| TerminalError::NotInstalled {
                label: row.label.into(),
            })?,
        None => detected.first().ok_or_else(|| TerminalError::NoTerminal {
            tried: rows.iter().map(|row| row.find.tried_name()).collect(),
        })?,
    };
    let command_form = chosen.row.with_command.filter(|_| !run_command.is_empty());
    let launch = match command_form {
        Some(form) => {
            let mut launch = plan_argv(chosen.row.label, Path::new(form.program), form.argv, cwd)?;
            launch.args.push(run_command.into());
            launch
        }
        None => plan(&chosen.row, &chosen.program, cwd)?,
    };
    let clipboard =
        (!run_command.is_empty() && chosen.row.with_command.is_none()).then(|| Clipboard {
            launch: Launch::new("/usr/bin/pbcopy", std::iter::empty::<&str>()),
            text: run_command.to_string(),
        });
    Ok(TerminalLaunch {
        label: chosen.tool().label,
        launch,
        clipboard,
    })
}

/// Finds a row on this host: macOS apps under `/Applications`, names on `PATH`, `$TERMINAL`.
pub(crate) fn host_find(find: &Find) -> Option<PathBuf> {
    let on_path = |name: &str| {
        let path = std::env::var_os("PATH")?;
        codesense_platform::cli::candidates(&path, name)
            .into_iter()
            .next()
    };
    match find {
        Find::MacApp { app, program } => Path::new(&format!("/Applications/{app}.app"))
            .exists()
            .then(|| PathBuf::from(program)),
        Find::Always(program) => Some(PathBuf::from(program)),
        Find::OnPath(name) => on_path(name),
        Find::EnvVar(var) => env_terminal(
            &std::env::var_os(var)?,
            &on_path,
            &codesense_platform::fs::is_executable,
        ),
    }
}

#[cfg(test)]
mod tests;

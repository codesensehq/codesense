// SPDX-License-Identifier: MIT
//! Opening a folder in the file manager or a file in the text editor, per OS.
//!
//! [`plans`] is pure: it turns a request into the launchers to try, from the facts the caller
//! gathered once ([`HostFacts`]) and an injected [`Fs`], so every OS's rows are tested on every
//! host. [`spawn_first`] runs them through an injected [`Spawn`], with the app's own WebKit
//! environment kept out of each child. The OS is a runtime value (`std::env::consts::OS`), not a
//! `cfg`.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use log::warn;

/// What to open.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Open<'a> {
    /// A folder, in the file manager. Never a file, and never a macOS package folder: either
    /// would run with its own handler.
    Folder(&'a Path),
    /// A file, in the user's text editor. Never with the file's own handler, which could run it.
    Text(&'a Path),
}

/// One program to start, as argv (never a shell string).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Launch {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// Wait for it and check its exit status; otherwise it is left running and reaped on a thread.
    pub wait: bool,
    /// Said when this launcher ran and failed.
    pub note: Option<&'static str>,
}

impl Launch {
    pub(crate) fn new<P, A, I>(program: P, args: I) -> Self
    where
        P: Into<OsString>,
        A: Into<OsString>,
        I: IntoIterator<Item = A>,
    {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            cwd: None,
            wait: false,
            note: None,
        }
    }

    fn waited(mut self) -> Self {
        self.wait = true;
        self
    }

    /// The command to spawn: the app-owned WebKit variables removed (the one place a later
    /// change can add more env hygiene for every launch), no stdio, and the working directory.
    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        crate::linux_startup::remove_app_webkit_env(&mut command);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        command
    }

    fn name(&self) -> String {
        self.program.to_string_lossy().into_owned()
    }
}

/// Why there is no `text/plain` default to open a file with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TextDefaultMissing {
    /// `xdg-mime` isn't installed.
    NoXdgMime,
    /// `xdg-mime` couldn't run or exited non-zero.
    QueryFailed(String),
    /// `xdg-mime` printed nothing.
    Empty,
    /// The facts were gathered for a request that doesn't open text.
    NotQueried,
}

/// What [`plans`] needs to know about the host, gathered once by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostFacts {
    pub is_wsl: bool,
    /// `$XDG_DATA_HOME`, or `~/.local/share` when it is unset, empty or relative.
    pub xdg_data_home: Option<PathBuf>,
    /// `$XDG_DATA_DIRS`' absolute entries, or `/usr/local/share` and `/usr/share` when none.
    pub xdg_data_dirs: Vec<PathBuf>,
    /// What `xdg-mime query default text/plain` printed, trimmed.
    pub text_default: Result<String, TextDefaultMissing>,
}

impl HostFacts {
    /// Reads the host for `req`: whether this is WSL (a folder on Linux), and the XDG data
    /// directories and the `text/plain` default (text on Linux). Nothing is run off Linux.
    pub(crate) fn gather(req: &Open) -> Self {
        let linux = std::env::consts::OS == "linux";
        let text_default = match req {
            Open::Text(_) if linux => query_text_default(),
            _ => Err(TextDefaultMissing::NotQueried),
        };
        Self {
            is_wsl: linux && matches!(req, Open::Folder(_)) && host_is_wsl(),
            xdg_data_home: data_home(
                std::env::var_os("XDG_DATA_HOME").as_deref(),
                dirs::home_dir().as_deref(),
            ),
            xdg_data_dirs: data_dirs(std::env::var_os("XDG_DATA_DIRS").as_deref()),
            text_default,
        }
    }
}

/// WSL's kernel names Microsoft in its release string, as the `is-wsl` crate checks.
fn host_is_wsl() -> bool {
    ["/proc/sys/kernel/osrelease", "/proc/version"]
        .iter()
        .any(|file| {
            std::fs::read_to_string(file)
                .map(|text| text.to_lowercase().contains("microsoft"))
                .unwrap_or(false)
        })
}

fn query_text_default() -> Result<String, TextDefaultMissing> {
    let output = Launch::new("xdg-mime", ["query", "default", "text/plain"])
        .command()
        .stdout(Stdio::piped())
        .output()
        .map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => TextDefaultMissing::NoXdgMime,
            _ => TextDefaultMissing::QueryFailed(e.to_string()),
        })?;
    if !output.status.success() {
        return Err(TextDefaultMissing::QueryFailed(output.status.to_string()));
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id.is_empty() {
        return Err(TextDefaultMissing::Empty);
    }
    Ok(id)
}

/// `$XDG_DATA_HOME` when it is absolute, else `<home>/.local/share`.
pub(crate) fn data_home(value: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    match value.map(Path::new) {
        Some(dir) if dir.is_absolute() => Some(dir.to_path_buf()),
        _ => home.map(|home| home.join(".local/share")),
    }
}

/// `$XDG_DATA_DIRS`' absolute entries in order, else the spec's default.
pub(crate) fn data_dirs(value: Option<&OsStr>) -> Vec<PathBuf> {
    let dirs: Vec<PathBuf> = value
        .map(|value| {
            std::env::split_paths(value)
                .filter(|dir| dir.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    if dirs.is_empty() {
        vec![
            PathBuf::from("/usr/local/share"),
            PathBuf::from("/usr/share"),
        ]
    } else {
        dirs
    }
}

/// The filesystem questions [`plans`] asks, injected so tests don't touch the host.
pub(crate) trait Fs {
    fn exists(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
}

pub(crate) struct HostFs;

impl Fs for HostFs {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
}

/// A launcher that couldn't be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Tried {
    pub program: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenError {
    NotAbsolute(PathBuf),
    NotADirectory(PathBuf),
    NotAFile(PathBuf),
    Unsupported {
        os: String,
    },
    NoTextEditor {
        reason: TextDefaultMissing,
    },
    BadDesktopId(String),
    DesktopFileNotFound(String),
    NoLauncher {
        tried: Vec<Tried>,
    },
    Failed {
        program: String,
        status: String,
        note: Option<&'static str>,
    },
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAbsolute(path) => write!(f, "{} is not an absolute path", path.display()),
            Self::NotADirectory(path) => write!(f, "{} is not a folder", path.display()),
            Self::NotAFile(path) => write!(f, "{} is not a file", path.display()),
            Self::Unsupported { os } => {
                write!(f, "opening folders and files isn't supported on {os} yet")
            }
            Self::NoTextEditor { reason } => match reason {
                TextDefaultMissing::NoXdgMime => write!(
                    f,
                    "no text editor found: xdg-mime isn't installed, so the default for \
                     text/plain can't be read"
                ),
                TextDefaultMissing::QueryFailed(why) => write!(
                    f,
                    "no text editor found: xdg-mime query default text/plain failed ({why})"
                ),
                TextDefaultMissing::Empty => write!(
                    f,
                    "no text editor found: there is no default application for text/plain"
                ),
                TextDefaultMissing::NotQueried => {
                    write!(f, "no text editor found: the default wasn't looked up")
                }
            },
            Self::BadDesktopId(id) => write!(
                f,
                "refusing the text/plain default {id:?}: not a desktop file ID"
            ),
            Self::DesktopFileNotFound(id) => write!(
                f,
                "the text/plain default {id} has no desktop file in the applications folders"
            ),
            Self::NoLauncher { tried } if tried.is_empty() => write!(f, "nothing to open it with"),
            Self::NoLauncher { tried } => {
                write!(f, "couldn't start ")?;
                for (i, t) in tried.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{}: {}", t.program, t.error)?;
                }
                Ok(())
            }
            Self::Failed {
                program,
                status,
                note: n,
            } => {
                write!(f, "{program} failed ({status})")?;
                match n {
                    Some(note) => write!(f, " ({note})"),
                    None => Ok(()),
                }
            }
        }
    }
}

impl From<OpenError> for String {
    fn from(e: OpenError) -> Self {
        e.to_string()
    }
}

/// Linux's folder launchers: `open` 5.3.3's `unix.rs`, in its order (`wslview` only on WSL).
/// Kept as data so the app owns each `Command` and its environment; a test checks it against
/// `open::commands` on Linux. `wslview` gets the absolute path, which wslu reads from 3.1.1 on.
const LINUX_FOLDER: &[(&str, &[&str])] = &[
    ("wslview", &[]),
    ("xdg-open", &[]),
    ("gio", &["open"]),
    ("gnome-open", &[]),
    ("kde-open", &[]),
];

/// `gio launch` arrived in GLib 2.67.2 (NEWS), so 2.68 is the first stable release with it.
const GIO_LAUNCH_NOTE: &str = "gio launch needs GLib 2.68 or later";

/// The launchers to try for `req` on `os`, in order.
pub(crate) fn plans(
    os: &str,
    req: Open,
    facts: &HostFacts,
    fs: &dyn Fs,
) -> Result<Vec<Launch>, OpenError> {
    if !matches!(os, "macos" | "linux") {
        return Err(OpenError::Unsupported { os: os.into() });
    }
    match req {
        Open::Folder(dir) => {
            if !dir.is_absolute() {
                return Err(OpenError::NotAbsolute(dir.into()));
            }
            if !fs.is_dir(dir) {
                return Err(OpenError::NotADirectory(dir.into()));
            }
            Ok(match os {
                // `-R` selects the folder in Finder: a package folder (`X.app`, `.prefPane`) is
                // a directory too, and plain `open` would launch it.
                "macos" => vec![Launch::new(
                    "/usr/bin/open",
                    [OsStr::new("-R"), dir.as_os_str()],
                )],
                _ => LINUX_FOLDER
                    .iter()
                    .filter(|(program, _)| facts.is_wsl || *program != "wslview")
                    .map(|(program, args)| {
                        let args = args.iter().map(OsStr::new).chain([dir.as_os_str()]);
                        Launch::new(*program, args)
                    })
                    .collect(),
            })
        }
        Open::Text(file) => {
            if !file.is_absolute() {
                return Err(OpenError::NotAbsolute(file.into()));
            }
            if !fs.exists(file) || fs.is_dir(file) {
                return Err(OpenError::NotAFile(file.into()));
            }
            match os {
                "macos" => Ok(vec![Launch::new(
                    "/usr/bin/open",
                    [OsStr::new("-t"), file.as_os_str()],
                )
                .waited()]),
                _ => {
                    let id =
                        facts
                            .text_default
                            .as_ref()
                            .map_err(|reason| OpenError::NoTextEditor {
                                reason: reason.clone(),
                            })?;
                    let id = id.trim();
                    if !valid_desktop_id(id) {
                        return Err(OpenError::BadDesktopId(id.into()));
                    }
                    let is_file = |p: &Path| fs.exists(p) && !fs.is_dir(p);
                    let desktop = resolve_desktop_id(
                        id,
                        facts.xdg_data_home.as_deref(),
                        &facts.xdg_data_dirs,
                        &is_file,
                    )
                    .ok_or_else(|| OpenError::DesktopFileNotFound(id.into()))?;
                    let mut launch = Launch::new(
                        "gio",
                        [OsStr::new("launch"), desktop.as_os_str(), file.as_os_str()],
                    )
                    .waited();
                    launch.note = Some(GIO_LAUNCH_NOTE);
                    Ok(vec![launch])
                }
            }
        }
    }
}

/// A desktop-file ID: `^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$` with no `..`, so it names a file
/// and can't climb out of `applications/`.
pub(crate) fn valid_desktop_id(id: &str) -> bool {
    let Some(stem) = id.strip_suffix(".desktop") else {
        return false;
    };
    let mut chars = stem.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !id.contains("..")
}

/// The desktop file `id` names: under `<dir>/applications/` for the data home, then each data
/// dir, the literal ID first and then each single `-` → `/` split from the left (the spec maps
/// `kde4/kate.desktop` to `kde4-kate.desktop`). A split with an empty, `.` or `..` side is
/// skipped, and relative directories are ignored, so the result stays under an absolute
/// `applications/`.
pub(crate) fn resolve_desktop_id(
    id: &str,
    data_home: Option<&Path>,
    data_dirs: &[PathBuf],
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if !valid_desktop_id(id) {
        return None;
    }
    let mut names = vec![PathBuf::from(id)];
    for (i, _) in id.match_indices('-') {
        let (dir, rest) = (&id[..i], &id[i + 1..]);
        let bad = |s: &str| matches!(s, "" | "." | "..");
        if !bad(dir) && !bad(rest) {
            names.push(Path::new(dir).join(rest));
        }
    }
    data_home
        .into_iter()
        .chain(data_dirs.iter().map(PathBuf::as_path))
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| {
            let apps = dir.join("applications");
            names.iter().map(move |name| apps.join(name))
        })
        .find(|candidate| exists(candidate))
}

/// How a started launcher ended, as far as the executor waits for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Exit {
    /// Left running; reaped on a thread.
    Detached,
    /// Waited for.
    Status { success: bool, describe: String },
}

/// Starts a command, injected so tests record instead of spawning.
pub(crate) trait Spawn {
    fn start(&self, command: Command, wait: bool) -> io::Result<Exit>;
}

/// Spawns for real. A detached child is reaped on a thread, with a non-zero exit logged.
pub(crate) struct HostSpawn;

impl Spawn for HostSpawn {
    fn start(&self, mut command: Command, wait: bool) -> io::Result<Exit> {
        if wait {
            let status = command.status()?;
            return Ok(Exit::Status {
                success: status.success(),
                describe: status.to_string(),
            });
        }
        let mut child = command.spawn()?;
        let program = command.get_program().to_string_lossy().into_owned();
        let reaper = std::thread::Builder::new()
            .name("opener-reap".into())
            .spawn(move || match child.wait() {
                Ok(status) if !status.success() => {
                    warn!(target: "opener", "{program} exited with {status}");
                }
                Ok(_) => {}
                Err(e) => warn!(target: "opener", "waiting for {program}: {e}"),
            });
        if let Err(e) = reaper {
            warn!(target: "opener", "no thread to reap the launch: {e}");
        }
        Ok(Exit::Detached)
    }
}

/// Starts the first launcher that spawns. One that fails to spawn is logged and the next is
/// tried; one that spawns but exits non-zero (only waited rows see it) is an error, not retried.
pub(crate) fn spawn_first(launches: &[Launch], spawner: &dyn Spawn) -> Result<(), OpenError> {
    let mut tried = Vec::new();
    for launch in launches {
        match spawner.start(launch.command(), launch.wait) {
            Ok(Exit::Detached) | Ok(Exit::Status { success: true, .. }) => return Ok(()),
            Ok(Exit::Status { describe, .. }) => {
                return Err(OpenError::Failed {
                    program: launch.name(),
                    status: describe,
                    note: launch.note,
                })
            }
            Err(e) => {
                warn!(target: "opener", "couldn't start {}: {e}", launch.name());
                tried.push(Tried {
                    program: launch.name(),
                    error: e.to_string(),
                });
            }
        }
    }
    Err(OpenError::NoLauncher { tried })
}

/// Opens `req` on this host.
pub(crate) fn open(req: Open) -> Result<(), OpenError> {
    let facts = HostFacts::gather(&req);
    let launches = plans(std::env::consts::OS, req, &facts, &HostFs)?;
    spawn_first(&launches, &HostSpawn)
}

#[cfg(test)]
mod tests;

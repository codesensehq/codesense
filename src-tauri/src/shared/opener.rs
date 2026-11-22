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
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use codesense_platform::process::{kill_hard, ProcessTree};
use log::warn;

/// How long `xdg-mime query default text/plain` may take before it is killed.
pub(crate) const QUERY_LIMIT: Duration = Duration::from_secs(10);

/// How long a waited launcher (`gio launch`, `open -t`, `open -a`) may take before it is killed.
/// `gio launch` of a D-Bus-activated editor waits on the bus, whose default timeout is 25 s.
pub(crate) const LAUNCH_LIMIT: Duration = Duration::from_secs(30);

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
    /// Wait for it, at most this long, and check its exit status; `None` leaves it running and
    /// reaps it on a thread.
    pub wait: Option<Duration>,
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
            wait: None,
            note: None,
        }
    }

    /// Wait for it, at most `limit`.
    pub(crate) fn waited(mut self, limit: Duration) -> Self {
        self.wait = Some(limit);
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
    /// `xdg-mime` couldn't run, exited non-zero or ran past its limit.
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
    /// Reads this host for `req`, as [`HostFacts::gather_with`] does.
    pub(crate) fn gather(req: &Open) -> Self {
        Self::gather_with(
            std::env::consts::OS,
            req,
            &host_env,
            dirs::home_dir().as_deref(),
            &|path: &Path| std::fs::read_to_string(path).ok(),
            &HostSpawn,
        )
    }

    /// Reads the host for `req` on `os`: whether this is WSL (a folder on Linux), and the XDG
    /// data directories and the `text/plain` default (text on Linux). Nothing is run off Linux.
    /// The environment, the home folder, file reads and the spawner are injected.
    pub(crate) fn gather_with(
        os: &str,
        req: &Open,
        env: &dyn Fn(&str) -> Option<OsString>,
        home: Option<&Path>,
        read: &dyn Fn(&Path) -> Option<String>,
        spawner: &dyn Spawn,
    ) -> Self {
        let linux = os == "linux";
        let text_default = match req {
            Open::Text(_) if linux => query_text_default(spawner),
            _ => Err(TextDefaultMissing::NotQueried),
        };
        Self {
            is_wsl: linux && matches!(req, Open::Folder(_)) && host_is_wsl(read),
            xdg_data_home: data_home(env("XDG_DATA_HOME").as_deref(), home),
            xdg_data_dirs: data_dirs(env("XDG_DATA_DIRS").as_deref()),
            text_default,
        }
    }
}

fn host_env(key: &str) -> Option<OsString> {
    std::env::var_os(key)
}

/// WSL's kernel names Microsoft in its release string, as the `is-wsl` crate checks.
fn host_is_wsl(read: &dyn Fn(&Path) -> Option<String>) -> bool {
    ["/proc/sys/kernel/osrelease", "/proc/version"]
        .iter()
        .any(|file| {
            read(Path::new(file)).is_some_and(|text| text.to_lowercase().contains("microsoft"))
        })
}

/// What `xdg-mime query default text/plain` prints, trimmed, run through `spawner`.
fn query_text_default(spawner: &dyn Spawn) -> Result<String, TextDefaultMissing> {
    let command = Launch::new("xdg-mime", ["query", "default", "text/plain"]).command();
    let captured = spawner
        .capture(command, QUERY_LIMIT)
        .map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => TextDefaultMissing::NoXdgMime,
            _ => TextDefaultMissing::QueryFailed(e.to_string()),
        })?;
    match captured.exit {
        Exit::Status { success: true, .. } => {}
        Exit::Status { describe, .. } => return Err(TextDefaultMissing::QueryFailed(describe)),
        Exit::TimedOut { .. } => {
            return Err(TextDefaultMissing::QueryFailed(format!(
                "timed out after {}",
                describe_limit(QUERY_LIMIT)
            )))
        }
        Exit::Detached => {
            return Err(TextDefaultMissing::QueryFailed(
                "it wasn't waited for".into(),
            ))
        }
    }
    let id = String::from_utf8_lossy(&captured.stdout).trim().to_string();
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
    /// A waited launcher still ran at its limit and was killed. What it asked for may still
    /// happen: `gio launch` hands the file to a D-Bus-activated editor that can open it later.
    TimedOut {
        program: String,
        limit: Duration,
    },
}

/// `limit` as the errors say it: whole seconds, else milliseconds.
fn describe_limit(limit: Duration) -> String {
    if limit.subsec_nanos() == 0 && limit.as_secs() > 0 {
        format!("{} s", limit.as_secs())
    } else {
        format!("{} ms", limit.as_millis())
    }
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
            Self::TimedOut { program, limit } => write!(
                f,
                "{program} didn't finish within {}; it may still open",
                describe_limit(*limit)
            ),
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
                .waited(LAUNCH_LIMIT)]),
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
                    .waited(LAUNCH_LIMIT);
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
    /// Still running at its limit: its whole tree was killed and the root (`pid`) reaped.
    TimedOut { pid: u32 },
}

/// What a captured command printed, and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Captured {
    pub exit: Exit,
    pub stdout: Vec<u8>,
}

/// Starts a command, injected so tests record instead of spawning. An `Err` means it couldn't be
/// started; once it has started, every outcome is an [`Exit`].
pub(crate) trait Spawn {
    fn start(&self, command: Command, wait: Option<Duration>) -> io::Result<Exit>;
    /// Runs `command` for its stdout, at most `limit`. Nothing it started outlives it. An `Err`
    /// also covers output whose pipe stayed open past the root's end.
    fn capture(&self, command: Command, limit: Duration) -> io::Result<Captured>;
}

/// Spawns for real. A detached child is reaped on a thread, with a non-zero exit logged; a waited
/// one runs as a [`ProcessTree`], bounded by its limit.
pub(crate) struct HostSpawn;

impl Spawn for HostSpawn {
    fn start(&self, mut command: Command, wait: Option<Duration>) -> io::Result<Exit> {
        if let Some(limit) = wait {
            let mut tree = ProcessTree::spawn(&mut command)?;
            return Ok(wait_bounded(&mut tree, limit, Rest::Leave));
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

    /// The tree's stdout is read on a thread, at most [`CAPTURE_CAP`] of it, so a child that
    /// writes more than the pipe holds still finishes. Once the root ends, in time or killed at
    /// the limit, the rest of its tree is killed and the reader joined, waiting at most
    /// [`READER_LIMIT`]: a descendant that left the process group could still hold the pipe, and
    /// its reader is then left behind.
    fn capture(&self, mut command: Command, limit: Duration) -> io::Result<Captured> {
        command.stdout(Stdio::piped());
        let mut tree = ProcessTree::spawn(&mut command)?;
        let program = command.get_program().to_string_lossy().into_owned();
        let Some(stdout) = tree.child().stdout.take() else {
            return Err(io::Error::other(format!("{program} has no stdout")));
        };
        let (sent, received) = std::sync::mpsc::channel();
        let reader = std::thread::Builder::new()
            .name("opener-capture".into())
            .spawn(move || {
                let mut bytes = Vec::new();
                // Past the cap the pipe is dropped, so a child that keeps writing gets EPIPE.
                let read = stdout
                    .take(CAPTURE_CAP)
                    .read_to_end(&mut bytes)
                    .map(|_| bytes);
                let _ = sent.send(read);
            })?;
        let exit = wait_bounded(&mut tree, limit, Rest::Kill);
        let stdout = match received.recv_timeout(READER_LIMIT) {
            Ok(read) => {
                // It has sent, its last act, so this join returns at once.
                let _ = reader.join();
                read?
            }
            Err(_) => {
                warn!(target: "opener", "{program}'s output is still open; leaving its reader");
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "its output was still open {} after it ended",
                        describe_limit(READER_LIMIT)
                    ),
                ));
            }
        };
        Ok(Captured { exit, stdout })
    }
}

/// How long a capture waits for its output to close once its process tree has ended.
const READER_LIMIT: Duration = Duration::from_secs(1);

/// The most a capture keeps of its stdout; the rest is never read.
const CAPTURE_CAP: u64 = 1 << 20;

/// What a bounded wait does with what the root left running once the root exits in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rest {
    /// Leave it running: a launcher's job is to start something that outlives it.
    Leave,
    /// Kill it, so nothing it started keeps a pipe open.
    Kill,
}

/// How often a bounded wait looks at its root.
const POLL: Duration = Duration::from_millis(20);

/// Waits at most `limit` for `tree`'s root. In time, the root's status, with what it started
/// left or killed per `rest`. At the limit, the whole tree is killed (`kill_hard`) and the root
/// reaped: [`Exit::TimedOut`]. The root's exit that can't be read is a failed [`Exit::Status`],
/// never an `Err`, so the caller never takes a launcher that started for one that couldn't.
fn wait_bounded(tree: &mut ProcessTree, limit: Duration, rest: Rest) -> Exit {
    let deadline = Instant::now() + limit;
    loop {
        let polled = match rest {
            Rest::Leave => tree.try_wait_leaving_rest(),
            Rest::Kill => tree.try_wait(),
        };
        match polled {
            Ok(Some(status)) => {
                return Exit::Status {
                    success: status.success(),
                    describe: status.to_string(),
                }
            }
            Ok(None) => {}
            Err(e) => {
                return Exit::Status {
                    success: false,
                    describe: format!("its exit couldn't be read: {e}"),
                }
            }
        }
        let now = Instant::now();
        if now >= deadline {
            let pid = tree.pid().as_raw();
            if let Err(e) = kill_hard(tree) {
                warn!(target: "opener", "killing process tree {pid}: {e}");
                let _ = tree.child().kill();
            }
            if let Err(e) = tree.wait() {
                warn!(target: "opener", "reaping process {pid}: {e}");
            }
            return Exit::TimedOut { pid };
        }
        std::thread::sleep(POLL.min(deadline - now));
    }
}

/// Starts the first launcher that spawns. One that fails to spawn is logged and the next is
/// tried; one that spawns but exits non-zero or runs past its limit (only waited rows see
/// either) is an error, not retried.
pub(crate) fn spawn_first(launches: &[Launch], spawner: &dyn Spawn) -> Result<(), OpenError> {
    let mut tried = Vec::new();
    for launch in launches {
        match spawner.start(launch.command(), launch.wait) {
            Ok(Exit::Detached) | Ok(Exit::Status { success: true, .. }) => return Ok(()),
            // It started, so the next launcher isn't tried: it may still be opening this.
            Ok(Exit::TimedOut { .. }) => {
                return Err(OpenError::TimedOut {
                    program: launch.name(),
                    limit: launch.wait.unwrap_or_default(),
                })
            }
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

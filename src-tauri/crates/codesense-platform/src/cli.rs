// SPDX-License-Identifier: MIT
//! Finding a command-line tool: the installs of a name on a `PATH`, in its
//! order, the file names a name stands for (`PATHEXT` on Windows), the
//! package managers' bin directories, which `PATH` to search, and what an npm
//! `.cmd` shim runs.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::fs::{canonicalize, is_executable};

/// Every install of `name` on `path_env` (a `PATH` value), in `PATH` order:
/// `which -a` without a shell. Empty and relative entries are skipped, each
/// directory is tried with [`named_in`], only [`is_executable`] files count,
/// and installs are de-duplicated by canonical path (a link and its target
/// are one install; the first spelling is kept).
pub fn candidates(path_env: &OsStr, name: &str) -> Vec<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(path_env)
        .filter(|dir| dir.is_absolute())
        .collect();
    let mut seen = HashSet::new();
    named_in(&dirs, name)
        .into_iter()
        .filter(|candidate| is_executable(candidate))
        .filter(|candidate| {
            seen.insert(canonicalize(candidate).unwrap_or_else(|_| candidate.clone()))
        })
        .collect()
}

/// The paths `name` stands for in each of `dirs`, in order, without checking
/// them: `dir/name` on unix; on Windows `dir/name` when `name` already has a
/// `PATHEXT` extension, else `dir/name<ext>` for each `PATHEXT` extension in
/// order.
pub fn named_in(dirs: &[PathBuf], name: &str) -> Vec<PathBuf> {
    let names = sys::file_names(name);
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |file| dir.join(file)))
        .collect()
}

/// The bin directories package managers install command-line tools into, in
/// the order they are tried. A directory under the home is left out when the
/// home (or on Windows its variable) is unknown. These are the package
/// managers' directories only: codesense never puts its own binary in them.
pub fn package_dirs() -> Vec<PathBuf> {
    sys::package_dirs()
}

/// The `PATH` to search: on unix `probe`'s answer, the login shell's `$PATH`
/// (`None` when the probe fails); on Windows, which has no login shell, the
/// process `PATH`, without calling `probe`.
pub fn search_path(probe: impl FnOnce() -> Option<String>) -> Option<String> {
    sys::search_path(probe)
}

/// The extension Windows runs `name` by, lower-case and without its dot, read
/// after trimming the trailing dots and spaces Windows drops from a file name
/// (`claude.cmd.` and `claude.cmd ` are `cmd`). `None` when the file name has
/// no dot. A pure string rule, the same on every OS.
pub fn windows_extension(name: &str) -> Option<String> {
    let trimmed = name.trim_end_matches(['.', ' ']);
    let file = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed);
    file.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
}

/// What an npm `.cmd` shim runs, read by [`npm_shim_script`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NpmShim {
    /// cmd-shim's node form: `node` runs this script.
    Node { script: PathBuf },
    /// cmd-shim's direct-program form: this `.exe` runs on its own.
    Exe { program: PathBuf },
}

/// Why a batch file cannot be run as the program its npm shim names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShimError {
    /// The batch file is not one of the npm shim forms [`npm_shim_script`]
    /// accepts.
    NotAnNpmShim { path: PathBuf },
    /// The shim could not be read: missing, unreadable, larger than 64 KiB or
    /// not UTF-8.
    Unreadable { path: PathBuf, reason: String },
    /// A node-form shim with no `node.exe` beside it or on the child's `PATH`.
    NodeNotFound { path: PathBuf },
}

impl std::fmt::Display for ShimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnNpmShim { path } => write!(
                f,
                "{} is a batch file but not an npm shim CodeSense can run",
                path.display()
            ),
            Self::Unreadable { path, reason } => {
                write!(f, "cannot read the npm shim {}: {reason}", path.display())
            }
            Self::NodeNotFound { path } => write!(
                f,
                "the npm shim {} runs node, and there is no node.exe beside it or on PATH",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ShimError {}

/// The most of a shim [`shim_argv`] reads: npm's are under 1 KiB.
const MAX_SHIM_BYTES: u64 = 64 * 1024;

/// The lines every cmd-shim 9 `.cmd` file starts with (`tests/fixtures/npm-shims`).
const SHIM_HEAD: [&str; 8] = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
];

/// The node form's lines between the head and its launch line: `_prog` is
/// `node.exe` beside the shim, else `node`.
const NODE_BODY: [&str; 7] = [
    "",
    r#"IF EXIST "%dp0%\node.exe" ("#,
    r#"  SET "_prog=%dp0%\node.exe""#,
    ") ELSE (",
    r#"  SET "_prog=node""#,
    ")",
    "",
];

/// The node form's launch line around the script's relative path.
const NODE_LAUNCH: (&str, &str) = (
    r#"endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\"#,
    r#"" %*"#,
);

/// The direct-program form's launch line around the program's relative path.
const DIRECT_LAUNCH: (&str, &str) = (r#""%dp0%\"#, r#""   %*"#);

/// What the npm shim `shim` runs, read from its `text`: `Ok(None)` when
/// `shim` is not a batch file ([`windows_extension`] is not `cmd` or `bat`).
///
/// Accepts only the two forms cmd-shim 9 writes for a global install, matched
/// line for line against `tests/fixtures/npm-shims` with LF or CRLF line ends
/// and the relative path the only part that varies: the node form (the script
/// `shim_dir\<relative>` runs under `node`) and the direct-program form when
/// `<relative>` is an `.exe` (`shim_dir\<relative>` runs as itself). The
/// relative path must stay inside the shim's directory tree, checked as text
/// before any file is touched: split on `\` and `/`, no segment may be empty
/// or only dots and spaces (`..`, `.`, a leading separator), and it may not
/// hold `:` (a drive or a stream), `%`, `!`, `"` or a control character. So
/// the shim's text never chooses the interpreter, nor a file outside its
/// tree. Anything else is [`ShimError::NotAnNpmShim`].
pub fn npm_shim_script(shim: &Path, text: &str) -> Result<Option<NpmShim>, ShimError> {
    if !is_batch(shim) {
        return Ok(None);
    }
    let refused = || ShimError::NotAnNpmShim {
        path: shim.to_path_buf(),
    };
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    // The text ends with a line end, so its last piece is empty.
    let Some((&"", lines)) = lines.split_last() else {
        return Err(refused());
    };
    let body = lines.strip_prefix(&SHIM_HEAD[..]).ok_or_else(refused)?;
    let dir = shim.parent().unwrap_or(Path::new(""));
    match body {
        [launch] => {
            let relative = launch_target(launch, DIRECT_LAUNCH)
                .filter(|relative| windows_extension(relative).as_deref() == Some("exe"))
                .ok_or_else(refused)?;
            Ok(Some(NpmShim::Exe {
                program: dir.join(relative),
            }))
        }
        [node @ .., launch] if node == NODE_BODY => {
            let relative = launch_target(launch, NODE_LAUNCH).ok_or_else(refused)?;
            Ok(Some(NpmShim::Node {
                script: dir.join(relative),
            }))
        }
        _ => Err(refused()),
    }
}

/// The relative path `line` launches between `prefix` and `suffix`, when it
/// stays inside the shim's directory tree (see [`npm_shim_script`]).
fn launch_target<'a>(line: &'a str, (prefix, suffix): (&str, &str)) -> Option<&'a str> {
    let relative = line.strip_prefix(prefix)?.strip_suffix(suffix)?;
    let contained = !relative.contains([':', '%', '!', '"'])
        && !relative.contains(char::is_control)
        && relative
            .split(['\\', '/'])
            .all(|segment| !segment.trim_end_matches(['.', ' ']).is_empty());
    contained.then_some(relative)
}

/// Whether Windows would run `path` through `cmd.exe`: a `.cmd` or `.bat`.
fn is_batch(path: &Path) -> bool {
    matches!(
        windows_extension(&path.to_string_lossy()).as_deref(),
        Some("cmd" | "bat")
    )
}

/// The argv that runs what the npm shim `program` runs, with `args` after it:
/// `Ok(None)` when `program` is not a batch file, which is not read.
///
/// A direct-program shim is `[<program>, args…]`. A node-form shim is
/// `[node, <script>, args…]`, where `node` is `node.exe` beside the shim when
/// that file exists, else the first `node.exe` [`candidates`] finds on
/// `path_env` (the child's `PATH`), so a `node.cmd` or `node.bat` earlier on
/// it never runs. The shim is read up to 64 KiB; a larger, unreadable or
/// non-UTF-8 one is [`ShimError::Unreadable`], and any form
/// [`npm_shim_script`] refuses is [`ShimError::NotAnNpmShim`].
pub fn shim_argv(
    program: &Path,
    args: &[impl AsRef<OsStr>],
    path_env: &OsStr,
) -> Result<Option<Vec<OsString>>, ShimError> {
    if !is_batch(program) {
        return Ok(None);
    }
    let text = read_shim(program)?;
    let mut argv = match npm_shim_script(program, &text)? {
        None => return Ok(None),
        Some(NpmShim::Exe { program }) => vec![program.into_os_string()],
        Some(NpmShim::Node { script }) => vec![
            shim_node(program, path_env)?.into_os_string(),
            script.into_os_string(),
        ],
    };
    argv.extend(args.iter().map(|arg| arg.as_ref().to_os_string()));
    Ok(Some(argv))
}

/// The shim's text, read up to [`MAX_SHIM_BYTES`].
fn read_shim(path: &Path) -> Result<String, ShimError> {
    let unreadable = |reason: String| ShimError::Unreadable {
        path: path.to_path_buf(),
        reason,
    };
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_SHIM_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| unreadable(error.to_string()))?;
    if bytes.len() as u64 > MAX_SHIM_BYTES {
        return Err(unreadable(format!(
            "larger than {} KiB",
            MAX_SHIM_BYTES / 1024
        )));
    }
    String::from_utf8(bytes).map_err(|_| unreadable("not UTF-8".to_string()))
}

/// The `node.exe` a node-form `shim` runs under (see [`shim_argv`]).
fn shim_node(shim: &Path, path_env: &OsStr) -> Result<PathBuf, ShimError> {
    if let Some(beside) = shim
        .parent()
        .map(|dir| dir.join("node.exe"))
        .filter(|node| node.is_file())
    {
        return Ok(beside);
    }
    candidates(path_env, "node.exe")
        .into_iter()
        .next()
        .ok_or_else(|| ShimError::NodeNotFound {
            path: shim.to_path_buf(),
        })
}

#[cfg(unix)]
mod sys {
    use std::path::PathBuf;

    pub(super) fn file_names(name: &str) -> Vec<String> {
        vec![name.to_owned()]
    }

    pub(super) fn package_dirs() -> Vec<PathBuf> {
        let mut dirs = vec![
            PathBuf::from("/opt/homebrew/bin"), // Homebrew (Apple silicon)
            PathBuf::from("/usr/local/bin"),    // Homebrew (Intel) / manual
        ];
        if let Some(home) = ::dirs::home_dir() {
            dirs.push(home.join(".local/bin")); // pipx / user-local
            dirs.push(home.join(".npm-global/bin")); // npm -g custom prefix
            dirs.push(home.join(".bun/bin")); // bun global
            dirs.push(home.join("Library/pnpm")); // pnpm global (macOS)
            dirs.push(home.join(".local/share/pnpm")); // pnpm global (xdg)
        }
        dirs
    }

    pub(super) fn search_path(probe: impl FnOnce() -> Option<String>) -> Option<String> {
        probe()
    }
}

#[cfg(windows)]
mod sys {
    use std::path::{Path, PathBuf};

    use crate::win::{has_pathext, pathext};

    pub(super) fn file_names(name: &str) -> Vec<String> {
        if has_pathext(Path::new(name)) {
            return vec![name.to_owned()];
        }
        pathext()
            .into_iter()
            .map(|ext| format!("{name}{ext}"))
            .collect()
    }

    pub(super) fn package_dirs() -> Vec<PathBuf> {
        let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
        let home = ::dirs::home_dir();
        [
            var("APPDATA").map(|dir| PathBuf::from(dir).join("npm")), // npm -g
            home.as_ref().map(|home| home.join(r"scoop\shims")),      // Scoop
            var("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join(r"Microsoft\WinGet\Links")), // WinGet
            home.as_ref().map(|home| home.join(r".bun\bin")), // bun global
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    pub(super) fn search_path(_probe: impl FnOnce() -> Option<String>) -> Option<String> {
        std::env::var("PATH").ok()
    }
}

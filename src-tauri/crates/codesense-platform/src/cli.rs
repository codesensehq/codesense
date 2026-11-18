// SPDX-License-Identifier: MIT
//! Finding a command-line tool: the installs of a name on a `PATH`, in its
//! order, the file names a name stands for (`PATHEXT` on Windows), the
//! package managers' bin directories and which `PATH` to search.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::PathBuf;

use crate::fs::{canonicalize, is_executable};

/// Every install of `name` on `path_env` (a `PATH` value), in `PATH` order:
/// `which -a` without a shell. Empty and relative entries are skipped, each
/// directory is tried with [`named_in`], only [`is_executable`] files count,
/// and installs are de-duplicated by canonical path (a link and its target
/// are one install; the first spelling is kept).
pub fn candidates(path_env: &OsStr, name: &str) -> Vec<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(path_env)
        .filter(|dir| !dir.as_os_str().is_empty() && dir.is_absolute())
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

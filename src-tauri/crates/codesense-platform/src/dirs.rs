// SPDX-License-Identifier: MIT
//! Where CodeSense keeps its user-scoped data and its shared lock files.

use std::io;
#[cfg(any(windows, test))]
use std::path::Path;
use std::path::PathBuf;

/// `~/.codesense` on every OS (`%USERPROFILE%\.codesense` on Windows): agent
/// MCP configs and the docs name it, so it never moves to a per-OS data dir.
/// `None` when the home directory cannot be found.
pub fn codesense_home() -> Option<PathBuf> {
    ::dirs::home_dir().map(|h| h.join(".codesense"))
}

/// The directory where lock files that several processes of this user meet
/// on live (the app and its session server, say), there to use. Unix:
/// `/tmp`. Windows: `<codesense home>\locks`, made owner-only when it is
/// missing (a fresh install has none), never the temp directory, which
/// follows `TMP` and `TEMP` and so could differ between two processes.
/// `NotFound` when the home directory cannot be found.
pub fn lock_dir() -> io::Result<PathBuf> {
    shared_lock_dir()
}

#[cfg(unix)]
fn shared_lock_dir() -> io::Result<PathBuf> {
    Ok(PathBuf::from("/tmp"))
}

#[cfg(windows)]
fn shared_lock_dir() -> io::Result<PathBuf> {
    let home = codesense_home()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
    locks_in(&home)
}

/// `home`'s `locks` directory, made owner-only when missing. `home` is made
/// plainly if it is missing too: it holds more than locks.
#[cfg(any(windows, test))]
fn locks_in(home: &Path) -> io::Result<PathBuf> {
    let dir = home.join("locks");
    if !dir.is_dir() {
        std::fs::create_dir_all(home)?;
        crate::fs::create_dir_owner_only(&dir)?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_lock_directory_is_made_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let dir = locks_in(&home).unwrap();
        assert_eq!(dir, home.join("locks"));
        let options = &mut std::fs::OpenOptions::new();
        let opened = crate::fs::open_nofollow(options.read(true), &dir).unwrap();
        assert!(crate::fs::is_owner_only(&opened).unwrap());
        assert_eq!(locks_in(&home).unwrap(), dir, "an existing one is kept");
    }
}

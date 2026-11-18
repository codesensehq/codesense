// SPDX-License-Identifier: MIT
//! Where CodeSense keeps its user-scoped data and its shared lock files.

use std::path::PathBuf;

/// `~/.codesense` on every OS (`%USERPROFILE%\.codesense` on Windows): agent
/// MCP configs and the docs name it, so it never moves to a per-OS data dir.
/// `None` when the home directory cannot be found.
pub fn codesense_home() -> Option<PathBuf> {
    ::dirs::home_dir().map(|h| h.join(".codesense"))
}

/// The directory where lock files that several processes of this user meet
/// on live (the app and its session server, say). Unix: `/tmp`, as always.
/// Windows: `<codesense home>\locks`, never the temp directory, which
/// follows `TMP` and `TEMP` and so could differ between two processes.
/// `None` when the home directory cannot be found. It may not exist yet:
/// create it with [`crate::fs::create_dir_owner_only`].
pub fn lock_dir() -> Option<PathBuf> {
    shared_lock_dir()
}

#[cfg(unix)]
fn shared_lock_dir() -> Option<PathBuf> {
    Some(PathBuf::from("/tmp"))
}

#[cfg(windows)]
fn shared_lock_dir() -> Option<PathBuf> {
    codesense_home().map(|home| home.join("locks"))
}

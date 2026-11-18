// SPDX-License-Identifier: MIT
//! Where CodeSense keeps its user-scoped data.

use std::path::PathBuf;

/// `~/.codesense` on every OS (`%USERPROFILE%\.codesense` on Windows): agent
/// MCP configs and the docs name it, so it never moves to a per-OS data dir.
/// `None` when the home directory cannot be found.
pub fn codesense_home() -> Option<PathBuf> {
    ::dirs::home_dir().map(|h| h.join(".codesense"))
}

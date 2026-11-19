// SPDX-License-Identifier: MIT
//! A CLI's engine where its Unix-socket keeper is not ported: no engine starts, so a CLI
//! runs as given, and the helper verbs fail as capability-off.
use super::{Binding, EngineLaunch};
use std::ffi::OsString;
use std::io;
use std::path::Path;

pub(super) fn exec_on_engine(_args: &[OsString]) -> io::Error {
    crate::caps_off("mcp-bridge")
}

pub(super) fn start_engine(_launch: &EngineLaunch, _binding: &Binding) -> Option<Vec<String>> {
    None
}

/// No engine serves at a socket here.
pub(super) fn is_socket(_path: &Path) -> bool {
    false
}

/// The status a keeper whose engine could not start ends with.
pub(super) fn keep_engine(_args: &[OsString]) -> i32 {
    1
}

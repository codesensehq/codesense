// SPDX-License-Identifier: MIT
//! The launch helper's exec verbs and the `--version` probe where they are not ported
//! yet: a verb fails as capability-off, and the probe qualifies nothing (the CLI runs
//! unqualified), saying nothing.
use crate::agent_cli::version_cache::RuntimeIdentity;
use crate::agent_cli::AgentCliAdapter;
use std::ffi::OsString;
use std::io;
use std::path::Path;

pub fn exec_managed_shell(_args: &[OsString]) -> io::Error {
    crate::caps_off("mcp-bridge")
}

pub fn exec_claimed(_args: &[OsString]) -> io::Error {
    crate::caps_off("mcp-bridge")
}

pub(super) fn version_probe(
    _program: &std::ffi::OsStr,
    _adapter: &dyn AgentCliAdapter,
    _runtime: Option<&Path>,
    _identity: Option<&RuntimeIdentity>,
    _budget: std::time::Duration,
) -> Option<bool> {
    None
}

// SPDX-License-Identifier: MIT
//! The Hermes managed runtime where the `agent-cli-sockets` capability is
//! off. A Hermes TUI session needs the Hermes gateway, which that capability
//! gates, so a launch fails closed before any home is seeded, and there is
//! nothing to tear down or sweep.

use std::path::Path;

pub(super) fn seed_home(_home: &Path, _program: &Path) -> Result<Vec<(String, String)>, String> {
    Err(codesense_pty_core::caps_off("agent-cli-sockets").to_string())
}

pub(crate) fn teardown_home(_home: &Path) {}

pub(crate) fn sweep(_scopes: &Path) {}

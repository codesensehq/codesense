// SPDX-License-Identifier: MIT
//! Codex's engine transport where Unix sockets are not available yet: a connect is
//! refused as the `agent-cli-sockets` capability being off.

use super::*;

/// [`super::connect`]'s transport: the capability is off.
pub(super) fn connect(_endpoint: &Path, _session: Option<&str>) -> io::Result<Box<dyn Channel>> {
    Err(crate::caps_off("agent-cli-sockets"))
}

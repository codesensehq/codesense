// SPDX-License-Identifier: MIT
//! The gateway's sockets where Unix sockets are not available yet: every call is
//! refused as the `agent-cli-sockets` capability being off.
use super::*;
use tungstenite::handshake::client::Request;

pub(super) fn call(_path: &Path, _home: &fs::File, _request: &[u8]) -> io::Result<String> {
    Err(crate::caps_off("agent-cli-sockets"))
}

pub(super) fn connect(
    _endpoint: &Path,
    _request: Request,
    _session: Option<&str>,
    _hooks_ready: impl FnOnce() -> bool,
) -> io::Result<Box<dyn Channel>> {
    Err(crate::caps_off("agent-cli-sockets"))
}

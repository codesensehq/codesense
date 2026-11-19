// SPDX-License-Identifier: MIT
//! An inbox hook's wait where its Unix socket is not ported: no helper reaches its host,
//! so none is served, and a hook hands nothing over and exits 0, as one with no
//! CodeSense invocation does.
use super::Ask;
use crate::activity::ingress::Connection;
use crate::activity::ActivityOwner;
use codesense_platform::process::Identity as Process;

pub(super) fn serve(
    _owner: &ActivityOwner,
    stream: Connection,
    _peer: Process,
    _token: &str,
    _ask: Ask,
) {
    match stream {}
}

pub fn wait_from_hook(_args: &[std::ffi::OsString]) -> i32 {
    0
}

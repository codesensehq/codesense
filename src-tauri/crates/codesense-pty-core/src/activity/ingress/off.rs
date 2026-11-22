// SPDX-License-Identifier: MIT
//! The activity ingress where its Unix socket is not available: no service starts (the
//! host takes the path a failed start takes), and every helper verb fails as one whose
//! host can't be reached does. The named-pipe port replaces this file.
use super::{Claimed, HelperLink};
use crate::activity::{inbox, ActivityOwner};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn off() -> io::Error {
    crate::caps_off("mcp-bridge")
}

/// Never started here: [`Self::start`] fails, so a host has no activity service.
pub struct ActivityService {}

impl ActivityService {
    pub fn start(
        _root: &Path,
        _owner: &Arc<ActivityOwner>,
        _bridge: Option<&Path>,
    ) -> io::Result<Self> {
        Err(off())
    }

    pub fn start_with(
        _root: &Path,
        _owner: &Arc<ActivityOwner>,
        _bridge: Option<&Path>,
        _link: HelperLink,
    ) -> io::Result<Self> {
        Err(off())
    }

    pub fn path(&self) -> &Path {
        Path::new("")
    }

    pub fn shell_env(&self) -> Option<(&'static str, String)> {
        None
    }
}

/// No helper connects to its host here.
pub(crate) enum Connection {}

pub fn report_from_stdin() -> io::Result<()> {
    Err(off())
}

pub(super) fn bind_shell(_socket: &Path, _token: &str, _batch: bool) -> io::Result<()> {
    Err(off())
}

pub(super) fn engine_lost(_socket: &Path, _token: &str) -> io::Result<()> {
    Err(off())
}

pub(super) fn require_inbox_update(_socket: &Path, _token: &str) -> io::Result<()> {
    Err(off())
}

pub(super) fn claim_shell(
    _socket: &Path,
    _provider: crate::agent_cli::AgentCli,
    _batch: bool,
) -> io::Result<Claimed> {
    Err(off())
}

pub(super) fn bind_engine(
    _socket: &Path,
    _token: &str,
    _pid: u32,
    _endpoint: &Path,
    _home: Option<PathBuf>,
) -> io::Result<()> {
    Err(off())
}

pub(super) fn ask_inbox(_socket: &Path, _token: &str, _ask: inbox::Ask) -> io::Result<Connection> {
    Err(off())
}

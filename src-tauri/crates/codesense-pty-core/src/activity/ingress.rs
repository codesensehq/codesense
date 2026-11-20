// SPDX-License-Identifier: MIT
//! The activity ingress: what a host's helper reports, binds and asks, and the service
//! that serves it. The transport is a Unix socket for now, gated below until the
//! named-pipe port; with no service, spawns get no ingress and the host reports no activity.
use super::Report;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg_attr(unix, path = "ingress/unix.rs")]
#[cfg_attr(not(unix), path = "ingress/off.rs")]
mod transport;

pub use transport::ActivityService;
/// A helper's connection to its host, once it asked for its agent's inbox notice.
pub(super) use transport::Connection;

pub const SOCKET_ENV: &str = "CODESENSE_ACTIVITY_SOCKET";
pub const TOKEN_ENV: &str = "CODESENSE_ACTIVITY_TOKEN";
/// A terminal's host activity root, exported to every shell it runs. It is
/// stable for the host's install, so a shell opened before the app restarted
/// still reaches its host: the root holds the socket, [`HELPER_NAME`] and the
/// bridge Claude's hooks run (`crate::notify_hook`).
pub const HOST_ENV: &str = codesense_host_proto::hook::HOST_ENV;
/// The host's own helper, refreshed under its root at every start.
pub const HELPER_NAME: &str = "activity-helper";
const SOCKET_NAME: &str = "activity.sock";
/// How often open turns are checked for having gone quiet.
const DECAY_INTERVAL: Duration = Duration::from_secs(1);
const MAX_REPORT: usize = 16 * 1024;
const INPUT_LIMIT: u64 = 1024 * 1024;
const BUDGET: Duration = Duration::from_millis(250);
const MAX_CONNECTIONS: usize = 32;
/// The most inbox hooks a host serves at once: far more than its tabs' agents arm, one
/// waiter each.
const MAX_INBOX_WAITERS: usize = 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    token: String,
    deadline_ns: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<Report>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bind: Option<Bind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claim: Option<crate::agent_cli::AgentCli>,
    /// The CLI runs one-shot (`claude -p`, `codex exec`), drawing nothing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    batch: bool,
    /// An inbox hook's helper asks to be handed its agent's mail notice; the connection
    /// then speaks the waiter's lines (`codesense_host_proto::inbox_wait`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inbox: Option<super::inbox::Ask>,
    /// The launch helper names the engine it started under its CLI, and the socket it
    /// serves on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<EngineBind>,
}

impl Envelope {
    /// The one operation it carries, as `connect_and_send` put it: `None` for none or
    /// more than one, or a one-shot mark on an engine.
    fn into_operation(self) -> Option<Operation> {
        let batch = self.batch;
        match (self.report, self.bind, self.claim, self.inbox, self.engine) {
            (Some(report), None, None, None, None) => Some(Operation::Report { report }),
            (None, Some(bind), None, None, None) => Some(Operation::Bind { bind, batch }),
            (None, None, Some(provider), None, None) => Some(Operation::Claim { provider, batch }),
            (None, None, None, Some(ask), None) => Some(Operation::Inbox { ask }),
            (None, None, None, None, Some(engine)) if !batch => Some(Operation::Engine { engine }),
            _ => None,
        }
    }
}

/// An engine its launch helper started, under the CLI it is about to become.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EngineBind {
    #[serde(default)]
    home: Option<PathBuf>,
    pid: u32,
    endpoint: PathBuf,
}

/// What a claim hands its CLI's launcher: the invocation's writer token and
/// the private directory its generated settings go in.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Claimed {
    pub token: String,
    pub directory: PathBuf,
}

enum Operation {
    Report {
        report: Report,
    },
    Bind {
        bind: Bind,
        batch: bool,
    },
    Claim {
        provider: crate::agent_cli::AgentCli,
        batch: bool,
    },
    Inbox {
        ask: super::inbox::Ask,
    },
    Engine {
        engine: EngineBind,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Bind {
    ManagedShellInvocation,
    InboxUpdateRequired,
    EngineLost,
}

/// How the shells' helper names this binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperLink {
    /// A hard link: pins this very build (a symbolic link across filesystems).
    Hard,
    /// A symbolic link only: for an install that must keep one link per file.
    Symbolic,
}

/// One bounded attempt; callers exit neutrally even if delivery fails. This
/// entry accepts only the normalized whitelist, never raw provider content.
pub fn report_from_stdin() -> io::Result<()> {
    transport::report_from_stdin()
}

pub(super) fn bind_shell(socket: &Path, token: &str, batch: bool) -> io::Result<()> {
    transport::bind_shell(socket, token, batch)
}

pub(super) fn engine_lost(socket: &Path, token: &str) -> io::Result<()> {
    transport::engine_lost(socket, token)
}

pub(super) fn require_inbox_update(socket: &Path, token: &str) -> io::Result<()> {
    transport::require_inbox_update(socket, token)
}

/// Claim an invocation for the CLI this process is about to become, as a
/// process running under one of the host's shells.
pub(super) fn claim_shell(
    socket: &Path,
    provider: crate::agent_cli::AgentCli,
    batch: bool,
) -> io::Result<Claimed> {
    transport::claim_shell(socket, provider, batch)
}

/// Names the engine `pid`, serving on `endpoint`, that this process (its launch helper,
/// about to become the CLI `token` names) started under itself.
pub(super) fn bind_engine(
    socket: &Path,
    token: &str,
    pid: u32,
    endpoint: &Path,
    home: Option<PathBuf>,
) -> io::Result<()> {
    transport::bind_engine(socket, token, pid, endpoint, home)
}

/// An inbox hook's helper's connection to its host, `token` naming its CLI's invocation,
/// once it asked: the host's answer follows as the waiter's lines.
pub(super) fn ask_inbox(
    socket: &Path,
    token: &str,
    ask: super::inbox::Ask,
) -> io::Result<Connection> {
    transport::ask_inbox(socket, token, ask)
}

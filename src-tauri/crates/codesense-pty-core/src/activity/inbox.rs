// SPDX-License-Identifier: MIT
//! An agent's inbox hook and its host: the hook runs the host's helper
//! (`--inbox-wait <cli> <event> <agent>`, see
//! [`inbox_hook_command`](crate::agent_cli::inbox_hook_command)), which asks this host's
//! activity ingress, with its CLI's writer token, to be handed the agent's mail notice.
//! The host admits it only from the agent process it named for that invocation
//! ([`ActivityOwner::inbox_admission`]); a helper that asks before the invocation is
//! committed is held for the commit, never ranked. The wait itself is the host inbox's
//! ([`crate::inbox_host::HostInbox::serve`]).
//!
//! Trust boundary: admission rests on process ancestry and the invocation's activity
//! token. A process running as the same user can give a child a parent of its choosing
//! (on Windows, `PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`) and so pose as running under the
//! agent, but it still needs the token from the agent's environment. Same-user code is
//! inside the trust boundary on every OS: it can read the agent's environment and memory
//! too.

use serde::{Deserialize, Serialize};

use super::ingress::Connection;
use super::ActivityOwner;
use codesense_platform::process::Identity as Process;

#[cfg_attr(unix, path = "inbox/unix.rs")]
#[cfg_attr(not(unix), path = "inbox/off.rs")]
mod transport;

/// What an inbox hook's helper asks its host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Ask {
    /// The CLI hook event that ran it.
    event: String,
    /// The CLI process that ran the hook (`$PPID`, or the parent of the shell that ran
    /// the helper): the session's agent, or refused.
    agent: u32,
    /// The prompt the hook's CLI submitted, when the hook carries one: it settles a
    /// submitted notice whose delivery was uncertain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    /// Native provider receipts; only a confirmation-capable admitted hook may settle them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    receipts: Vec<String>,
    /// The CLI session the hook names, when its input carries one: it tells the agent's
    /// own hooks from a nested CLI's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
}

/// Host side: serves the helper on `stream` (kernel-verified as `peer`), asking with
/// `token` as `ask` says.
pub(super) fn serve(
    owner: &ActivityOwner,
    stream: Connection,
    peer: Process,
    token: &str,
    ask: Ask,
) {
    transport::serve(owner, stream, peer, token, ask)
}

/// Helper side, from the hook's argv (`<cli> <event> <agent>`, the agent a pid,
/// [`INBOX_AGENT_OF_SHELL`](crate::agent_cli::INBOX_AGENT_OF_SHELL), or by default the
/// helper's parent): waits for the agent's mail notice at the host its tab runs on (a host-submitted CLI's hook only
/// looks once), and hands it to the CLI as its inbox port says. Returns the hook's exit
/// status: 2 for a notice handed over as a rewake, 0 for anything else. A CLI with no
/// CodeSense invocation (no activity token, as a run with no terminal) has no waiter.
pub fn wait_from_hook(args: &[std::ffi::OsString]) -> i32 {
    transport::wait_from_hook(args)
}

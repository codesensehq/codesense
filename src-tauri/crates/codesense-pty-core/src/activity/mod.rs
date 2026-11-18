// SPDX-License-Identifier: MIT
//! Bounded observational activity owned by the same lifetime as the PTY.
//! A writer capability conveys no terminal or MCP authority.

pub mod arbiter;
mod engine;
mod hook_block;
mod inbox;
mod ingress;
mod launch;
mod owner;
#[cfg(all(test, unix))]
mod peer_tests;
mod subagents;

pub use codesense_host_proto::activity::*;

/// Host-only end cause. Provider reports cannot submit it through the reason allowlist.
pub const ENGINE_STOPPED: &str = "engine_stopped";

pub fn end_reason(snapshot: &Snapshot) -> Option<String> {
    (snapshot.exit.is_some() && snapshot.reason.as_deref() == Some(ENGINE_STOPPED)).then(|| {
        format!("{}'s engine stopped, so this session was ended to keep CodeSense's identity checks safe. Relaunch to continue.",
            crate::agent_cli::adapter(snapshot.provider).descriptor().name)
    })
}
use engine::{exec_on_engine, keep_engine, KEEPER_ARG};
pub use engine::{launch_argv, ENGINE_ARG};
#[cfg(any(test, feature = "test-support"))]
pub use engine::{launch_of, EngineLaunch};
pub use ingress::{
    report_from_stdin, ActivityService, HelperLink, HELPER_NAME, HOST_ENV, SOCKET_ENV, TOKEN_ENV,
};
pub use launch::{
    exec_claimed, exec_managed_shell, fold_launch_settings, prepare_direct, prepare_shell_launch,
    write_home_config,
};
pub use owner::{ActivityOwner, QUIET_TURN};

/// Set to `1` in the environment of a CLI whose activity probe qualified its release
/// ([`ActivityProbe::Version`](crate::agent_cli::ActivityProbe::Version)), so its hooks'
/// reports are read as naming its main turn.
/// `0` records a known unsupported release; absent means the probe did not qualify it.
pub const RELEASE_QUALIFIED_ENV: &str = "CODESENSE_ACTIVITY_RELEASE_QUALIFIED";

/// The kernel-verified process on the other end of a Unix socket, for a
/// transport that binds a caller to the session it runs in (a local
/// MCP caller's tool calls act for its own tab only). A pid is never an
/// identity alone: a process is its pid plus its start time.
pub mod peer {
    use codesense_platform::process::Identity;

    /// A live process: pid and start time.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct PeerProcess(Identity);

    impl PeerProcess {
        pub(super) fn of(process: Identity) -> Self {
            Self(process)
        }

        pub fn pid(&self) -> u32 {
            self.0.pid
        }

        /// Compare the kernel process birth time with a managed directory's creation.
        pub fn started_after(&self, time: std::time::SystemTime) -> bool {
            self.0.started_after(time)
        }
    }

    /// The process on the other end of `socket`, when it runs as this user.
    #[cfg(unix)]
    pub fn of_socket(socket: &impl std::os::fd::AsRawFd) -> Option<PeerProcess> {
        Identity::of_unix_peer(socket).map(PeerProcess)
    }

    /// The live process `pid`.
    pub fn inspect(pid: u32) -> Option<PeerProcess> {
        Identity::inspect(pid).map(PeerProcess)
    }

    /// Whether the live `peer` is `root` or currently runs under it. A cached
    /// parent is not proof: verify the original identity and walk fresh ancestry.
    pub fn descends_from(peer: PeerProcess, root: PeerProcess) -> bool {
        Identity::inspect(peer.0.pid)
            .filter(|current| current.is(peer.0))
            .is_some_and(|current| current.descends_from(root.0))
    }

    /// Whether `process` still runs: its pid reads as a live process (not a zombie) with
    /// the same start time, whatever its parent is now.
    pub fn runs(process: PeerProcess) -> bool {
        process.0.runs()
    }
}

/// Both packaged entry points take this fast path before starting an app/host.
pub fn run_helper() -> bool {
    match std::env::args_os().nth(1).as_deref() {
        // A PTY child's open-file limit, set in the child before
        // anything else runs here (no logging, no descriptors).
        Some(argument) if argument == crate::nofile::EXEC_ARG => {
            let arguments: Vec<_> = std::env::args_os().skip(2).collect();
            let error = crate::nofile::exec_with_limit(&arguments);
            eprintln!("the command could not be started: {error}");
            std::process::exit(127);
        }
        Some(argument) if argument == "--hook-block" => {
            let cli = std::env::args_os().nth(2);
            std::process::exit(hook_block::run(cli.as_deref()));
        }
        Some(argument) if argument == "--activity-hook" => {
            let _ = report_from_stdin();
            true
        }
        Some(argument) if argument == "--activity-run" => {
            let arguments: Vec<_> = std::env::args_os().skip(2).collect();
            let _ = exec_claimed(&arguments);
            eprintln!("agent executable could not be started");
            std::process::exit(127);
        }
        Some(argument) if argument == crate::agent_cli::INBOX_WAIT_ARG => {
            let arguments: Vec<_> = std::env::args_os().skip(2).collect();
            std::process::exit(inbox::wait_from_hook(&arguments));
        }
        Some(argument) if argument == "--activity-exec" => {
            let arguments: Vec<_> = std::env::args_os().skip(2).collect();
            let _ = exec_managed_shell(&arguments);
            eprintln!("managed agent executable could not be started");
            std::process::exit(127);
        }
        Some(argument) if argument == ENGINE_ARG => {
            let arguments: Vec<_> = std::env::args_os().skip(2).collect();
            let _ = exec_on_engine(&arguments);
            eprintln!("agent executable could not be started");
            std::process::exit(127);
        }
        Some(argument) if argument == KEEPER_ARG => {
            let arguments: Vec<_> = std::env::args_os().skip(2).collect();
            std::process::exit(keep_engine(&arguments));
        }
        _ => false,
    }
}

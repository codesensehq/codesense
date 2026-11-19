// SPDX-License-Identifier: MIT
//! The session-server sidecar as a library: process detachment, the host of the
//! `codesense-pty-core` runtime, the socket server, and the `attach --stdio`
//! relay that reaches it from another machine — plus what a client needs to
//! put it on a machine over SSH (`install`) and to tell whether it survives
//! logout there (`survival`), how to reach it with the system `ssh` (`ssh`,
//! `check`) and how that `ssh` gets a key's passphrase (`askpass`). The
//! `codesense-session-server` binary is a thin `main` over this; tests drive
//! it in-process.
//!
//! The sidecar's modules compile where the app's `terminal-server-sidecar`
//! capability is on, and the remote-machine client's where `remote-machines`
//! is. `machine_owner` and `portable` compile on every target; `portable`
//! holds what the app reads from gated modules, and a stand-in module keeps
//! each of those items at its old path when its module is gated off.

// The remote-machine client reaches a machine with the sidecar's `install` and
// `askpass`, so it needs the sidecar compiled.
#[cfg(all(cap_remote_machines, not(cap_terminal_server_sidecar)))]
compile_error!(
    "the remote-machines capability needs terminal-server-sidecar: the remote modules use install and askpass"
);

#[cfg(cap_terminal_server_sidecar)]
pub mod askpass;
#[cfg(cap_terminal_server_sidecar)]
pub mod attach;
#[cfg(cap_remote_machines)]
pub mod check;
#[cfg(cap_terminal_server_sidecar)]
pub mod detach;
#[cfg(cap_terminal_server_sidecar)]
pub mod disconnect_log;
#[cfg(cap_terminal_server_sidecar)]
pub mod exit_with;
#[cfg(cap_terminal_server_sidecar)]
pub mod host;
#[cfg(cap_terminal_server_sidecar)]
pub mod install;
#[cfg(cap_remote_machines)]
pub mod private_account;
#[cfg(cap_remote_machines)]
mod private_account_data;
#[cfg(cap_terminal_server_sidecar)]
#[cfg(target_os = "linux")]
pub mod private_account_native;
#[cfg(cap_terminal_server_sidecar)]
#[cfg(target_os = "linux")]
pub mod replace;
#[cfg(cap_terminal_server_sidecar)]
#[cfg(any(target_os = "linux", test))]
mod replacement_data;
#[cfg(cap_terminal_server_sidecar)]
mod replacement_evidence;
#[cfg(cap_terminal_server_sidecar)]
pub mod routine_arm;
#[cfg(cap_terminal_server_sidecar)]
pub mod server;
#[cfg(cap_terminal_server_sidecar)]
pub mod session_wake;
#[cfg(cap_remote_machines)]
pub mod ssh;
#[cfg(cap_terminal_server_sidecar)]
pub mod stop;
#[cfg(cap_terminal_server_sidecar)]
pub mod survival;
#[cfg(cap_terminal_server_sidecar)]
#[cfg(any(test, feature = "test-support"))]
pub mod testing;
#[cfg(cap_terminal_server_sidecar)]
pub mod usage_receiver;
#[cfg(cap_terminal_server_sidecar)]
pub mod usage_spool;

#[cfg(cap_terminal_server_sidecar)]
#[cfg(test)]
mod tests;

#[cfg(cap_terminal_server_sidecar)]
#[cfg(target_os = "linux")]
pub mod reverse_mcp;

#[cfg(cap_terminal_server_sidecar)]
mod remote_workspace;

#[cfg(cap_terminal_server_sidecar)]
#[cfg(unix)]
mod native_launch;

pub mod machine_owner;
#[cfg(cap_terminal_server_sidecar)]
mod machine_stats;
#[cfg(cap_terminal_server_sidecar)]
pub mod offline_mcp;
#[cfg(cap_terminal_server_sidecar)]
#[cfg(target_os = "linux")]
mod owned_supervisors;

mod portable;
// Stand-ins that keep the app's items at their paths when their modules are
// gated off (see `portable`).
#[cfg(not(cap_terminal_server_sidecar))]
pub mod session_wake {
    pub use crate::portable::AGENT_QUIT_GRACE_MS;
}
#[cfg(not(cap_remote_machines))]
pub mod private_account {
    pub use crate::portable::UPLOAD_STEP;
}

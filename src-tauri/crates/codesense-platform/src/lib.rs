// SPDX-License-Identifier: MIT
//! The one place OS-specific mechanisms live. Each module answers *how* on
//! this OS (end a process tree, make a file private, replace it atomically,
//! find the codesense home); callers keep *what* and *when*.
//!
//! Unix arms are the code they were copied from, with the same syscalls,
//! flags, modes and paths, so macOS and Linux behave as before. Windows arms
//! use std where it has the mechanism and `windows-sys` where it does not.
//!
//! - [`process`]: a [`process::ProcessTree`] ended as a whole, the group of a
//!   process started elsewhere, single-process stops, exit checks, process
//!   groups, pid liveness and process identity (pid, start time, parent,
//!   descent).
//! - [`fs`]: owner-only files, directories and checks, file identity,
//!   no-follow opens, atomic replace, exclusive and shared locks, links,
//!   canonical paths, portable names, execute bits, busy files, executable
//!   files and whether this process may run one, the space left on a volume
//!   and positioned reads.
//! - [`cli`]: finding a command-line tool on `PATH` and in package-manager
//!   directories.
//! - [`dirs`]: the codesense home and the shared lock directory.
//! - [`user`]: the user this process runs as, their login shell and the host's name.
//! - [`limits`]: the open-file soft limit and running out of descriptors.
//! - [`ipc`]: local endpoints, listeners and streams (Unix sockets, named
//!   pipes) and the pid at the other end.
//! - [`dialog`]: a system dialog that asks for a secret with hidden entry.
//! - [`tray`]: whether a tray item shows anywhere (a StatusNotifier host on
//!   Linux).
//! - `pdf` (with the `pdf` feature): rendering a page to PDF in a hidden web
//!   view, and which sources an export may load.
//! - `webview_proxy` (with the `webview-proxy` feature): sending the web
//!   views' `localhost` loads to the app's API listener (macOS 14 and later).

pub mod cli;
pub mod dialog;
pub mod dirs;
pub mod fs;
pub mod ipc;
pub mod limits;
#[cfg(any(feature = "pdf", test))]
pub mod pdf;
pub mod process;
pub mod tray;
pub mod user;
#[cfg(any(feature = "webview-proxy", test))]
pub mod webview_proxy;

pub use tray::status_notifier_host_registered;

#[cfg(feature = "testutil")]
pub mod testutil;

#[cfg(windows)]
mod win;

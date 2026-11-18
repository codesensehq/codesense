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
//!   groups and pid liveness.
//! - [`fs`]: owner-only files and checks, file identity, no-follow opens,
//!   atomic replace, exclusive locks, links, canonical paths, portable names,
//!   executable files and whether this process may run one.
//! - [`cli`]: finding a command-line tool on `PATH` and in package-manager
//!   directories.
//! - [`dirs`]: the codesense home.
//! - [`user`]: the user this process runs as.
//! - [`limits`]: the open-file soft limit and running out of descriptors.
//! - [`ipc`]: local endpoints, listeners and streams (Unix sockets, named
//!   pipes) and the pid at the other end.

pub mod cli;
pub mod dirs;
pub mod fs;
pub mod ipc;
pub mod limits;
pub mod process;
pub mod user;

#[cfg(feature = "testutil")]
pub mod testutil;

#[cfg(windows)]
mod win;

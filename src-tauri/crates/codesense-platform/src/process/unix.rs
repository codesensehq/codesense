// SPDX-License-Identifier: MIT
//! Unix: a process group per tree, signalled with `kill(-pgid, signal)`.

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

/// Put the child in a fresh process group (pgid == its own pid) so the whole
/// tree can be signalled, not just the leader.
pub(super) fn prepare(command: &mut Command) {
    command.process_group(0);
}

pub(super) struct Group(libc::pid_t);

impl Group {
    pub(super) fn adopt(child: &Child) -> io::Result<Self> {
        Ok(Self(child.id() as libc::pid_t))
    }

    pub(super) fn terminate(&self) -> io::Result<()> {
        signal_group(self.0, libc::SIGTERM)
    }

    pub(super) fn kill(&self) -> io::Result<()> {
        signal_group(self.0, libc::SIGKILL)
    }
}

/// Signal every process in group `pgid`; a group that is already gone is not
/// an error.
fn signal_group(pgid: libc::pid_t, signal: i32) -> io::Result<()> {
    // SAFETY: kill only sends a signal.
    if unsafe { libc::kill(-pgid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

/// Check whether a PID is still alive using `kill(pid, 0)`.
///
/// Returns `false` for PID 0 (kernel) and PIDs exceeding `i32::MAX`
/// (invalid for `kill(2)`).
pub(super) fn is_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only checks the pid exists.
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    // EPERM means the process exists but we lack permission to signal it.
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

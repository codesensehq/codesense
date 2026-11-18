// SPDX-License-Identifier: MIT
//! Unix: a process group per tree or adopted group, signalled with
//! `kill(-pgid, signal)`.

use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

/// Put the child in a fresh process group (pgid == its own pid) so the whole
/// tree can be signalled, not just the leader.
pub(super) fn prepare(command: &mut Command) {
    command.process_group(0);
}

/// Unix has no console windows: as [`prepare`].
pub(super) fn prepare_hidden(command: &mut Command) {
    prepare(command);
}

pub(super) struct Group(libc::pid_t);

impl Group {
    pub(super) fn adopt(child: &Child) -> io::Result<Self> {
        Ok(Self(child.id() as libc::pid_t))
    }

    /// The group `pid` is in, unless it is this process's own (never ours to
    /// signal) or cannot be read.
    pub(super) fn adopt_pid(pid: u32) -> io::Result<Option<Self>> {
        // SAFETY: getpgid and getpgrp only read the process table.
        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        Ok((pgid > 0 && pgid != unsafe { libc::getpgrp() }).then_some(Self(pgid)))
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

/// SIGTERM to the one process `pid`.
pub(super) fn terminate_pid(pid: u32) -> io::Result<()> {
    if pid > i32::MAX as u32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pid out of range for kill(2)",
        ));
    }
    // SAFETY: kill only sends a signal; a positive pid names one process.
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn exited_unreaped(child: &Child) -> io::Result<bool> {
    // SAFETY: zeroed siginfo storage is valid for waitid to fill.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: valid siginfo pointer; WNOWAIT leaves the child waitable.
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: waitid filled the record; with WNOHANG and no exit, si_pid is 0.
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(target_os = "macos")]
pub(super) fn group_and_foreground(pid: u32) -> Option<(i32, i32)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `info` is a correctly sized, writable `proc_bsdinfo`.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (n == size).then_some((info.pbi_pgid as i32, info.e_tpgid as i32))
}

#[cfg(target_os = "linux")]
pub(super) fn group_and_foreground(pid: u32) -> Option<(i32, i32)> {
    // `/proc/<pid>/stat`: `pid (comm) state ppid pgrp session tty_nr tpgid …`;
    // `comm` may hold spaces/parens, so split after the LAST `)`.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    Some((f.get(2)?.parse().ok()?, f.get(5)?.parse().ok()?))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn group_and_foreground(_pid: u32) -> Option<(i32, i32)> {
    None
}

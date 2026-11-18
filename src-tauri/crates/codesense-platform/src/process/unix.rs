// SPDX-License-Identifier: MIT
//! Unix: a process group per tree or adopted group, signalled with
//! `kill(-pgid, signal)`; process identity from `/proc` on Linux and
//! `proc_pidinfo` on macOS.

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::time::Duration;

use super::Identity;

/// A live process's parent is live or it was re-parented, so the parent it
/// reads is never a stale record.
pub(super) const PARENT_MAY_BE_STALE: bool = false;

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

#[cfg(target_os = "linux")]
pub(super) fn inspect(pid: u32) -> Option<Identity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    if matches!(*fields.first()?, "Z" | "X") {
        return None;
    }
    Some(Identity {
        pid,
        parent: fields.get(1)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
    })
}

#[cfg(target_os = "macos")]
pub(super) fn inspect(pid: u32) -> Option<Identity> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    // SAFETY: the kernel writes a correctly sized proc_bsdinfo buffer.
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (read == size && info.pbi_status != 5).then_some(Identity {
        pid,
        parent: info.pbi_ppid,
        start: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn inspect(_: u32) -> Option<Identity> {
    None
}

/// Compare the kernel process birth time with `time` since the epoch.
#[cfg(target_os = "macos")]
pub(super) fn started_after(start: u64, time: Duration) -> bool {
    start as u128 >= time.as_micros()
}

/// Compare the kernel process birth time with `time` since the epoch.
#[cfg(target_os = "linux")]
pub(super) fn started_after(start: u64, time: Duration) -> bool {
    let boot = std::fs::read_to_string("/proc/stat").ok().and_then(|stat| {
        stat.lines().find_map(|line| {
            line.strip_prefix("btime ")
                .and_then(|v| v.parse::<u64>().ok())
        })
    });
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    boot.is_some_and(|boot| {
        ticks > 0
            && boot as u128 * 1_000_000 + start as u128 * 1_000_000 / ticks as u128
                >= time.as_micros()
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn started_after(_: u64, _: Duration) -> bool {
    false
}

#[cfg(target_os = "linux")]
pub(super) fn peer(stream: &impl AsRawFd) -> Option<Identity> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of_val(&credentials) as libc::socklen_t;
    // SAFETY: SO_PEERCRED fills the bounded credentials buffer.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if result != 0 || credentials.uid != unsafe { libc::geteuid() } {
        return None;
    }
    inspect(credentials.pid as u32)
}

#[cfg(target_os = "macos")]
pub(super) fn peer(stream: &impl AsRawFd) -> Option<Identity> {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: getpeereid writes the two scalar credentials.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::geteuid() }
    {
        return None;
    }
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    // Darwin LOCAL_PEERPID is a kernel-authenticated pid (sys/un.h).
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            0,
            2,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    if result != 0 || pid <= 0 {
        return None;
    }
    inspect(pid as u32)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn peer(_: &impl AsRawFd) -> Option<Identity> {
    None
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    use super::super::{is_alive, kill_hard, terminate, Pid, ProcessTree};

    /// A tree whose root was reaped behind its back cannot read its exit, and
    /// from then on signals nothing, not even on drop: the root's pid and
    /// group may already name someone else's processes.
    #[test]
    fn a_tree_whose_exit_cannot_be_read_signals_nothing() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & echo $!"])
            .stdout(Stdio::piped());
        let mut tree = ProcessTree::spawn(&mut command).unwrap();
        let mut line = String::new();
        BufReader::new(tree.child().stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let left = Pid::from_raw(line.trim().parse().unwrap());
        let mut status = 0;
        // SAFETY: waits for the tree's own root, which nothing else reaps.
        let reaped = unsafe { libc::waitpid(tree.pid().as_raw() as libc::pid_t, &mut status, 0) };
        assert_eq!(reaped, tree.pid().as_raw() as libc::pid_t);

        assert!(tree.wait().is_err(), "the exit was reaped elsewhere");
        assert!(tree.try_wait().is_err());
        terminate(&tree).unwrap();
        kill_hard(&tree).unwrap();
        drop(tree);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(is_alive(left), "the group was signalled");
        // SAFETY: ends the test's own leftover sleep.
        unsafe { libc::kill(left.as_raw() as libc::pid_t, libc::SIGKILL) };
    }
}

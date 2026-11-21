// SPDX-License-Identifier: MIT
//! Unix: a process group per tree or adopted group, signalled with
//! `kill(-pgid, signal)`; process identity from `/proc` on Linux and
//! `proc_pidinfo` on macOS.

use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;

use super::Identity;

/// A live process's parent is live or it was re-parented, so the parent it
/// reads is never a stale record.
pub(super) const PARENT_MAY_BE_STALE: bool = false;

/// A Linux pty master buffers writes after its child exits; Darwin's fails.
pub(super) const PTY_ACCEPTS_WRITES_AFTER_EXIT: bool = cfg!(target_os = "linux");

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

    /// Nothing to undo: a process group ends nothing when it is let go.
    pub(super) fn release(&self) -> io::Result<()> {
        Ok(())
    }
}

/// Unix has no handle to wait on a process this one did not start.
pub(super) struct ExitWaiter(std::convert::Infallible);

impl ExitWaiter {
    pub(super) fn open(_pid: u32) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "a process this one did not start cannot be waited on here",
        ))
    }

    pub(super) fn wait(&self, _timeout: Duration) -> io::Result<bool> {
        match self.0 {}
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

/// Compare the kernel process birth time with `time` since the epoch. `start`
/// counts clock ticks since boot. Boot is read to the nanosecond, as wall time
/// minus time since boot: `/proc/stat`'s whole-second `btime` could read up to
/// a second early. A clock that can't be read refuses.
#[cfg(target_os = "linux")]
pub(super) fn started_after(start: u64, time: Duration) -> bool {
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    let (Ok(per_second), Some(boot)) = (u64::try_from(ticks), boot_time()) else {
        return false;
    };
    latest_start(boot, start, per_second).is_some_and(|start| start >= time)
}

/// When the system booted, since the epoch: never zero, none when a clock can't
/// be read.
#[cfg(target_os = "linux")]
fn boot_time() -> Option<Duration> {
    let since_boot = clock(libc::CLOCK_BOOTTIME)?;
    let now = clock(libc::CLOCK_REALTIME)?;
    now.checked_sub(since_boot).filter(|boot| !boot.is_zero())
}

#[cfg(target_os = "linux")]
fn clock(id: libc::clockid_t) -> Option<Duration> {
    let mut now: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: clock_gettime writes one timespec.
    if unsafe { libc::clock_gettime(id, &mut now) } != 0 {
        return None;
    }
    Some(Duration::new(
        u64::try_from(now.tv_sec).ok()?,
        u32::try_from(now.tv_nsec).ok()?,
    ))
}

/// The latest wall time a process started at whose start reads `ticks` clock
/// ticks after `boot`. The kernel counts whole ticks, so it started less than
/// a tick after that count: round up by one tick, to the next nanosecond. A
/// start within a tick after a recorded time then never reads as before it.
#[cfg(any(target_os = "linux", test))]
fn latest_start(boot: Duration, ticks: u64, per_second: u64) -> Option<Duration> {
    if per_second == 0 {
        return None;
    }
    let nanos = (u128::from(ticks) + 1)
        .checked_mul(1_000_000_000)?
        .div_ceil(u128::from(per_second));
    boot.checked_add(Duration::from_nanos(u64::try_from(nanos).ok()?))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn started_after(_: u64, _: Duration) -> bool {
    false
}

/// Whether process `pid` has `path` (canonically `canonical`) open, as lsof
/// names it.
#[cfg(target_os = "macos")]
pub(super) fn has_file_open(pid: u32, path: &Path, canonical: &Path) -> bool {
    let Ok(output) = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fpn"])
        .arg(path)
        .output()
    else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            line.strip_prefix('n')
                .is_some_and(|name| Path::new(name) == canonical)
        })
}

/// Whether process `pid` has `canonical` open: one of its `/proc/<pid>/fd`
/// links names it. A descriptor table that can't be read is no.
#[cfg(target_os = "linux")]
pub(super) fn has_file_open(pid: u32, _path: &Path, canonical: &Path) -> bool {
    let Ok(descriptors) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    descriptors
        .flatten()
        .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|target| target == canonical))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn has_file_open(_pid: u32, _path: &Path, _canonical: &Path) -> bool {
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
    use std::time::Duration;

    /// A process has a file open while it holds a descriptor to it, under any
    /// spelling of its path, and not a file it never opened.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_process_has_open_only_the_files_it_holds() {
        let dir = tempfile::tempdir().unwrap();
        let held = dir.path().join("held");
        let other = dir.path().join("other");
        std::fs::write(&other, b"").unwrap();
        let file = std::fs::File::create(&held).unwrap();
        let me = Pid::from_raw(std::process::id());
        assert!(super::super::has_file_open(me, &held));
        assert!(super::super::has_file_open(
            me,
            &dir.path().join(".").join("held")
        ));
        assert!(!super::super::has_file_open(me, &other));
        drop(file);
        assert!(!super::super::has_file_open(me, &held));
    }

    /// A start counted in whole ticks is placed at the end of its tick, to the
    /// nanosecond, after a boot with a sub-second part: a time inside that tick
    /// is not after the start, and a time a full tick later is.
    #[test]
    fn a_start_rounds_up_to_the_end_of_its_tick() {
        let boot = Duration::new(1_700_000_000, 250_000_000);
        // 100 ticks a second: tick 2 ends 30 ms after boot.
        let end = super::latest_start(boot, 2, 100).unwrap();
        assert_eq!(end, Duration::new(1_700_000_000, 280_000_000));
        let recorded = boot + Duration::from_millis(25);
        assert!(
            end >= recorded,
            "a start in the recorded time's tick is after it"
        );
        let tick_before = super::latest_start(boot, 1, 100).unwrap();
        assert!(
            tick_before < recorded,
            "a start a full tick earlier is before it"
        );
        // 3 ticks a second: two ticks are 666_666_666.67 ns, rounded up.
        assert_eq!(
            super::latest_start(boot, 1, 3).unwrap(),
            boot + Duration::from_nanos(666_666_667)
        );
        assert_eq!(super::latest_start(boot, 1, 0), None);
    }

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

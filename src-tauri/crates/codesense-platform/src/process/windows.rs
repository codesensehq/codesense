// SPDX-License-Identifier: MIT
//! Windows: a Job Object per tree, with kill-on-close; one without it for an
//! adopted group; process identity from the creation time and a Toolhelp
//! snapshot's parent.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenThread, ResumeThread, TerminateProcess, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};

use super::Identity;
use crate::win::Handle;

/// The Unix epoch as a FILETIME: 100 ns intervals since 1601-01-01.
const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

/// The exit code of every process the job ends.
const KILLED: u32 = 1;

/// Windows never re-parents: a process's recorded parent may have exited and
/// its pid been reused since.
pub(super) const PARENT_MAY_BE_STALE: bool = true;

/// What [`running`] needs to query and wait on a process.
const QUERY_AND_WAIT: u32 = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;

/// Start the child suspended, so it runs only once it is in the job (see
/// [`Group::adopt`]) and nothing it starts can escape it. std has no way to
/// add a flag, so this replaces the command's creation flags.
pub(super) fn prepare(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_SUSPENDED);
}

/// As [`prepare`], and with no console window: a console program started
/// from a windowed one would otherwise open one.
pub(super) fn prepare_hidden(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

/// A job. A tree's job (from [`Group::adopt`]) has kill-on-close, so closing
/// its handle kills whatever is still in it; an adopted group's job (from
/// [`Group::adopt_pid`]) does not, so closing it leaves its processes running.
pub(super) struct Group(Handle);

impl Group {
    pub(super) fn adopt(child: &Child) -> io::Result<Self> {
        let job = new_job()?;
        // SAFETY: all-zero is a valid value of this plain-data struct.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the pointer and size describe `limits`, alive for the call.
        let set = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
        assign(&job, child.as_raw_handle())?;
        resume_main_thread(child.id())?;
        Ok(Self(job))
    }

    /// A job for the running process `pid`, without kill-on-close: closing
    /// it leaves the process running. The process is not suspended, so what
    /// it started before it was assigned stays outside the job.
    pub(super) fn adopt_pid(pid: u32) -> io::Result<Option<Self>> {
        let job = new_job()?;
        // SAFETY: opening a process to assign it to a job has no other effect.
        let process =
            Handle::new(unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) })?;
        assign(&job, process.raw())?;
        Ok(Some(Self(job)))
    }

    pub(super) fn terminate(&self) -> io::Result<()> {
        self.kill()
    }

    pub(super) fn kill(&self) -> io::Result<()> {
        // SAFETY: the job handle is open.
        if unsafe { TerminateJobObject(self.0.raw(), KILLED) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// A new anonymous job.
fn new_job() -> io::Result<Handle> {
    // SAFETY: null attributes and name create an anonymous job.
    Handle::new(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })
}

/// Put `process` in `job`.
fn assign(job: &Handle, process: HANDLE) -> io::Result<()> {
    // SAFETY: both handles are open; the caller keeps owning `process`.
    if unsafe { AssignProcessToJobObject(job.raw(), process) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Resume the one thread of the suspended process `pid`.
fn resume_main_thread(pid: u32) -> io::Result<()> {
    // SAFETY: a snapshot of every thread; it takes no pointers.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = Handle::new(snapshot)?;
    // SAFETY: all-zero is a valid value of this plain-data struct.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    // SAFETY: the snapshot is open; `entry` is writable and its size is set.
    let mut found = unsafe { Thread32First(snapshot.raw(), &mut entry) } != 0;
    while found {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: opening a thread to resume it has no other effect.
            let thread =
                Handle::new(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
            // SAFETY: the thread handle is open.
            if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        // SAFETY: as for `Thread32First`.
        found = unsafe { Thread32Next(snapshot.raw(), &mut entry) } != 0;
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "the new process has no thread to resume",
    ))
}

pub(super) fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: opening a process to query and wait on it has no other effect.
    let process = match Handle::new(unsafe { OpenProcess(QUERY_AND_WAIT, 0, pid) }) {
        Ok(process) => process,
        Err(error) => return error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32),
    };
    running(&process)
}

/// Whether the open `process` has not exited: its handle is signalled once
/// it exits. An exited process stays openable while any handle to it is
/// open. Its exit code can't tell: a process may exit with 259, the code
/// that reads as still running.
fn running(process: &Handle) -> bool {
    // SAFETY: the process handle is open with `PROCESS_SYNCHRONIZE`; a zero
    // timeout only polls.
    unsafe { WaitForSingleObject(process.raw(), 0) == WAIT_TIMEOUT }
}

/// The running process `pid`: its creation time as a FILETIME, and its parent
/// from a Toolhelp snapshot.
pub(super) fn inspect(pid: u32) -> Option<Identity> {
    if pid == 0 {
        return None;
    }
    // SAFETY: opening a process to query and wait on it has no other effect.
    let process = Handle::new(unsafe { OpenProcess(QUERY_AND_WAIT, 0, pid) }).ok()?;
    if !running(&process) {
        return None;
    }
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: the process handle is open; the four times are writable.
    let read = unsafe {
        GetProcessTimes(
            process.raw(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if read == 0 {
        return None;
    }
    Some(Identity {
        pid,
        start: (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime),
        parent: parent_of(pid)?,
    })
}

/// The parent pid Toolhelp records for `pid`. Windows never re-parents, so
/// the parent may have exited and its pid been reused since.
fn parent_of(pid: u32) -> Option<u32> {
    // SAFETY: a snapshot of every process; it takes no pointers.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let snapshot = Handle::new(snapshot).ok()?;
    // SAFETY: all-zero is a valid value of this plain-data struct.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: the snapshot is open; `entry` is writable and its size is set.
    let mut found = unsafe { Process32FirstW(snapshot.raw(), &mut entry) } != 0;
    while found {
        if entry.th32ProcessID == pid {
            return Some(entry.th32ParentProcessID);
        }
        // SAFETY: as for `Process32FirstW`.
        found = unsafe { Process32NextW(snapshot.raw(), &mut entry) } != 0;
    }
    None
}

/// Compare a creation FILETIME with `time` since the epoch.
pub(super) fn started_after(start: u64, time: Duration) -> bool {
    start
        .checked_sub(UNIX_EPOCH_FILETIME)
        .is_some_and(|since| u128::from(since / 10) >= time.as_micros())
}

pub(super) fn terminate_pid(pid: u32) -> io::Result<()> {
    // SAFETY: opening a process to terminate it has no other effect.
    let process = Handle::new(unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) })?;
    // SAFETY: the process handle is open.
    if unsafe { TerminateProcess(process.raw(), KILLED) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn exited_unreaped(child: &Child) -> io::Result<bool> {
    // SAFETY: `child` owns its open process handle; a zero timeout only polls.
    match unsafe { WaitForSingleObject(child.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

/// Windows has no process groups to read.
pub(super) fn group_and_foreground(_pid: u32) -> Option<(i32, i32)> {
    None
}

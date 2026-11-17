// SPDX-License-Identifier: MIT
//! Windows: a Job Object per tree, with kill-on-close.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, ResumeThread, CREATE_SUSPENDED,
    PROCESS_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

use crate::win::Handle;

/// The exit code of every process the job ends.
const KILLED: u32 = 1;

/// Start the child suspended, so it runs only once it is in the job (see
/// [`Group::adopt`]) and nothing it starts can escape it. std has no way to
/// add a flag, so this replaces the command's creation flags.
pub(super) fn prepare(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_SUSPENDED);
}

/// The tree's job; closing its handle kills whatever is still in it.
pub(super) struct Group(Handle);

impl Group {
    pub(super) fn adopt(child: &Child) -> io::Result<Self> {
        // SAFETY: null attributes and name create an anonymous job.
        let job = Handle::new(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
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
        // SAFETY: both handles are open; `child` keeps owning its own.
        if unsafe { AssignProcessToJobObject(job.raw(), child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume_main_thread(child.id())?;
        Ok(Self(job))
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
    // SAFETY: opening a process for a limited query has no other effect.
    let process =
        match Handle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }) {
            Ok(process) => process,
            Err(error) => return error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32),
        };
    let mut code = 0u32;
    // SAFETY: the process handle is open; `code` is writable.
    let read = unsafe { GetExitCodeProcess(process.raw(), &mut code) };
    read != 0 && code == STILL_ACTIVE as u32
}

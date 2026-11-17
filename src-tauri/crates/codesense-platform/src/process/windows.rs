// SPDX-License-Identifier: MIT
//! Windows: a Job Object per tree, with kill-on-close.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, STILL_ACTIVE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::win::Handle;

/// The exit code of every process the job ends.
const KILLED: u32 = 1;

pub(super) fn prepare(_command: &mut Command) {}

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

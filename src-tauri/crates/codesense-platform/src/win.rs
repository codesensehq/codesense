// SPDX-License-Identifier: MIT
//! Windows helpers shared by the modules' Windows arms: an owned kernel
//! handle, the current user's SID and wide path strings.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::core::PWSTR;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// An open kernel handle, closed on drop.
pub(crate) struct Handle(HANDLE);

// SAFETY: a kernel handle may be used and closed from any thread.
unsafe impl Send for Handle {}
// SAFETY: as above; the handle is only passed to thread-safe kernel calls.
unsafe impl Sync for Handle {}

impl Handle {
    /// Own `raw`, or the last OS error when the call that returned it failed
    /// (a null handle). Call it right after that call.
    pub(crate) fn new(raw: HANDLE) -> io::Result<Self> {
        if raw.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(raw))
        }
    }

    pub(crate) fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle is open and owned by this value.
        unsafe { CloseHandle(self.0) };
    }
}

/// The current process token's user, read once.
pub(crate) struct CurrentUser {
    /// The `TOKEN_USER` and the SID it points to, 8-byte aligned.
    buffer: Vec<u64>,
}

impl CurrentUser {
    pub(crate) fn read() -> io::Result<Self> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: the current-process pseudo handle needs no closing; `token`
        // is writable.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Handle::new(token)?;
        let mut length = 0u32;
        // SAFETY: a null buffer of length 0 only asks for the size it needs.
        unsafe {
            GetTokenInformation(token.raw(), TokenUser, std::ptr::null_mut(), 0, &mut length)
        };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        // SAFETY: `buffer` holds at least `length` writable bytes.
        let read = unsafe {
            GetTokenInformation(
                token.raw(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        };
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { buffer })
    }

    /// The user's SID, valid while `self` lives.
    pub(crate) fn sid(&self) -> PSID {
        // SAFETY: the buffer holds the TOKEN_USER the token wrote, whose SID
        // points into the same buffer.
        unsafe { (*self.buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    /// The SID as text, `S-1-5-…`.
    pub(crate) fn sid_string(&self) -> io::Result<String> {
        let mut text: PWSTR = std::ptr::null_mut();
        // SAFETY: the SID is valid; `text` is writable.
        if unsafe { ConvertSidToStringSidW(self.sid(), &mut text) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call returned a NUL-terminated string it allocated with
        // LocalAlloc; it is read up to the NUL, then freed once.
        let sid = unsafe {
            let length = (0..).take_while(|&i| *text.add(i) != 0).count();
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            sid
        };
        Ok(sid)
    }
}

/// `path` as a NUL-terminated wide string.
pub(crate) fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

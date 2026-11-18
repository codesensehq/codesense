// SPDX-License-Identifier: MIT
//! Windows helpers shared by the modules' Windows arms: an owned kernel
//! handle, the current user's SID, a DACL that grants one SID and wide path
//! strings.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::OnceLock;

use windows_sys::core::PWSTR;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{
    AddAccessAllowedAceEx, EqualSid, GetLengthSid, GetTokenInformation, InitializeAcl, TokenUser,
    ACCESS_ALLOWED_ACE, ACE_FLAGS, ACL, ACL_REVISION, PSID, TOKEN_QUERY, TOKEN_USER,
};
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
    /// The user, read from the token on the first call: a process's user
    /// does not change.
    pub(crate) fn read() -> io::Result<&'static Self> {
        static USER: OnceLock<CurrentUser> = OnceLock::new();
        if let Some(user) = USER.get() {
            return Ok(user);
        }
        let user = Self::read_token()?;
        Ok(USER.get_or_init(|| user))
    }

    fn read_token() -> io::Result<Self> {
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

    /// Whether `sid` is this user's.
    pub(crate) fn is(&self, sid: PSID) -> bool {
        // SAFETY: both SIDs are valid.
        unsafe { EqualSid(sid, self.sid()) != 0 }
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

/// A DACL with one ACE, granting `access` to one SID: no one else is let in.
pub(crate) struct SingleUserAcl {
    /// The ACL header and its ACE, DWORD-aligned.
    buffer: Vec<u32>,
}

impl SingleUserAcl {
    /// Grant `access` to `sid` alone, with the ACE's `inherit` flags.
    pub(crate) fn new(sid: PSID, inherit: ACE_FLAGS, access: u32) -> io::Result<Self> {
        // SAFETY: the caller's SID is valid.
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        // The ACL header and one ACE, whose SID takes the place of `SidStart`.
        let acl_length = std::mem::size_of::<ACL>() + std::mem::size_of::<ACCESS_ALLOWED_ACE>()
            - std::mem::size_of::<u32>()
            + sid_length;
        let mut buffer = vec![0u32; acl_length.div_ceil(4)];
        let acl = buffer.as_mut_ptr().cast::<ACL>();
        // SAFETY: `acl` points to a DWORD-aligned buffer of the size given.
        if unsafe { InitializeAcl(acl, (buffer.len() * 4) as u32, ACL_REVISION) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the ACL was sized for this one ACE, which copies the SID.
        if unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, inherit, access, sid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { buffer })
    }

    /// The ACL, valid while `self` lives.
    pub(crate) fn as_ptr(&self) -> *const ACL {
        self.buffer.as_ptr().cast()
    }
}

/// `path` as a NUL-terminated wide string.
pub(crate) fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

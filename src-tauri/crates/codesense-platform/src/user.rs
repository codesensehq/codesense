// SPDX-License-Identifier: MIT
//! The user this process runs as and their login shell.

use std::io;

/// A user id: on unix the effective uid (`geteuid`), shown as its number; on
/// Windows the process token's user SID, shown as `S-1-5-…`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct User(String);

impl User {
    /// The id as text: the uid's decimal digits, or the SID string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for User {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The user this process runs as.
pub fn current_user() -> io::Result<User> {
    current().map(User)
}

/// The login shell recorded for this user: on unix the passwd entry's shell
/// (the `dscl` UserShell on macOS); `None` when it is empty or unreadable,
/// and always on Windows, which has no login shell.
pub fn login_shell() -> Option<String> {
    passwd_shell()
}

#[cfg(unix)]
fn current() -> io::Result<String> {
    // SAFETY: geteuid has no preconditions.
    Ok(unsafe { libc::geteuid() }.to_string())
}

#[cfg(windows)]
fn current() -> io::Result<String> {
    crate::win::CurrentUser::read()?.sid_string()
}

#[cfg(unix)]
fn passwd_shell() -> Option<String> {
    // SAFETY: `getpwuid_r` writes into our own buffers; `result` is either null
    // or points at `pwd`, whose string fields point into `buf`, which outlives
    // every read below.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        loop {
            let rc = libc::getpwuid_r(
                libc::getuid(),
                &mut pwd,
                buf.as_mut_ptr(),
                buf.len(),
                &mut result,
            );
            // An entry larger than the buffer: grow and retry, within reason.
            if rc == libc::ERANGE && buf.len() < 1 << 20 {
                buf.resize(buf.len() * 2, 0);
                continue;
            }
            if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
                return None;
            }
            break;
        }
        let shell = std::ffi::CStr::from_ptr(pwd.pw_shell)
            .to_string_lossy()
            .into_owned();
        (!shell.is_empty()).then_some(shell)
    }
}

#[cfg(windows)]
fn passwd_shell() -> Option<String> {
    None
}

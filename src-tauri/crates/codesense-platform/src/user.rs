// SPDX-License-Identifier: MIT
//! The user this process runs as, their login shell and the host's name.

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

/// This host's name: unix `gethostname`; Windows its DNS host name
/// (`GetComputerNameExW`). `None` when it cannot be read.
pub fn hostname() -> Option<String> {
    host()
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
fn host() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: `buf` is writable for its whole length, which is what we pass.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

#[cfg(windows)]
fn host() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW,
    };
    let mut size = 0u32;
    // SAFETY: a null buffer of size 0 only asks for the size, NUL included.
    unsafe { GetComputerNameExW(ComputerNameDnsHostname, std::ptr::null_mut(), &mut size) };
    let mut buf = vec![0u16; size as usize];
    // SAFETY: `buf` is writable for the `size` characters we pass.
    if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut size) } == 0 {
        return None;
    }
    // On success `size` is the name's length without the NUL.
    Some(String::from_utf16_lossy(&buf[..size as usize]))
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

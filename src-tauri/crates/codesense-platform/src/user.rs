// SPDX-License-Identifier: MIT
//! The user this process runs as.

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

#[cfg(unix)]
fn current() -> io::Result<String> {
    // SAFETY: geteuid has no preconditions.
    Ok(unsafe { libc::geteuid() }.to_string())
}

#[cfg(windows)]
fn current() -> io::Result<String> {
    crate::win::CurrentUser::read()?.sid_string()
}

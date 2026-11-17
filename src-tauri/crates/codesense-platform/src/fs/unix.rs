// SPDX-License-Identifier: MIT
//! Unix: permission modes, `O_NOFOLLOW`, `rename` and `flock`.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;

use super::{Linked, ReplaceError};

pub(super) fn set_owner_only(path: &Path, is_dir: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if is_dir { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

pub(super) fn is_owner_only(path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    Ok(meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0)
}

pub(super) fn open_nofollow(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    options
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

pub(super) fn replace(from: &Path, to: &Path) -> Result<(), ReplaceError> {
    std::fs::rename(from, to).map_err(ReplaceError::Io)
}

pub(super) fn lock_exclusive(file: &File) -> io::Result<()> {
    // SAFETY: `file` owns a live descriptor for the duration of this call;
    // `flock` neither retains the pointer nor accesses Rust-managed memory.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    // SAFETY: `file` owns a live descriptor for the duration of this call;
    // `flock` neither retains the pointer nor accesses Rust-managed memory.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    let code = error.raw_os_error();
    if code == Some(libc::EWOULDBLOCK) || code == Some(libc::EAGAIN) {
        Ok(false)
    } else {
        Err(error)
    }
}

pub(super) fn unlock(file: &File) -> io::Result<()> {
    // SAFETY: `file` still owns the locked descriptor; unlocking does not
    // retain it or access Rust-managed memory.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub(super) fn link_or_copy(target: &Path, link: &Path) -> io::Result<Linked> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(Linked::Symlink)
}

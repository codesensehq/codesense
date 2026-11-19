// SPDX-License-Identifier: MIT
//! Unix: permission modes, uid and (dev, ino), `O_NOFOLLOW`, `rename`,
//! `flock` and `ETXTBSY`.

use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use super::{Creation, FileId, Linked, Open, Reach, ReplaceError};

pub(super) fn set_owner_only(path: &Path, is_dir: bool) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if is_dir { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

fn owned(meta: &Metadata) -> bool {
    // SAFETY: geteuid has no preconditions.
    meta.uid() == unsafe { libc::geteuid() }
}

pub(super) fn is_owner_only(file: &File) -> io::Result<bool> {
    let meta = file.metadata()?;
    Ok(owned(&meta) && meta.mode() & 0o077 == 0)
}

pub(super) fn is_owned_by_current_user(file: &File) -> io::Result<bool> {
    Ok(owned(&file.metadata()?))
}

fn id(meta: &Metadata) -> FileId {
    FileId {
        volume: meta.dev(),
        index: u128::from(meta.ino()),
    }
}

pub(super) fn file_id(path: &Path) -> io::Result<FileId> {
    Ok(id(&std::fs::symlink_metadata(path)?))
}

pub(super) fn file_id_of(file: &File) -> io::Result<FileId> {
    Ok(id(&file.metadata()?))
}

pub(super) fn create_owner_only(path: &Path, creation: Creation, open: Open) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    match creation {
        Creation::OpenOrCreate => options.read(true).write(true).create(true).truncate(false),
        Creation::New => options.write(true).create_new(true),
    };
    options.mode(0o600);
    if open == Open::NoFollow {
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

pub(super) fn create_dir_owner_only(path: &Path, recursive: bool) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(recursive)
        .mode(0o700)
        .create(path)
}

pub(super) fn set_executable(path: &Path, reach: Reach) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = match reach {
        Reach::Owner => 0o700,
        Reach::Everyone => 0o755,
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

pub(super) fn is_text_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ETXTBSY)
}

pub(super) fn open_nofollow(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    options
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

pub(super) fn canonicalize(path: &Path) -> io::Result<std::path::PathBuf> {
    dunce::canonicalize(path)
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
    try_flock(file, libc::LOCK_EX)
}

pub(super) fn try_lock_shared(file: &File) -> io::Result<bool> {
    try_flock(file, libc::LOCK_SH)
}

/// `flock(operation | LOCK_NB)`: `false` when another open file holds a lock
/// that conflicts.
fn try_flock(file: &File, operation: libc::c_int) -> io::Result<bool> {
    // SAFETY: `file` owns a live descriptor for the duration of this call;
    // `flock` neither retains the pointer nor accesses Rust-managed memory.
    let result = unsafe { libc::flock(file.as_raw_fd(), operation | libc::LOCK_NB) };
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

pub(super) fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_absolute()
        && std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

pub(super) fn can_execute(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a NUL-terminated path; `access` only reads it.
    let runnable = unsafe { libc::access(c_path.as_ptr(), libc::X_OK) } == 0;
    runnable && Path::is_file(path)
}

pub(super) fn link_or_copy(target: &Path, link: &Path) -> io::Result<Linked> {
    std::os::unix::fs::symlink(target, link)?;
    Ok(Linked::Symlink)
}

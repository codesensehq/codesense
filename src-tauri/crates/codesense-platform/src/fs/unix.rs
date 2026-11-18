// SPDX-License-Identifier: MIT
//! Unix: permission modes, uid and (dev, ino), `O_NOFOLLOW`, `rename` and
//! `flock`.

use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use super::{Creation, FileId, Linked, Open, ReplaceError};

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
        index: meta.ino(),
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

// SPDX-License-Identifier: MIT
//! Windows: a protected owner-only DACL, reparse-point refusal, std's rename
//! with a bounded retry, std's file locks, and a copy where symlinks need
//! Developer Mode.

use std::ffi::{c_void, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    LocalFree, ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_PRIVILEGE_NOT_HELD,
    ERROR_SHARING_VIOLATION, ERROR_SUCCESS,
};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAceEx, EqualSid, GetAce, GetLengthSid, InitializeAcl, ACCESS_ALLOWED_ACE,
    ACE_HEADER, ACL, ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
    OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

use super::{portable_name, Linked, ReplaceError};
use crate::win::{wide, CurrentUser};

/// `ACCESS_ALLOWED_ACE_TYPE`: an ACE that grants access to one SID.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// `ACCESS_DENIED_ACE_TYPE`: an ACE that only takes access away.
const ACCESS_DENIED_ACE_TYPE: u8 = 1;

/// How many times a replace meets a sharing violation before it is `Busy`.
const REPLACE_ATTEMPTS: u32 = 5;
/// The wait after the first sharing violation, doubled after each (150 ms in
/// all).
const FIRST_RETRY_DELAY: Duration = Duration::from_millis(10);

pub(super) fn set_owner_only(path: &Path, is_dir: bool) -> io::Result<()> {
    let user = CurrentUser::read()?;
    let sid = user.sid();
    // SAFETY: the SID is valid while `user` lives.
    let sid_length = unsafe { GetLengthSid(sid) } as usize;
    // The ACL header and one ACE, whose SID takes the place of `SidStart`.
    let acl_length = std::mem::size_of::<ACL>() + std::mem::size_of::<ACCESS_ALLOWED_ACE>()
        - std::mem::size_of::<u32>()
        + sid_length;
    let mut buffer = vec![0u32; acl_length.div_ceil(4)];
    let acl = buffer.as_mut_ptr().cast::<ACL>();
    let inherit = if is_dir {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    // SAFETY: `acl` points to a DWORD-aligned buffer of the size given.
    if unsafe { InitializeAcl(acl, (buffer.len() * 4) as u32, ACL_REVISION) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the ACL was sized for this one ACE; the SID is valid.
    if unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, inherit, FILE_ALL_ACCESS, sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let path = wide(path);
    // SAFETY: `path` is NUL-terminated; the ACL lives across the call.
    let status = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

pub(super) fn is_owner_only(file: &File) -> io::Result<bool> {
    let user = CurrentUser::read()?;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: the file's handle is open (read access includes READ_CONTROL);
    // the out pointers are writable.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    // SAFETY: `dacl` is null or points into `descriptor`, which is freed
    // only after this; the SID is valid while `user` lives.
    let owner_only = unsafe { grants_only(dacl, user.sid()) };
    // SAFETY: the call allocated the descriptor with LocalAlloc.
    unsafe { LocalFree(descriptor) };
    Ok(owner_only)
}

/// Whether every ACE in `dacl` that grants access names `sid`. A null DACL
/// grants everyone everything; an ACE of a kind not read here counts as a
/// grant to someone else.
///
/// # Safety
///
/// `dacl` is null or a valid ACL, and `sid` a valid SID.
unsafe fn grants_only(dacl: *const ACL, sid: PSID) -> bool {
    if dacl.is_null() {
        return false;
    }
    for index in 0..u32::from((*dacl).AceCount) {
        let mut ace: *mut c_void = std::ptr::null_mut();
        if GetAce(dacl, index, &mut ace) == 0 {
            return false;
        }
        match (*ace.cast::<ACE_HEADER>()).AceType {
            ACCESS_DENIED_ACE_TYPE => {}
            ACCESS_ALLOWED_ACE_TYPE => {
                let ace_sid = std::ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart);
                if EqualSid(ace_sid.cast(), sid) == 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}

pub(super) fn open_nofollow(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    let file = options
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)?;
    // Only name surrogates (symlinks, junctions) are links; other reparse
    // points (cloud placeholders, deduplicated files) open as files.
    if file.metadata()?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is a link", path.display()),
        ));
    }
    Ok(file)
}

/// The longest plain path, in UTF-16 units: `MAX_PATH` less its NUL.
const MAX_PLAIN_PATH: usize = 259;

pub(super) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path).map(plain_unc)
}

/// `\\?\UNC\server\share\rest` as `\\server\share\rest`, when the plain
/// form names the same file: every component after the share is a portable
/// name (so no `.`, `..`, trailing dot or space, or reserved device name) and
/// the whole fits in `MAX_PATH`. Any other path, verbatim or not, is
/// returned as it is. dunce applies the same rule to disk paths only.
fn plain_unc(path: PathBuf) -> PathBuf {
    match plain_unc_form(&path) {
        Some(plain) => PathBuf::from(plain),
        None => path,
    }
}

fn plain_unc_form(path: &Path) -> Option<OsString> {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return None;
    };
    let Prefix::VerbatimUNC(server, share) = prefix.kind() else {
        return None;
    };
    let mut plain = OsString::from(r"\\");
    plain.push(server);
    plain.push(r"\");
    plain.push(share);
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(name) if name.to_str().is_some_and(|n| portable_name(n).is_ok()) => {
                plain.push(r"\");
                plain.push(name);
            }
            _ => return None,
        }
    }
    (plain.encode_wide().count() <= MAX_PLAIN_PATH).then_some(plain)
}

pub(super) fn replace(from: &Path, to: &Path) -> Result<(), ReplaceError> {
    let mut delay = FIRST_RETRY_DELAY;
    for attempt in 1..=REPLACE_ATTEMPTS {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if is_busy(&error, to) => {
                if attempt < REPLACE_ATTEMPTS {
                    std::thread::sleep(delay);
                    delay *= 2;
                }
            }
            Err(error) => return Err(ReplaceError::Io(error)),
        }
    }
    Err(ReplaceError::Busy)
}

/// A handle elsewhere blocks the replace: a sharing or lock violation, or
/// the access denied Windows reports for a file another handle holds. Access
/// denied on a directory target is a plain error: no handle frees it.
fn is_busy(error: &io::Error, to: &Path) -> bool {
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION) => true,
        Some(ERROR_ACCESS_DENIED) => !to.is_dir(),
        _ => false,
    }
}

pub(super) fn lock_exclusive(file: &File) -> io::Result<()> {
    file.lock()
}

pub(super) fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

pub(super) fn unlock(file: &File) -> io::Result<()> {
    file.unlock()
}

pub(super) fn link_or_copy(target: &Path, link: &Path) -> io::Result<Linked> {
    match std::os::windows::fs::symlink_file(target, link) {
        Ok(()) => Ok(Linked::Symlink),
        Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD as i32) => {
            // A relative target is read from the link's directory, as the
            // symlink would have resolved it, never from the working directory.
            let source = link.parent().unwrap_or(Path::new("")).join(target);
            std::fs::copy(source, link)?;
            Ok(Linked::Copy)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::plain_unc;

    #[test]
    fn a_verbatim_unc_path_becomes_plain() {
        assert_eq!(
            plain_unc(PathBuf::from(r"\\?\UNC\server\share\dir\file.txt")),
            PathBuf::from(r"\\server\share\dir\file.txt")
        );
        assert_eq!(
            plain_unc(PathBuf::from(r"\\?\UNC\localhost\C$\Users")),
            PathBuf::from(r"\\localhost\C$\Users")
        );
        assert_eq!(
            plain_unc(PathBuf::from(r"\\?\UNC\server\share")),
            PathBuf::from(r"\\server\share")
        );
    }

    #[test]
    fn a_path_the_plain_form_would_change_stays_verbatim() {
        let long = format!(
            r"\\?\UNC\server\share\{}",
            vec!["a".repeat(100); 3].join(r"\")
        );
        for verbatim in [
            long.as_str(),
            r"\\?\UNC\server\share\CON",
            r"\\?\UNC\server\share\dir\trailing.",
            r"\\?\UNC\server\share\a:b",
            r"\\?\UNC\server\share\.\x",
            r"\\?\UNC\server\share\..\x",
        ] {
            assert_eq!(plain_unc(PathBuf::from(verbatim)), PathBuf::from(verbatim));
        }
    }

    #[test]
    fn other_paths_are_untouched() {
        for path in [r"C:\Users\x", r"\\?\C:\Users\x", r"\\server\share\x"] {
            assert_eq!(plain_unc(PathBuf::from(path)), PathBuf::from(path));
        }
    }
}

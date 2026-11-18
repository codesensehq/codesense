// SPDX-License-Identifier: MIT
//! Windows: a protected owner-only DACL, set on a path or at creation; DACL
//! and owner checks; volume serial and 128-bit file id; reparse-point refusal;
//! std's rename with a bounded retry, std's file locks, and a copy where
//! symlinks need Developer Mode.

use std::ffi::{c_void, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    LocalFree, ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
    ERROR_LOCK_VIOLATION, ERROR_NOT_SUPPORTED, ERROR_PRIVILEGE_NOT_HELD, ERROR_SHARING_VIOLATION,
    ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAceEx, EqualSid, GetAce, GetLengthSid, InitializeAcl,
    InitializeSecurityDescriptor, SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, CONTAINER_INHERIT_ACE,
    DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    SECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FileIdInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
};

use super::{portable_name, Creation, FileId, Linked, Open, ReplaceError};
use crate::win::{wide, CurrentUser};

/// `ACCESS_ALLOWED_ACE_TYPE`: an ACE that grants access to one SID.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// `ACCESS_DENIED_ACE_TYPE`: an ACE that only takes access away.
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
/// `SECURITY_DESCRIPTOR_REVISION`, from a module this crate does not enable.
const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

/// How many times a replace meets a sharing violation before it is `Busy`.
const REPLACE_ATTEMPTS: u32 = 5;
/// The wait after the first sharing violation, doubled after each (150 ms in
/// all).
const FIRST_RETRY_DELAY: Duration = Duration::from_millis(10);

pub(super) fn set_owner_only(path: &Path, is_dir: bool) -> io::Result<()> {
    let user = CurrentUser::read()?;
    let acl = owner_only_acl(&user, is_dir)?;
    let path = wide(path);
    // SAFETY: `path` is NUL-terminated; the ACL lives across the call.
    let status = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl.as_ptr().cast(),
            std::ptr::null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

/// An ACL with one ACE granting `user` full access, inherited by a
/// directory's new entries when `is_dir`, in a DWORD-aligned buffer.
fn owner_only_acl(user: &CurrentUser, is_dir: bool) -> io::Result<Vec<u32>> {
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
    Ok(buffer)
}

/// A file's owner and DACL, read from its open handle; the security
/// descriptor holding them is freed on drop.
struct Security {
    descriptor: PSECURITY_DESCRIPTOR,
    owner: PSID,
    dacl: *mut ACL,
}

impl Security {
    fn of(file: &File) -> io::Result<Self> {
        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: the file's handle is open (read or write access includes
        // READ_CONTROL); the out pointers are writable.
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Self {
            descriptor,
            owner,
            dacl,
        })
    }

    /// Whether the owner is `user`'s token user or its default owner.
    fn owned_by(&self, user: &CurrentUser) -> bool {
        // SAFETY: the owner SID is null or points into the descriptor `self`
        // holds; the user's SIDs are valid while `user` lives.
        unsafe { owner_is_current(self.owner, user.sid(), user.default_owner()) }
    }
}

/// Whether `owner` is the token's user or its default owner (`TokenOwner`),
/// and no other SID. An elevated token's default owner is
/// `BUILTIN\Administrators`, which then owns the files it creates.
///
/// # Safety
///
/// `owner` is null or a valid SID; `token_user` and `token_owner` are valid
/// SIDs.
unsafe fn owner_is_current(owner: PSID, token_user: PSID, token_owner: PSID) -> bool {
    !owner.is_null() && (EqualSid(owner, token_user) != 0 || EqualSid(owner, token_owner) != 0)
}

impl Drop for Security {
    fn drop(&mut self) {
        // SAFETY: the call allocated the descriptor with LocalAlloc; it is
        // freed once, here.
        unsafe { LocalFree(self.descriptor) };
    }
}

pub(super) fn is_owner_only(file: &File) -> io::Result<bool> {
    let user = CurrentUser::read()?;
    let security = Security::of(file)?;
    // SAFETY: `dacl` is null or points into the descriptor `security` holds;
    // the SID is valid while `user` lives.
    Ok(security.owned_by(&user) && unsafe { grants_only(security.dacl, user.sid()) })
}

pub(super) fn is_owned_by_current_user(file: &File) -> io::Result<bool> {
    Ok(Security::of(file)?.owned_by(&CurrentUser::read()?))
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

pub(super) fn file_id(path: &Path) -> io::Result<FileId> {
    file_id_of(&open_itself(
        OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES),
        path,
    )?)
}

/// The 128-bit `FILE_ID_INFO` id, not `nFileIndex`, which is only 64 bits
/// and not unique on ReFS (Dev Drive). A file system that has no
/// `FileIdInfo` (FAT, some network redirectors) falls back to `nFileIndex`.
pub(super) fn file_id_of(file: &File) -> io::Result<FileId> {
    // SAFETY: all-zero is a valid FILE_ID_INFO.
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: the file's handle is open; `info` is writable for the size given.
    let read = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            std::ptr::addr_of_mut!(info).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if read != 0 {
        return Ok(FileId {
            volume: info.VolumeSerialNumber,
            index: u128::from_le_bytes(info.FileId.Identifier),
        });
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_INVALID_PARAMETER | ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED) => {
            file_index_of(file)
        }
        _ => Err(error),
    }
}

/// The 64-bit file index, where the file system has no 128-bit id.
fn file_index_of(file: &File) -> io::Result<FileId> {
    // SAFETY: all-zero is a valid BY_HANDLE_FILE_INFORMATION.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the file's handle is open; `info` is writable.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileId {
        volume: u64::from(info.dwVolumeSerialNumber),
        index: u128::from((u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)),
    })
}

pub(super) fn create_owner_only(path: &Path, creation: Creation, open: Open) -> io::Result<File> {
    let user = CurrentUser::read()?;
    let acl = owner_only_acl(&user, false)?;
    // SAFETY: all-zero is a valid SECURITY_DESCRIPTOR to initialize.
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let descriptor_ptr: PSECURITY_DESCRIPTOR = std::ptr::addr_of_mut!(descriptor).cast();
    // SAFETY: `descriptor` is an absolute descriptor of the full size; the
    // ACL it points to outlives the CreateFileW call below.
    let made = unsafe {
        InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) != 0
            && SetSecurityDescriptorDacl(descriptor_ptr, 1, acl.as_ptr().cast(), 0) != 0
            && SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
                != 0
    };
    if !made {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor_ptr,
        bInheritHandle: 0,
    };
    let (access, disposition) = match creation {
        Creation::OpenOrCreate => (GENERIC_READ | GENERIC_WRITE, OPEN_ALWAYS),
        Creation::New => (GENERIC_WRITE, CREATE_NEW),
    };
    // A new file never follows a link, dangling or not, as unix `O_EXCL`
    // and std's `create_new` refuse one.
    let flags = if open == Open::NoFollow || creation == Creation::New {
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT
    } else {
        FILE_ATTRIBUTE_NORMAL
    };
    let wide_path = wide(path);
    // SAFETY: the path is NUL-terminated; the attributes and the descriptor
    // and ACL they point to live across the call.
    let raw = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            disposition,
            flags,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned an open handle that nothing else owns.
    let file = unsafe { File::from_raw_handle(raw) };
    match open {
        Open::Follow => Ok(file),
        Open::NoFollow => refuse_link(file, path),
    }
}

pub(super) fn open_nofollow(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    refuse_link(open_itself(options, path)?, path)
}

/// Open `path` itself with `options`, a link or a directory included, shared
/// for read, write and delete.
fn open_itself(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    options
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
}

/// `file`, opened with `FILE_FLAG_OPEN_REPARSE_POINT`, or an error when it
/// is a link. Only name surrogates (symlinks, junctions) are links; other
/// reparse points (cloud placeholders, deduplicated files) open as files.
fn refuse_link(file: File, path: &Path) -> io::Result<File> {
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

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows_sys::Win32::Security::PSID;

    use super::{owner_is_current, plain_unc};

    /// A SID parsed from its string form, freed on drop.
    struct Sid(PSID);

    impl Sid {
        fn parse(text: &str) -> Self {
            let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            let mut sid: PSID = std::ptr::null_mut();
            // SAFETY: `wide` is NUL-terminated; `sid` is writable.
            let parsed = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
            assert_ne!(parsed, 0, "{text}: {}", std::io::Error::last_os_error());
            Self(sid)
        }
    }

    impl Drop for Sid {
        fn drop(&mut self) {
            // SAFETY: ConvertStringSidToSidW allocated the SID with LocalAlloc.
            unsafe { LocalFree(self.0) };
        }
    }

    #[test]
    fn the_owner_is_current_for_the_token_user_or_its_default_owner_only() {
        let user = Sid::parse("S-1-5-21-1000-2000-3000-1001");
        let administrators = Sid::parse("S-1-5-32-544");
        let system = Sid::parse("S-1-5-18");
        let same_user = Sid::parse("S-1-5-21-1000-2000-3000-1001");
        // SAFETY: every SID lives to the end of the test.
        unsafe {
            assert!(owner_is_current(user.0, user.0, administrators.0));
            assert!(owner_is_current(same_user.0, user.0, administrators.0));
            assert!(owner_is_current(administrators.0, user.0, administrators.0));
            assert!(owner_is_current(user.0, user.0, user.0));
            assert!(!owner_is_current(system.0, user.0, administrators.0));
            assert!(!owner_is_current(administrators.0, user.0, user.0));
            assert!(!owner_is_current(
                std::ptr::null_mut(),
                user.0,
                administrators.0
            ));
        }
    }

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

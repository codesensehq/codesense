// SPDX-License-Identifier: MIT
//! Windows: a protected owner-only DACL, set on a path or at creation; DACL
//! and owner checks, and writes the DACL allows anyone; volume serial and
//! 128-bit file id, link counts and change stamps; reparse-point refusal;
//! std's rename with a bounded retry, directory flushes, std's file locks,
//! sharing violations, a copy where symlinks need Developer Mode, the
//! caller's free space and positioned reads. Execute bits do not exist: the
//! extension decides.

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
    ERROR_SUCCESS, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    EqualSid, GetAce, GetSecurityDescriptorControl, InitializeSecurityDescriptor, IsWellKnownSid,
    SetSecurityDescriptorControl, SetSecurityDescriptorDacl, WinAuthenticatedUserSid,
    WinBuiltinUsersSid, WinWorldSid, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACE_HEADER, ACL,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FileIdInfo, GetDiskFreeSpaceExW, GetFileInformationByHandle,
    GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION, CREATE_NEW, DELETE, FILE_ALL_ACCESS,
    FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA,
    OPEN_ALWAYS, WRITE_DAC, WRITE_OWNER,
};

use super::{
    portable_name, ChangeStamp, Creation, FileId, Linked, Open, PlaceLink, Reach, ReplaceError,
};
use crate::win::{wide, CurrentUser, SingleUserAcl, SECURITY_DESCRIPTOR_REVISION};

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
    let acl = SingleUserAcl::new(user.sid(), inheritance(is_dir), FILE_ALL_ACCESS)?;
    let path = wide(path);
    // SAFETY: `path` is NUL-terminated; the ACL lives across the call.
    let status = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl.as_ptr(),
            std::ptr::null(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
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

    /// Whether the DACL is protected: it inherits nothing from the parent.
    fn dacl_protected(&self) -> io::Result<bool> {
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: the descriptor is valid while `self` lives; the out
        // pointers are writable.
        if unsafe { GetSecurityDescriptorControl(self.descriptor, &mut control, &mut revision) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(control & SE_DACL_PROTECTED != 0)
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

/// Owned by the current user, with the protected DACL [`set_owner_only`]
/// writes: one ACE granting the current user `FILE_ALL_ACCESS`, inherited by a
/// directory's new entries. An owner-only DACL of another shape (less access,
/// other inheritance, more ACEs, or not protected) is not exact.
pub(super) fn is_exactly_owner_only(file: &File) -> io::Result<bool> {
    let is_dir = file.metadata()?.is_dir();
    let user = CurrentUser::read()?;
    let security = Security::of(file)?;
    if !security.owned_by(user) || !security.dacl_protected()? {
        return Ok(false);
    }
    // SAFETY: `dacl` is null or points into the descriptor `security` holds;
    // the SID is valid while `user` lives.
    Ok(unsafe { is_owner_only_ace(security.dacl, user.sid(), inheritance(is_dir)) })
}

/// Whether `dacl` holds exactly the one ACE [`set_owner_only`] writes: it
/// grants `sid` `FILE_ALL_ACCESS`, with the ACE flags `flags`.
///
/// # Safety
///
/// `dacl` is null or a valid ACL; `sid` is a valid SID.
unsafe fn is_owner_only_ace(dacl: *const ACL, sid: PSID, flags: ACE_FLAGS) -> bool {
    if dacl.is_null() || (*dacl).AceCount != 1 {
        return false;
    }
    let mut ace: *mut c_void = std::ptr::null_mut();
    if GetAce(dacl, 0, &mut ace) == 0 {
        return false;
    }
    let header = &*ace.cast::<ACE_HEADER>();
    if header.AceType != ACCESS_ALLOWED_ACE_TYPE || u32::from(header.AceFlags) != flags {
        return false;
    }
    let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
    allowed.Mask == FILE_ALL_ACCESS
        && EqualSid(std::ptr::addr_of!(allowed.SidStart).cast_mut().cast(), sid) != 0
}

pub(super) fn is_owner_only(file: &File) -> io::Result<bool> {
    let user = CurrentUser::read()?;
    let security = Security::of(file)?;
    // SAFETY: `dacl` is null or points into the descriptor `security` holds;
    // the SID is valid while `user` lives.
    Ok(security.owned_by(user) && unsafe { grants_only(security.dacl, user.sid()) })
}

pub(super) fn is_owned_by_current_user(file: &File) -> io::Result<bool> {
    Ok(Security::of(file)?.owned_by(CurrentUser::read()?))
}

/// Whether every ACE in `dacl` that grants access names `sid`. A null DACL
/// grants everyone everything; an ACE of a kind not read here, or one that
/// cannot be read, counts as a grant to someone else.
///
/// # Safety
///
/// `dacl` is null or a valid ACL, and `sid` a valid SID.
unsafe fn grants_only(dacl: *const ACL, sid: PSID) -> bool {
    !any_ace(dacl, |ace| match ace {
        Ace::Denies => false,
        Ace::Allows { sid: grantee, .. } => EqualSid(grantee, sid) == 0,
        Ace::Unknown => true,
    })
    .unwrap_or(true)
}

/// One ACE of a DACL, as the checks here read it.
enum Ace {
    /// An `ACCESS_ALLOWED_ACE`: `sid` may use `mask`; one flagged
    /// `INHERIT_ONLY_ACE` applies to the object's children, not to the object.
    Allows {
        sid: PSID,
        mask: u32,
        inherit_only: bool,
    },
    /// An ACE that only takes access away.
    Denies,
    /// Any other kind (callback, object, …), or one that cannot be read.
    Unknown,
}

/// Whether `matches` holds for an ACE of `dacl`, visited in order; `None`
/// for a null DACL, which grants everyone everything. Each caller decides
/// what an [`Ace::Unknown`] means, so both fail closed.
///
/// # Safety
///
/// `dacl` is null or a valid ACL.
unsafe fn any_ace(dacl: *const ACL, mut matches: impl FnMut(Ace) -> bool) -> Option<bool> {
    if dacl.is_null() {
        return None;
    }
    for index in 0..u32::from((*dacl).AceCount) {
        let mut ace: *mut c_void = std::ptr::null_mut();
        let read = if GetAce(dacl, index, &mut ace) == 0 {
            Ace::Unknown
        } else {
            let header = &*ace.cast::<ACE_HEADER>();
            match header.AceType {
                ACCESS_DENIED_ACE_TYPE => Ace::Denies,
                ACCESS_ALLOWED_ACE_TYPE => {
                    let allowed = &*ace.cast::<ACCESS_ALLOWED_ACE>();
                    Ace::Allows {
                        sid: std::ptr::addr_of!(allowed.SidStart).cast_mut().cast(),
                        mask: allowed.Mask,
                        inherit_only: u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0,
                    }
                }
                _ => Ace::Unknown,
            }
        };
        if matches(read) {
            return Some(true);
        }
    }
    Some(false)
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
        return file_id_from(
            info.VolumeSerialNumber,
            u128::from_le_bytes(info.FileId.Identifier),
        );
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
    let info = handle_information(file)?;
    file_id_from(
        u64::from(info.dwVolumeSerialNumber),
        u128::from((u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)),
    )
}

/// `GetFileInformationByHandle` of the open `file`.
fn handle_information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: all-zero is a valid BY_HANDLE_FILE_INFORMATION.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the file's handle is open; `info` is writable.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

/// A [`FileId`], or `Unsupported` for a zero index: some virtual and
/// redirected drives report 0 for every file, so it names none of them.
fn file_id_from(volume: u64, index: u128) -> io::Result<FileId> {
    if index == 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "the file system reports no file id",
        ));
    }
    Ok(FileId { volume, index })
}

/// The owner-only ACE's inheritance: a directory's new files and
/// directories inherit it; a file has nothing to pass it on to.
fn inheritance(is_dir: bool) -> ACE_FLAGS {
    if is_dir {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    }
}

/// Call `create` with security attributes that give what it creates
/// [`set_owner_only`]'s protected DACL from the start, so it is never
/// readable by anyone else, not even for a moment.
fn with_owner_only_attributes<T>(
    is_dir: bool,
    create: impl FnOnce(&SECURITY_ATTRIBUTES) -> io::Result<T>,
) -> io::Result<T> {
    let user = CurrentUser::read()?;
    let acl = SingleUserAcl::new(user.sid(), inheritance(is_dir), FILE_ALL_ACCESS)?;
    // SAFETY: all-zero is a valid SECURITY_DESCRIPTOR to initialize.
    let mut descriptor: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let descriptor_ptr: PSECURITY_DESCRIPTOR = std::ptr::addr_of_mut!(descriptor).cast();
    // SAFETY: `descriptor` is an absolute descriptor of the full size; the
    // ACL it points to outlives the `create` call below.
    let made = unsafe {
        InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) != 0
            && SetSecurityDescriptorDacl(descriptor_ptr, 1, acl.as_ptr(), 0) != 0
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
    create(&attributes)
}

pub(super) fn create_owner_only(path: &Path, creation: Creation, open: Open) -> io::Result<File> {
    let file = with_owner_only_attributes(false, |attributes| {
        create_file(path, creation, open, attributes)
    })?;
    match open {
        Open::Follow => Ok(file),
        Open::NoFollow => refuse_link(file, path),
    }
}

/// `CreateFileW` for [`create_owner_only`], with its `attributes`.
fn create_file(
    path: &Path,
    creation: Creation,
    open: Open,
    attributes: &SECURITY_ATTRIBUTES,
) -> io::Result<File> {
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
            attributes,
            disposition,
            flags,
            std::ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned an open handle that nothing else owns.
    Ok(unsafe { File::from_raw_handle(raw) })
}

pub(super) fn create_dir_owner_only(path: &Path, recursive: bool) -> io::Result<()> {
    if !recursive {
        return create_one_dir_owner_only(path);
    }
    // The missing directories, `path` first; made from the top down.
    let missing: Vec<&Path> = path
        .ancestors()
        .take_while(|dir| !dir.as_os_str().is_empty() && !dir.is_dir())
        .collect();
    for dir in missing.into_iter().rev() {
        match create_one_dir_owner_only(dir) {
            // Made meanwhile by someone else: not ours to change.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => {}
            result => result?,
        }
    }
    Ok(())
}

/// Create the one directory `dir` with the owner-only DACL already on it.
fn create_one_dir_owner_only(dir: &Path) -> io::Result<()> {
    let wide_dir = wide(dir);
    with_owner_only_attributes(true, |attributes| {
        // SAFETY: the path is NUL-terminated; the attributes and the
        // descriptor and ACL they point to live across the call.
        if unsafe { CreateDirectoryW(wide_dir.as_ptr(), attributes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })
}

pub(super) fn set_executable(_path: &Path, _reach: Reach) -> io::Result<()> {
    Ok(())
}

pub(super) fn is_text_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32)
}

pub(super) fn open_nofollow(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    refuse_link(open_itself(options, path)?, path)
}

pub(super) fn open_nofollow_nonblocking(
    options: &mut OpenOptions,
    path: &Path,
) -> io::Result<File> {
    open_nofollow(options, path)
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

pub(super) fn is_executable(path: &Path) -> bool {
    path.is_absolute() && path.is_file() && crate::win::has_pathext(path)
}

pub(super) fn can_execute(path: &Path) -> bool {
    is_executable(path)
}

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

pub(super) fn sync_dir(dir: &Path) -> io::Result<()> {
    let flushed = OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(dir)
        .and_then(|handle| handle.sync_all());
    match flushed {
        Ok(()) => Ok(()),
        // Not flushable here (no write access, FAT, a network share): the
        // file system makes the entry durable on its own.
        Err(error) => match std::fs::metadata(dir) {
            Ok(meta) if meta.is_dir() => Ok(()),
            Ok(_) => Err(error),
            Err(missing) => Err(missing),
        },
    }
}

pub(super) fn lock_exclusive(file: &File) -> io::Result<()> {
    file.lock()
}

pub(super) fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    taken(file.try_lock())
}

pub(super) fn try_lock_shared(file: &File) -> io::Result<bool> {
    taken(file.try_lock_shared())
}

/// A non-blocking lock attempt's answer: `false` when another handle holds a
/// lock that conflicts.
fn taken(attempt: Result<(), std::fs::TryLockError>) -> io::Result<bool> {
    match attempt {
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

/// Private-account roots are unix-only, so [`PlaceLink::Symbolic`] places as
/// [`PlaceLink::Hard`]: a hard link, else a copy. Never a symlink, which
/// needs Developer Mode and which [`file_id`] would not see through.
pub(super) fn place_link(source: &Path, link: &Path, _how: PlaceLink) -> io::Result<()> {
    if placed(source, link)? {
        return Ok(());
    }
    let partial = super::partial_link(link);
    super::hard_link(source, &partial)
        .or_else(|_| std::fs::copy(source, &partial).map(drop))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&partial);
        })?;
    replace(&partial, link).map_err(|error| {
        let _ = std::fs::remove_file(&partial);
        io::Error::from(error)
    })
}

/// Whether `link` is already `source`: the same file, or a copy with its
/// length and last-write time.
fn placed(source: &Path, link: &Path) -> io::Result<bool> {
    let current = std::fs::metadata(source)?;
    let Ok(placed) = std::fs::symlink_metadata(link) else {
        return Ok(false);
    };
    if !placed.is_file() {
        return Ok(false);
    }
    if matches!((file_id(link), file_id(source)), (Ok(placed), Ok(current)) if placed == current) {
        return Ok(true);
    }
    Ok(placed.len() == current.len() && placed.modified()? == current.modified()?)
}

/// The rights that change a file or a directory's entries: write and append
/// data (add a file or a subdirectory), extended attributes, attributes,
/// delete a child or the file itself, the DACL and the owner, and the
/// generic write and all rights.
const WRITE_RIGHTS: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_DELETE_CHILD
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER
    | GENERIC_ALL
    | GENERIC_WRITE;

pub(super) fn is_world_writable(file: &File) -> io::Result<bool> {
    let security = Security::of(file)?;
    // SAFETY: `dacl` is null or points into the descriptor `security` holds.
    Ok(unsafe { grants_anyone_write(security.dacl) })
}

/// Whether `dacl` allows one of [`WRITE_RIGHTS`] to Everyone, Users or
/// Authenticated Users on the object itself (an ACE flagged `INHERIT_ONLY_ACE`
/// is for its children). A null DACL grants everyone everything, and an ACE of a kind
/// not read here counts as such a grant; deny ACEs are not weighed, so the
/// answer errs towards writable.
///
/// # Safety
///
/// `dacl` is null or a valid ACL.
unsafe fn grants_anyone_write(dacl: *const ACL) -> bool {
    any_ace(dacl, |ace| match ace {
        Ace::Denies => false,
        Ace::Allows {
            sid,
            mask,
            inherit_only,
        } => {
            !inherit_only
                && mask & WRITE_RIGHTS != 0
                && [WinWorldSid, WinBuiltinUsersSid, WinAuthenticatedUserSid]
                    .into_iter()
                    .any(|anyone| IsWellKnownSid(sid, anyone) != 0)
        }
        Ace::Unknown => true,
    })
    .unwrap_or(true)
}

pub(super) fn link_count(file: &File) -> io::Result<u64> {
    Ok(u64::from(handle_information(file)?.nNumberOfLinks))
}

pub(super) fn available_space(path: &Path) -> io::Result<u64> {
    // GetDiskFreeSpaceExW takes a directory: a file's is the one it is in.
    let dir = if std::fs::metadata(path)?.is_dir() {
        path
    } else {
        match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        }
    };
    let mut available = 0u64;
    // SAFETY: a NUL-terminated path, a live out-pointer, and the two totals
    // the call allows to be null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide(dir).as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

pub(super) fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, offset) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "failed to fill whole buffer",
                ))
            }
            Ok(read) => {
                buf = &mut std::mem::take(&mut buf)[read..];
                offset += read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// The last-write time's 100 ns ticks in a second.
const TICKS_PER_SECOND: u64 = 10_000_000;

pub(super) fn change_stamp(path: &Path) -> io::Result<ChangeStamp> {
    use std::os::windows::fs::MetadataExt;
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let id = file_id_of(&file)?;
    let written = file.metadata()?.last_write_time();
    Ok(ChangeStamp {
        file: (id.volume, id.index),
        changed: (
            (written / TICKS_PER_SECOND) as i64,
            (written % TICKS_PER_SECOND * 100) as i64,
        ),
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows_sys::Win32::Security::PSID;

    use super::{file_id_from, owner_is_current, plain_unc};

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
    fn a_zero_file_index_is_unsupported() {
        let error = file_id_from(7, 0).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        assert_eq!(file_id_from(7, 1).unwrap(), file_id_from(7, 1).unwrap());
        assert_ne!(file_id_from(7, 1).unwrap(), file_id_from(8, 1).unwrap());
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

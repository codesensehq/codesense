// SPDX-License-Identifier: MIT
//! Files: owner-only permissions, ownership checks, file identity,
//! owner-only creates, opens that refuse links, atomic replace, exclusive
//! locks, links with a copy fallback, canonical paths and names that are
//! valid on every OS.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use self::unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use self::windows as sys;

/// Make `path` readable and writable by this user only: mode 0600 for a file
/// and 0700 for a directory on unix; on Windows a protected DACL granting
/// only the current user (inherited by a directory's new entries). A link,
/// to a file or a directory, is refused and left unchanged: its target is not
/// ours to change.
pub fn set_owner_only(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("is a symlink; left unchanged"));
    }
    sys::set_owner_only(path, metadata.is_dir())
}

/// Whether only this user may use the open `file` (open it with
/// [`open_nofollow`], so a link is never followed): on unix, owned by the
/// effective uid with no group or other permission bits; on Windows, owned
/// as [`is_owned_by_current_user`] has it, and every ACE that grants access
/// names the current user.
pub fn is_owner_only(file: &File) -> io::Result<bool> {
    sys::is_owner_only(file)
}

/// Whether this user owns the open `file` (open it with [`open_nofollow`],
/// so a link is never followed), whatever its permissions.
///
/// Unix: strictly `uid == euid`.
///
/// Windows: the owner SID is this process token's user SID or its default
/// owner (`TokenOwner`), and nothing wider. An elevated administrator's
/// token makes `BUILTIN\Administrators` the default owner, so the files this
/// process creates carry that group rather than the user. The trust boundary
/// is therefore the token's own two SIDs: under an elevated token, a file
/// another member of Administrators created also counts as owned, which that
/// member could open and change anyway.
pub fn is_owned_by_current_user(file: &File) -> io::Result<bool> {
    sys::is_owned_by_current_user(file)
}

/// Which file a path or an open file is, whatever its name: on unix the
/// device and inode; on Windows the volume serial and the 128-bit file id.
/// Two are equal for the same file. A file that replaces another at the same
/// path has a different id only while the old file still exists or is held
/// open: once a file is deleted, its id may be given to a new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileId {
    volume: u64,
    index: u128,
}

/// The [`FileId`] of `path` itself: a final link is not followed, so a link
/// has its own.
pub fn file_id(path: &Path) -> io::Result<FileId> {
    sys::file_id(path)
}

/// The [`FileId`] of an open `file`.
pub fn file_id_of(file: &File) -> io::Result<FileId> {
    sys::file_id_of(file)
}

/// How [`create_owner_only`] treats a final link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Open {
    /// Follow it, as a plain open does.
    Follow,
    /// Refuse it: unix `O_NOFOLLOW`, with `O_NONBLOCK` so a FIFO never
    /// blocks the open; on Windows the link itself is opened, then refused.
    NoFollow,
}

/// Whether an owner-only create may open a file that already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Creation {
    OpenOrCreate,
    New,
}

/// Open `path` for reading and writing, creating it readable and writable by
/// this user only (unix mode 0600; on Windows a protected DACL granting only
/// the current user, set as it is created). An existing file keeps its bytes
/// and permissions: it is never truncated.
pub fn create_owner_only(path: &Path, open: Open) -> io::Result<File> {
    sys::create_owner_only(path, Creation::OpenOrCreate, open)
}

/// Create `path` for writing, owner-only as [`create_owner_only`] makes it;
/// `AlreadyExists` when anything is at `path`, a link included.
pub fn create_new_owner_only(path: &Path) -> io::Result<File> {
    sys::create_owner_only(path, Creation::New, Open::Follow)
}

/// Open `path` with `options`, refusing it when it is a link: `O_NOFOLLOW`
/// (with `O_CLOEXEC`) on unix; on Windows the link itself is opened and a
/// symlink or junction is refused (other reparse points, such as cloud
/// placeholders, open). A directory opens for reading on every OS. On
/// Windows the file is shared for read, write and delete, so
/// [`atomic_replace`] can replace it while it is open.
pub fn open_nofollow(options: &mut OpenOptions, path: &Path) -> io::Result<File> {
    sys::open_nofollow(options, path)
}

/// Why [`atomic_replace`] failed.
#[derive(Debug)]
pub enum ReplaceError {
    /// Another process holds the file open without allowing it to be replaced
    /// (on Windows, a handle opened without `FILE_SHARE_DELETE`), still after
    /// a bounded retry. The file keeps its old bytes.
    Busy,
    Io(io::Error),
}

impl std::fmt::Display for ReplaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => {
                f.write_str("the file is open in another process that does not allow replacing it")
            }
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ReplaceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Busy => None,
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for ReplaceError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ReplaceError> for io::Error {
    fn from(error: ReplaceError) -> Self {
        match error {
            ReplaceError::Busy => io::Error::new(io::ErrorKind::ResourceBusy, ReplaceError::Busy),
            ReplaceError::Io(error) => error,
        }
    }
}

/// The per-write-unique temp sibling for `path`: `<path>.tmp.<pid>.<nonce>`.
/// The `.tmp.` infix is what the content watcher's transient-file guard
/// keys on.
fn tmp_sibling(path: &Path, nonce: u64) -> PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp.{}.{}", std::process::id(), nonce));
    PathBuf::from(tmp)
}

/// Atomically write `bytes` to `path` via a per-write-unique temp file +
/// rename. Creates the parent directory if missing. A concurrent reader sees
/// the old or the new file whole, never a torn one; a concurrent writer to
/// the same path never shares the temp, so every rename publishes a complete
/// file. A failure removes the temp and leaves `path` as it was.
///
/// On Windows the rename is std's: `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,
/// and when that is denied because the target is open, a rename with POSIX
/// semantics, so a reader opened through [`open_nofollow`] keeps the old
/// bytes. A sharing violation, or access denied on a file, is retried a few
/// times, then reported as [`ReplaceError::Busy`].
pub fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), ReplaceError> {
    static SEQ: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let nonce = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = tmp_sibling(path, nonce);

    if let Err(e) = std::fs::write(&tmp_path, bytes) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.into());
    }
    if let Err(e) = sys::replace(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

/// Take an exclusive lock on `file`, waiting for it: `flock(LOCK_EX)` on
/// unix, `LockFileEx` (std's `File::lock`) on Windows. The lock belongs to
/// this open file, so a second open of the same path does not share it, and
/// it is released when the file is closed.
pub fn lock_exclusive(file: &File) -> io::Result<()> {
    sys::lock_exclusive(file)
}

/// Try [`lock_exclusive`] without waiting: `false` when another open file
/// holds the lock.
pub fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    sys::try_lock_exclusive(file)
}

/// Release a lock taken by [`lock_exclusive`] before the file is closed.
pub fn unlock(file: &File) -> io::Result<()> {
    sys::unlock(file)
}

/// What [`link_or_copy`] made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Linked {
    Symlink,
    /// A copy of the file, made where this account may not create symlinks
    /// (Windows without Developer Mode or elevation).
    Copy,
}

/// Make `link` a symlink to the file `target`, or on Windows, when the
/// account may not create symlinks, a copy of it. A relative `target` is
/// taken from `link`'s directory, as a symlink resolves it.
pub fn link_or_copy(target: &Path, link: &Path) -> io::Result<Linked> {
    sys::link_or_copy(target, link)
}

/// The canonical, absolute form of `path`, with links resolved. On Windows
/// it has no `\\?\` prefix where the plain form means the same (so text
/// handed to agents and shells stays usable): `C:\…` for a disk (dunce) and
/// `\\server\share\…` for a UNC path; otherwise it keeps the verbatim form.
/// On unix it is `std::fs::canonicalize`.
pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    sys::canonicalize(path)
}

/// Why [`portable_name`] refused a name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NonPortableName {
    Empty,
    /// A separator, a control character or one of `<>:"|?*`.
    Char(char),
    /// A device name Windows reserves (`CON`, `NUL`, `COM1`, …), with or
    /// without an extension.
    Reserved,
    /// Windows drops a trailing dot or space, so the name would change.
    TrailingDotOrSpace,
}

impl std::fmt::Display for NonPortableName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("the name is empty"),
            Self::Char(c) => write!(f, "the name contains {c:?}"),
            Self::Reserved => f.write_str("the name is reserved on Windows"),
            Self::TrailingDotOrSpace => f.write_str("the name ends in a dot or a space"),
        }
    }
}

impl std::error::Error for NonPortableName {}

/// Device names Windows reserves in every directory.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Check that `name` (one path component) means the same file on every OS.
/// The same rules apply on every OS, so content written on one opens on all.
pub fn portable_name(name: &str) -> Result<(), NonPortableName> {
    if name.is_empty() {
        return Err(NonPortableName::Empty);
    }
    if let Some(c) = name.chars().find(|&c| {
        c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err(NonPortableName::Char(c));
    }
    if name.ends_with(|c| c == '.' || c == ' ') {
        return Err(NonPortableName::TrailingDotOrSpace);
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    if RESERVED
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
    {
        return Err(NonPortableName::Reserved);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_temp_sibling_keeps_the_transient_infix_and_parent() {
        let target = Path::new("/team/content/field-schema.yml");
        let tmp = tmp_sibling(target, 7);
        let name = tmp.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            name,
            format!("field-schema.yml.tmp.{}.7", std::process::id())
        );
        assert_eq!(tmp.parent(), target.parent());
    }

    #[test]
    fn a_failed_replace_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("occupied");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("guard"), b"").unwrap();
        assert!(matches!(
            atomic_replace(&path, b"payload"),
            Err(ReplaceError::Io(_))
        ));
        let strays = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .count();
        assert_eq!(strays, 0);
    }
}

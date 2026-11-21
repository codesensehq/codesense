// SPDX-License-Identifier: MIT
//! Owner-only checks on the app's private files and directories, the shared
//! paths their tests start from, and the links and FIFOs their no-follow
//! reads refuse.

use std::fs::OpenOptions;
use std::path::Path;

/// Whether only this user may use the file or directory at `path`, opened
/// without following a link: `codesense_platform::fs::is_owner_only`.
pub(crate) fn is_owner_only(path: &Path) -> bool {
    let opened = codesense_platform::fs::open_nofollow(OpenOptions::new().read(true), path)
        .unwrap_or_else(|e| panic!("cannot open {}: {e}", path.display()));
    codesense_platform::fs::is_owner_only(&opened)
        .unwrap_or_else(|e| panic!("cannot check {}: {e}", path.display()))
}

/// Make `path` a directory others may read and search: unix mode 0755; on
/// Windows the DACL its parent hands down.
pub(crate) fn shared_dir(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(!is_owner_only(path), "{} starts shared", path.display());
}

/// Make `path` a file holding `bytes` that others may read: unix mode 0644;
/// on Windows the DACL its directory hands down.
pub(crate) fn shared_file(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert!(!is_owner_only(path), "{} starts shared", path.display());
}

/// Make `link` a symbolic link to the file `target` and return `true`, or
/// `false` where this account may not (Windows without Developer Mode or
/// elevation), and the test skips that case.
pub(crate) fn file_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
}

/// Make a FIFO at `path` and return `true` (unix `mkfifo`), or `false` on
/// Windows, which has no FIFO at a path, and the test skips that case.
pub(crate) fn fifo(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path that `mkfifo` only reads.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        true
    }
    #[cfg(windows)]
    {
        let _ = path;
        false
    }
}

/// Run `read` on another thread and return what it returned, failing the
/// test if it has not returned within ten seconds (a read that blocked on a
/// FIFO).
pub(crate) fn without_blocking<T: Send + 'static>(read: impl FnOnce() -> T + Send + 'static) -> T {
    let (done, result) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(read());
    });
    result
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the read blocked")
}

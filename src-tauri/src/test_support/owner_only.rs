// SPDX-License-Identifier: MIT
//! Owner-only checks on the app's private files and directories, and the
//! shared paths their tests start from.

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

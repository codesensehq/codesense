// SPDX-License-Identifier: MIT
//! Helpers for other crates' tests: the `testutil` feature, enabled on a
//! dev-dependency only.

use std::path::Path;

/// Make `link` point at `target` for a test's setup and return `true`, or
/// return `false` after saying why on stderr, and the test skips the rest.
///
/// Unix: a symlink. Windows: a junction for a directory, which needs no
/// privilege; a file symlink otherwise, skipped where creating one needs
/// Developer Mode or elevation. A target that does not exist is linked as a
/// file.
pub fn symlink_or_skip(target: impl AsRef<Path>, link: impl AsRef<Path>) -> bool {
    sys::symlink_or_skip(target.as_ref(), link.as_ref())
}

/// Make the file at `path` executable for a test's setup: the execute bits
/// (mode 0755) on unix; nothing on Windows, where the extension decides.
pub fn set_executable(path: impl AsRef<Path>) {
    sys::set_executable(path.as_ref())
}

/// The extensions `PATHEXT` names as executable, as the lookup reads them:
/// on Windows `PATHEXT`'s, each with a leading dot; elsewhere Windows'
/// default list.
pub fn pathext() -> Vec<String> {
    sys::pathext()
}

#[cfg(unix)]
mod sys {
    use std::path::Path;

    pub(super) fn pathext() -> Vec<String> {
        [".COM", ".EXE", ".BAT", ".CMD"].map(str::to_owned).to_vec()
    }

    pub(super) fn set_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|error| panic!("chmod 755 {}: {error}", path.display()));
    }

    pub(super) fn symlink_or_skip(target: &Path, link: &Path) -> bool {
        if let Err(error) = std::os::unix::fs::symlink(target, link) {
            panic!(
                "symlink {} -> {}: {error}",
                link.display(),
                target.display()
            );
        }
        true
    }
}

#[cfg(windows)]
mod sys {
    use std::path::Path;

    use windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD;

    pub(super) fn pathext() -> Vec<String> {
        crate::win::pathext()
    }

    pub(super) fn set_executable(_path: &Path) {}

    pub(super) fn symlink_or_skip(target: &Path, link: &Path) -> bool {
        if target.is_dir() {
            let status = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .expect("run mklink");
            assert!(
                status.success(),
                "mklink /J {} {}: {status}",
                link.display(),
                target.display()
            );
            return true;
        }
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD as i32) => {
                eprintln!("skipped: a file symlink needs Developer Mode or elevation ({error})");
                false
            }
            Err(error) => panic!(
                "symlink {} -> {}: {error}",
                link.display(),
                target.display()
            ),
        }
    }
}

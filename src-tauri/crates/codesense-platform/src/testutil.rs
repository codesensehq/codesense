// SPDX-License-Identifier: MIT
//! Helpers for other crates' tests: the `testutil` feature, enabled on a
//! dev-dependency only.

use std::path::{Component, Path, PathBuf};

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

/// The relative path from the working directory to the absolute `path`: one
/// `..` per component of the working directory, then `path` without its root.
/// It reaches `path` (asserted), so a check that refuses it is refusing
/// relative paths, not a missing file. On Windows `path` must be on the
/// working directory's volume.
pub fn relative_from_cwd(path: &Path) -> PathBuf {
    fn normal(component: &Component) -> bool {
        matches!(component, Component::Normal(_))
    }
    let cwd = std::env::current_dir().unwrap();
    let mut relative: PathBuf = cwd.components().filter(normal).map(|_| "..").collect();
    relative.extend(path.components().filter(normal));
    assert!(
        relative.is_relative() && relative.exists(),
        "{}",
        relative.display()
    );
    relative
}

/// Who [`make_world_writable`] lets write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anyone {
    Everyone,
    Users,
    AuthenticatedUsers,
}

/// Let `anyone` write to the directory or file at `path`, for a test of a
/// check that refuses it. Unix: mode 0777, whoever is named, as unix has one
/// "others". Windows: an ACE granting that group modify, added with
/// `icacls`.
pub fn make_world_writable(path: &Path, anyone: Anyone) {
    sys::make_world_writable(path, anyone)
}

/// Let the owner's group, but nobody else, write to the directory or file at
/// `path`. Unix: mode 0770. Windows: an ACE granting Administrators modify,
/// a group that is not everyone.
pub fn make_group_writable(path: &Path) {
    sys::make_group_writable(path)
}

/// Make a FIFO at `path` and return `true`, or return `false` after saying
/// why on stderr, and the test skips the rest. Unix: `mkfifo`, mode 0600.
/// Windows has no FIFO at a path.
pub fn fifo_or_skip(path: &Path) -> bool {
    sys::fifo_or_skip(path)
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

    pub(super) fn make_world_writable(path: &Path, _anyone: super::Anyone) {
        set_mode(path, 0o777);
    }

    pub(super) fn make_group_writable(path: &Path) {
        set_mode(path, 0o770);
    }

    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    pub(super) fn fifo_or_skip(path: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path; mkfifo only reads it.
        if unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) } != 0 {
            panic!(
                "mkfifo {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            );
        }
        true
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

    pub(super) fn make_world_writable(path: &Path, anyone: super::Anyone) {
        let sid = match anyone {
            super::Anyone::Everyone => "S-1-1-0",
            super::Anyone::Users => "S-1-5-32-545",
            super::Anyone::AuthenticatedUsers => "S-1-5-11",
        };
        grant_modify(path, sid);
    }

    pub(super) fn make_group_writable(path: &Path) {
        // Administrators.
        grant_modify(path, "S-1-5-32-544");
    }

    /// An ACE granting `sid` modify (M) on `path`, added with `icacls`.
    fn grant_modify(path: &Path, sid: &str) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .arg("/grant")
            .arg(format!("*{sid}:M"))
            .stdout(std::process::Stdio::null())
            .status()
            .expect("run icacls");
        assert!(status.success(), "icacls {}: {status}", path.display());
    }

    pub(super) fn fifo_or_skip(_path: &Path) -> bool {
        eprintln!("skipped: Windows has no FIFO at a path");
        false
    }

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

// SPDX-License-Identifier: MIT
//! The Claude status hook CodeSense itself ships.
//!
//! The script is part of CodeSense's own install, never of a workspace or team content:
//! every host writes it once into its activity root, beside the activity helper, when it
//! starts ([`install`]). A Claude session reaches it through its tab's
//! `$CODESENSE_ACTIVITY_HOST`, as its inbox hooks reach the helper ([`status_command`]).
//! The hook posts Claude Code lifecycle events to the running CodeSense app so terminal
//! status dots and the agent list stay live.
//!
//! Lives in `codesense-pty-core` because both the main `codesense` binary and the
//! `codesense-session-server` sidecar run a host.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The reference hook, embedded in the app binary. The repo copy at
/// `scripts/codesense-notify.reference.sh` is the single source of truth;
/// edits there flow in on the next build.
pub const SOURCE: &str = include_str!("../../../../scripts/codesense-notify.reference.sh");

/// The installed hook's file name in a host's activity root.
pub const NAME: &str = "codesense-notify.sh";

/// Mode the installed hook lands with (executable for owner, read + exec
/// for group and other).
pub const MODE: u32 = 0o755;

/// The installed guard's file name in a host's activity root.
pub const GUARD_NAME: &str = "codesense-secret-guard.sh";

/// The tools the guard is scoped to, as a hook matcher.
pub const GUARD_MATCHER: &str = "Read|Grep|Glob|Bash";

/// The protected list and the guard built from it live beside the guard's verdict in
/// `codesense-host-proto`, so the guard, the installed script and Claude's `permissions.deny`
/// rules keep one list.
pub use codesense_host_proto::hook::{deny_rules, guard_source, Family, FAMILIES, PROTECTED_DIRS};

/// The installed hook as a hook command names it: under the host root its tab exports.
pub fn installed_script() -> String {
    format!("${}/{NAME}", crate::activity::HOST_ENV)
}

/// The installed guard as a hook command names it.
pub fn installed_guard() -> String {
    format!("${}/{GUARD_NAME}", crate::activity::HOST_ENV)
}

/// The command the guard hook runs. A missing script allows the call: the guard never blocks
/// work because it is not installed.
pub fn guard_command() -> String {
    let script = format!("\"{}\"", installed_guard());
    format!("[ -x {script} ] && {script} || true")
}

/// The command a Claude status hook runs. A missing script (a tab outside any host, or a
/// host that could not write it) would fail every hook event, so it is guarded like the
/// inbox hooks; `[` reads no stdin, so the hook's JSON still reaches the script.
pub fn status_command() -> String {
    let script = format!("\"{}\"", installed_script());
    format!("[ -x {script} ] && {script} || true")
}

/// Write the hook into the host activity `root` with mode [`MODE`], unless it is already
/// there. The write is atomic: a tmp file renamed over whatever is at the path (a symlink
/// included, never followed), so a hook firing meanwhile runs one whole script.
pub fn install(root: &Path) -> io::Result<()> {
    let status = install_one(root, NAME, SOURCE);
    let guard = install_one(root, GUARD_NAME, &guard_source());
    status.and(guard)
}

fn install_one(root: &Path, name: &str, source: &str) -> io::Result<()> {
    let dest = root.join(name);
    if is_installed(&dest, source) {
        return Ok(());
    }
    atomic_write_mode(&dest, source.as_bytes(), MODE)
}

/// Whether `dest` is a regular, owner-executable file holding `source`.
fn is_installed(dest: &Path, source: &str) -> bool {
    let Ok(meta) = fs::symlink_metadata(dest) else {
        return false;
    };
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o100 != 0
    };
    #[cfg(not(unix))]
    let executable = true;
    meta.is_file() && executable && fs::read(dest).is_ok_and(|bytes| bytes == source.as_bytes())
}

fn atomic_write_mode(dest: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    let file_name = dest.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "notify-hook dest has no file name",
        )
    })?;
    let tmp = tmp_path(parent, file_name);
    // Clean a stale tmp from a previous crashed write.
    let _ = fs::remove_file(&tmp);
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn tmp_path(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let mut buf = std::ffi::OsString::from(".");
    buf.push(name);
    buf.push(".tmp.notify-hook");
    parent.join(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn source_has_bash_shebang_and_tab_session_check() {
        assert!(SOURCE.starts_with("#!/bin/bash\n"));
        assert!(SOURCE.contains("CODESENSE_TAB_SESSION_ID"));
    }

    #[test]
    fn the_status_command_runs_the_hosts_installed_script_guarded() {
        assert_eq!(
            status_command(),
            "[ -x \"$CODESENSE_ACTIVITY_HOST/codesense-notify.sh\" ] && \"$CODESENSE_ACTIVITY_HOST/codesense-notify.sh\" || true"
        );
    }

    #[test]
    fn install_writes_an_executable_copy_once() {
        let tmp = tempdir().unwrap();
        install(tmp.path()).unwrap();
        let dest = tmp.path().join(NAME);
        assert_eq!(fs::read_to_string(&dest).unwrap(), SOURCE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            assert_eq!(
                fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o755
            );
            let first = fs::metadata(&dest).unwrap().ino();
            install(tmp.path()).unwrap();
            assert_eq!(fs::metadata(&dest).unwrap().ino(), first, "left as it was");
        }
    }

    #[cfg(unix)]
    #[test]
    fn install_repairs_drifted_bytes_or_a_missing_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join(NAME);
        for (bytes, mode) in [
            (&b"#!/bin/sh\necho stale\n"[..], 0o755),
            (SOURCE.as_bytes(), 0o644),
        ] {
            fs::write(&dest, bytes).unwrap();
            fs::set_permissions(&dest, fs::Permissions::from_mode(mode)).unwrap();
            install(tmp.path()).unwrap();
            assert_eq!(fs::read_to_string(&dest).unwrap(), SOURCE);
            assert_eq!(
                fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }

    /// A symlink at the path is replaced, never followed, even one whose target holds the
    /// script.
    #[cfg(unix)]
    #[test]
    fn install_replaces_a_symlink_without_following_it() {
        let tmp = tempdir().unwrap();
        let dest = tmp.path().join(NAME);
        for target in ["nowhere.sh", "other.sh"] {
            let target = tmp.path().join(target);
            if target.ends_with("other.sh") {
                fs::write(&target, SOURCE).unwrap();
            }
            let _ = fs::remove_file(&dest);
            std::os::unix::fs::symlink(&target, &dest).unwrap();
            install(tmp.path()).unwrap();
            assert!(fs::symlink_metadata(&dest).unwrap().file_type().is_file());
            assert_eq!(fs::read_to_string(&dest).unwrap(), SOURCE);
        }
        assert!(!tmp.path().join("nowhere.sh").exists(), "never followed");
    }

    #[test]
    fn the_guard_command_is_guarded_like_the_status_command() {
        assert_eq!(
            guard_command(),
            "[ -x \"$CODESENSE_ACTIVITY_HOST/codesense-secret-guard.sh\" ] && \"$CODESENSE_ACTIVITY_HOST/codesense-secret-guard.sh\" || true"
        );
    }

    #[test]
    fn install_writes_the_guard_beside_the_status_hook() {
        let tmp = tempdir().unwrap();
        install(tmp.path()).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(GUARD_NAME)).unwrap(),
            guard_source()
        );
        assert_eq!(fs::read_to_string(tmp.path().join(NAME)).unwrap(), SOURCE);
    }

    #[test]
    fn the_guard_list_is_host_protos() {
        assert!(std::ptr::eq(
            deny_rules(),
            codesense_host_proto::hook::deny_rules()
        ));
        assert_eq!(guard_source(), codesense_host_proto::hook::guard_source());
    }
}

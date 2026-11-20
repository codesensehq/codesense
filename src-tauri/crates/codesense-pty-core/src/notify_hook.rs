// SPDX-License-Identifier: MIT
//! Claude's hooks as CodeSense's own install serves them.
//!
//! The hooks run `codesense-bridge hook <verb>` (`codesense_host_proto::hook`). The bridge is
//! part of CodeSense's own install, never of a workspace or team content: every host places it
//! in its activity root, beside the activity helper, when it starts ([`install`]). A Claude
//! session reaches it through its tab's `$CODESENSE_ACTIVITY_HOST`, as its inbox hooks reach
//! the helper ([`status_command`]). The status hook posts Claude Code lifecycle events to the
//! running CodeSense app so terminal status dots and the agent list stay live; the guard keeps
//! credential files out of transcripts.
//!
//! Lives in `codesense-pty-core` because both the main `codesense` binary and the
//! `codesense-session-server` sidecar run a host.

use std::fs;
use std::io;
use std::path::Path;

use codesense_host_proto::hook::{self, HookTarget, Verb};

use crate::activity::HelperLink;

/// The status script an earlier CodeSense installed in a host's activity root.
pub const NAME: &str = "codesense-notify.sh";

/// The guard script an earlier CodeSense installed in a host's activity root.
pub const GUARD_NAME: &str = "codesense-secret-guard.sh";

/// The tools the guard is scoped to, as a hook matcher.
pub const GUARD_MATCHER: &str = "Read|Grep|Glob|Bash";

/// The protected list lives beside the guard's verdict in `codesense-host-proto`, so the guard
/// and Claude's `permissions.deny` rules keep one list.
pub use codesense_host_proto::hook::{deny_rules, Family, FAMILIES, PROTECTED_DIRS};

/// The command the guard hook runs on this host ([`hook::command`]).
pub fn guard_command() -> String {
    hook::command(Verb::SecretGuard, HookTarget::local()).command
}

/// The command a Claude status hook runs on this host ([`hook::command`]).
pub fn status_command() -> String {
    hook::command(Verb::Notify, HookTarget::local()).command
}

/// Ready the host activity `root` for Claude's hooks: place the host's `bridge` there, where
/// [`hook::command`] runs it, as `how` places the activity helper; and remove the scripts an
/// earlier CodeSense installed there. With no bridge nothing is placed and it says so once: the
/// guarded hook commands then do nothing.
pub fn install(root: &Path, bridge: Option<&Path>, how: HelperLink) -> io::Result<()> {
    let mut removed = Ok(());
    for name in [NAME, GUARD_NAME] {
        match fs::remove_file(root.join(name)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                removed = removed.and(Err(error))
            }
            _ => {}
        }
    }
    let placed = match bridge {
        Some(bridge) => place_bridge(bridge, &root.join(HookTarget::local().bridge_file()), how),
        None => {
            log::warn!(
                "no codesense-bridge on this host: Claude's status and guard hooks do nothing"
            );
            Ok(())
        }
    };
    removed.and(placed)
}

/// Place `bridge` at `dest` with the function that places the activity helper.
fn place_bridge(bridge: &Path, dest: &Path, how: HelperLink) -> io::Result<()> {
    let _ = (bridge, dest, how);
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "bridge placement is not wired yet",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn the_hook_commands_are_the_local_targets() {
        let local = HookTarget::local();
        assert_eq!(status_command(), hook::command(Verb::Notify, local).command);
        assert_eq!(
            guard_command(),
            hook::command(Verb::SecretGuard, local).command
        );
    }

    /// The scripts an earlier CodeSense installed in the root are removed, whether or not the
    /// host has a bridge to place; anything else there stays.
    #[test]
    fn install_removes_the_old_scripts_with_or_without_a_bridge() {
        let bridge = tempdir().unwrap();
        let bridge = bridge.path().join(hook::BRIDGE);
        fs::write(&bridge, b"bridge").unwrap();
        for given in [None, Some(bridge.as_path())] {
            let tmp = tempdir().unwrap();
            for name in [NAME, GUARD_NAME, "keep.sh"] {
                fs::write(tmp.path().join(name), b"#!/bin/sh\n").unwrap();
            }
            let _ = install(tmp.path(), given, HelperLink::Hard);
            assert!(!tmp.path().join(NAME).exists(), "{given:?}");
            assert!(!tmp.path().join(GUARD_NAME).exists(), "{given:?}");
            assert!(tmp.path().join("keep.sh").exists(), "{given:?}");
        }
    }

    /// With no bridge nothing is placed, and that is not a failure.
    #[test]
    fn install_without_a_bridge_places_nothing() {
        let tmp = tempdir().unwrap();
        install(tmp.path(), None, HelperLink::Hard).unwrap();
        install(tmp.path(), None, HelperLink::Hard).unwrap();
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_guard_list_is_host_protos() {
        assert!(std::ptr::eq(
            deny_rules(),
            codesense_host_proto::hook::deny_rules()
        ));
    }
}

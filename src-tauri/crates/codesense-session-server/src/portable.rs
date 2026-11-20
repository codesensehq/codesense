// SPDX-License-Identifier: MIT
//! The items the app reads from otherwise gated modules, compiled on every
//! target. Each keeps its old path: its module re-exports it, and when that
//! module is gated off, `lib.rs` puts a stand-in module there.

/// How long a session may sit at its prompt without its agent CLI in the
/// foreground before a queued wake for it is `session_ended`.
pub const AGENT_QUIT_GRACE_MS: u64 = 3_000;

#[cfg(test)]
mod tests {
    // The app reads these at their old paths on every target, whether or not
    // the module they are named under is compiled.
    #[test]
    fn the_apps_items_keep_their_paths_on_every_target() {
        assert_eq!(
            crate::session_wake::AGENT_QUIT_GRACE_MS,
            super::AGENT_QUIT_GRACE_MS
        );
        let owner = crate::machine_owner::MachineOwner::Local {
            id: "12e45678-e89b-42d3-a456-426614174000".into(),
        };
        assert!(owner.validate().is_ok());
    }
}

// SPDX-License-Identifier: MIT
//! The Hermes managed runtime where the `agent-cli-sockets` capability is
//! off. A Hermes TUI session needs the Hermes gateway, which that capability
//! gates, so a launch fails closed before any home is seeded, and there is
//! nothing to tear down or sweep.

use std::path::Path;

pub(super) fn seed_home(_home: &Path, _program: &Path) -> Result<Vec<(String, String)>, String> {
    Err(codesense_pty_core::caps_off("agent-cli-sockets").to_string())
}

pub(crate) fn teardown_home(_home: &Path) {}

pub(crate) fn sweep(_scopes: &Path) {}

#[cfg(test)]
mod tests {
    #[test]
    fn seeding_a_home_fails_with_the_capability_off_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let error = super::seed_home(&home, &dir.path().join("hermes")).unwrap_err();
        assert_eq!(
            error,
            codesense_pty_core::caps_off("agent-cli-sockets").to_string()
        );
        assert!(!home.exists());
        super::teardown_home(&home);
        super::sweep(dir.path());
        assert!(!home.exists());
    }
}

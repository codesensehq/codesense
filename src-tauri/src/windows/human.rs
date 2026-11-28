// SPDX-License-Identifier: MIT
//! The one check of whether a window is a person's: [`is_human_window`]. The person-only gates
//! (`wake.rs` `person_in`, `data_read_model.rs` `require_native_spend_window` and
//! `interactive_gate.rs` `grant_trusted_capability` through [`grant_window_gate`]) call it, so a
//! satellite a person uses passes them like `main`.
//!
//! A window is a person's when it is `main`, or a window the registry holds that is no longer
//! pending. A label's shape (`pane-*`) is never enough: a webview the registry does not hold,
//! or one still booting, is refused.

use super::label::is_main;
use super::registry::{Locked, WindowRegistry};

/// Whether `label` is `main` or a registered window that is not pending.
pub fn is_human_window(registry: &WindowRegistry, label: &str) -> bool {
    if is_main(label) {
        return true;
    }
    let locked = WindowRegistry::locked(registry);
    Locked::has_window(&locked, label) && !Locked::is_pending(&locked, label)
}

/// `grant_trusted_capability`'s window check: the caller must be a person's window and on
/// screen. Both refusals keep the command's existing text.
pub fn grant_window_gate(
    registry: &WindowRegistry,
    label: &str,
    visible: bool,
) -> Result<(), String> {
    if !is_human_window(registry, label) || !visible {
        return Err("interactive_authorization_required".into());
    }
    Ok(())
}

#[cfg(test)]
mod gates {
    use super::*;
    use crate::windows::registry::test_host::Recorder;

    /// `main`, a ready `sat-1` and a pending `sat-2`.
    fn reg() -> WindowRegistry {
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-1").unwrap();
        reg.ready(&host, "sat-1").unwrap();
        reg.add_satellite(&host, "sat-2").unwrap();
        reg
    }

    #[test]
    fn main_is_a_human_window() {
        assert!(is_human_window(&reg(), "main"));
        assert!(is_human_window(&WindowRegistry::new(), "main"));
    }

    #[test]
    fn a_registered_ready_satellite_is_a_human_window() {
        assert!(is_human_window(&reg(), "sat-1"));
    }

    #[test]
    fn an_unregistered_label_is_refused_whatever_its_shape() {
        let reg = reg();
        for label in ["pane-zzz", "sat-9", "dashboard", ""] {
            assert!(!is_human_window(&reg, label), "{label}");
        }
    }

    #[test]
    fn a_pending_satellite_is_refused_until_it_is_ready() {
        let host = Recorder::default();
        let reg = reg();
        assert!(!is_human_window(&reg, "sat-2"));
        reg.ready(&host, "sat-2").unwrap();
        assert!(is_human_window(&reg, "sat-2"));
    }

    #[test]
    fn the_grant_gate_takes_a_visible_human_window_only() {
        let reg = reg();
        assert_eq!(grant_window_gate(&reg, "main", true), Ok(()));
        assert_eq!(grant_window_gate(&reg, "sat-1", true), Ok(()));
        let refused = Err("interactive_authorization_required".to_owned());
        assert_eq!(grant_window_gate(&reg, "sat-1", false), refused);
        assert_eq!(grant_window_gate(&reg, "main", false), refused);
        assert_eq!(grant_window_gate(&reg, "pane-zzz", true), refused);
        assert_eq!(grant_window_gate(&reg, "sat-2", true), refused);
    }
}

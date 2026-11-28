// SPDX-License-Identifier: MIT
//! Which window an action lands in: [`resolve_target`] is the one place that decides. It
//! returns a label and nothing else: it takes no host, and never focuses or raises a window.
//! Focusing is the caller's job (for `ShowLayout`, the caller focuses the holder it gets
//! back).
//!
//! A named window must be registered and ready. With none named, the default is a registry
//! lookup, never a read inside a Layout:
//!
//! | Action | Default |
//! |---|---|
//! | `Viewer` | `main` |
//! | `ForItem(key)` | the owner of `key`, else `main`, whatever its kind |
//! | `PaneOpen { workspace }` | the owner of `workspace`, else `main`; `main` too when that owner holds no Layout (it has no room for a panel) |
//! | `ShowLayout { layout, caller }` | the window holding `layout`, else `caller` |
//! | `Focused` | the focused window, then the last-focused one, then `main` |
//!
//! A default never lands in a pending window: one that is the answer falls through to the
//! next choice in its row.
// The viewer, pane-open, layout and focus commands call this; until they move onto it only the
// tests do.
#![cfg_attr(not(test), allow(dead_code))]

use super::item_key::ItemKey;
use super::label::MAIN_LABEL;
use super::registry::{Locked, WindowRegistry};

/// What a window is wanted for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetAction {
    /// A viewer or dashboard open.
    Viewer,
    ForItem(ItemKey),
    /// `pane_open` from an agent: the calling agent's workspace key.
    PaneOpen {
        workspace: ItemKey,
    },
    ShowLayout {
        layout: String,
        caller: String,
    },
    /// `"focused"`.
    Focused,
}

/// Which window has focus, and which had it last.
pub trait FocusSource {
    fn focused_window(&self) -> Option<String>;
    fn last_focused_window(&self) -> Option<String>;
}

/// A focus source that knows no focus, so `Focused` resolves to `main`.
#[derive(Debug, Default, Clone, Copy)]
pub struct MainOnly;

impl FocusSource for MainOnly {
    fn focused_window(&self) -> Option<String> {
        None
    }

    fn last_focused_window(&self) -> Option<String> {
        None
    }
}

/// The label `action` lands in: `window` when named (it must exist and be ready), else the
/// default above.
pub fn resolve_target(
    registry: &WindowRegistry,
    action: TargetAction,
    window: Option<&str>,
    focus: &dyn FocusSource,
) -> Result<String, String> {
    let locked = WindowRegistry::locked(registry);
    if let Some(label) = window {
        if !Locked::has_window(&locked, label) {
            return Err(format!("unknown window {label:?}"));
        }
        if Locked::is_pending(&locked, label) {
            return Err(format!("window not ready: {label:?}"));
        }
        return Ok(label.to_owned());
    }
    let ready =
        |label: &String| Locked::has_window(&locked, label) && !Locked::is_pending(&locked, label);
    let main = || MAIN_LABEL.to_owned();
    Ok(match action {
        TargetAction::Viewer => main(),
        TargetAction::ForItem(key) => {
            Option::filter(Some(Locked::item_owner(&locked, &key)), ready).unwrap_or_else(main)
        }
        TargetAction::PaneOpen { workspace } => {
            let owner = Locked::item_owner(&locked, &workspace);
            let room = owner == MAIN_LABEL
                || (ready(&owner) && Option::is_some(&Locked::layout_ref_of(&locked, &owner)));
            if room {
                owner
            } else {
                main()
            }
        }
        TargetAction::ShowLayout { layout, caller } => {
            Option::filter(Locked::layout_holder(&locked, &layout), ready).unwrap_or(caller)
        }
        TargetAction::Focused => Option::filter(FocusSource::focused_window(focus), ready)
            .or_else(|| Option::filter(FocusSource::last_focused_window(focus), ready))
            .unwrap_or_else(main),
    })
}

#[cfg(test)]
mod defaults {
    use super::*;
    use crate::windows::registry::test_host::Recorder;

    fn key(kind: &str, id: &str) -> ItemKey {
        ItemKey {
            kind: kind.into(),
            team: "acme:docs".into(),
            id: id.into(),
        }
    }

    fn workspace() -> ItemKey {
        key("workspace", "ws-1")
    }

    /// `main`, a ready `sat-1` holding the workspace key, and a pending `sat-2`.
    fn reg(host: &Recorder) -> WindowRegistry {
        let reg = WindowRegistry::new();
        reg.add_satellite(host, "sat-1").unwrap();
        reg.ready(host, "sat-1").unwrap();
        reg.reassign_item(host, &workspace(), "sat-1").unwrap();
        reg.add_satellite(host, "sat-2").unwrap();
        reg
    }

    fn resolve(reg: &WindowRegistry, action: TargetAction) -> String {
        resolve_target(reg, action, None, &MainOnly).unwrap()
    }

    struct Focus(Option<&'static str>, Option<&'static str>);

    impl FocusSource for Focus {
        fn focused_window(&self) -> Option<String> {
            self.0.map(str::to_owned)
        }

        fn last_focused_window(&self) -> Option<String> {
            self.1.map(str::to_owned)
        }
    }

    #[test]
    fn a_viewer_opens_in_main() {
        let host = Recorder::default();
        assert_eq!(resolve(&reg(&host), TargetAction::Viewer), "main");
    }

    #[test]
    fn an_item_goes_to_its_owner_whatever_its_kind_else_main() {
        let host = Recorder::default();
        let reg = reg(&host);
        assert_eq!(resolve(&reg, TargetAction::ForItem(workspace())), "sat-1");
        assert_eq!(
            resolve(&reg, TargetAction::ForItem(key("tab", "/repo/a.md"))),
            "main"
        );
    }

    #[test]
    fn a_pane_goes_to_its_workspace_owner_only_when_that_window_holds_a_layout() {
        let host = Recorder::default();
        let reg = reg(&host);
        let pane = || TargetAction::PaneOpen {
            workspace: workspace(),
        };
        assert_eq!(resolve(&reg, pane()), "main");
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        assert_eq!(resolve(&reg, pane()), "sat-1");
        let unowned = TargetAction::PaneOpen {
            workspace: key("workspace", "ws-2"),
        };
        assert_eq!(resolve(&reg, unowned), "main");
    }

    #[test]
    fn a_layout_shows_in_its_holder_else_in_the_caller_and_nothing_is_focused() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        host.clear();
        let show = |layout: &str| TargetAction::ShowLayout {
            layout: layout.into(),
            caller: "main".into(),
        };
        assert_eq!(resolve(&reg, show("grp_a")), "sat-1");
        assert_eq!(resolve(&reg, show("grp_b")), "main");
        assert!(host.focused().is_empty());
    }

    #[test]
    fn an_item_held_by_a_pending_window_goes_to_main() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.set_pending(&host, "sat-1", true).unwrap();
        assert_eq!(resolve(&reg, TargetAction::ForItem(workspace())), "main");
    }

    #[test]
    fn a_pane_whose_workspace_owner_is_pending_goes_to_main() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        reg.set_pending(&host, "sat-1", true).unwrap();
        let pane = TargetAction::PaneOpen {
            workspace: workspace(),
        };
        assert_eq!(resolve(&reg, pane), "main");
    }

    #[test]
    fn a_layout_held_by_a_pending_window_shows_in_the_caller() {
        let host = Recorder::default();
        let reg = reg(&host);
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        reg.set_pending(&host, "sat-1", true).unwrap();
        let show = TargetAction::ShowLayout {
            layout: "grp_a".into(),
            caller: "main".into(),
        };
        assert_eq!(resolve(&reg, show), "main");
    }

    #[test]
    fn a_named_window_must_exist_and_be_ready() {
        let host = Recorder::default();
        let reg = reg(&host);
        let named = |label| resolve_target(&reg, TargetAction::Viewer, Some(label), &MainOnly);
        assert_eq!(named("sat-1"), Ok("sat-1".to_owned()));
        assert_eq!(named("main"), Ok("main".to_owned()));
        assert!(named("sat-2").unwrap_err().starts_with("window not ready"));
        assert!(named("sat-9").unwrap_err().starts_with("unknown window"));
    }

    #[test]
    fn focused_is_main_with_the_default_source() {
        let host = Recorder::default();
        assert_eq!(resolve(&reg(&host), TargetAction::Focused), "main");
    }

    #[test]
    fn focused_takes_the_focused_then_the_last_focused_skipping_pending_and_unknown() {
        let host = Recorder::default();
        let reg = reg(&host);
        let focused = |focus: Focus| resolve_target(&reg, TargetAction::Focused, None, &focus);
        assert_eq!(focused(Focus(Some("sat-1"), None)), Ok("sat-1".to_owned()));
        assert_eq!(
            focused(Focus(Some("sat-2"), Some("sat-1"))),
            Ok("sat-1".to_owned())
        );
        assert_eq!(
            focused(Focus(Some("sat-9"), Some("sat-2"))),
            Ok("main".to_owned())
        );
    }
}

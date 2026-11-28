// SPDX-License-Identifier: MIT
//! The one way items leave a window that is going away: [`return_by_kind_locked`] gives each
//! key back to `main` and tells `main` once, whatever the item's kind and whatever the reason.
//! `main` decides what to reopen (`src/shared/windows/items-returned.ts`).
//!
//! A caller that drops the window in the same transaction holds the lock, calls the `_locked`
//! form, then `Locked::remove_empty_satellite`, and destroys the window once the lock is
//! released. A caller that removes nothing calls [`return_by_kind`].
// The window close, crash, restore and team-removal paths call these; until they land only
// the tests do.
#![cfg_attr(not(test), allow(dead_code))]

use serde::Serialize;

use super::item_key::ItemKey;
use super::label::MAIN_LABEL;
use super::moves::{MoveHost, ITEMS_RETURNED_EVENT};
use super::registry::{Locked, WindowRegistry};

/// Why items come back to `main`. On the wire as the snake_case name; `main`'s handler also
/// takes `move`, which a move that brings an item back sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReturnReason {
    Close,
    Crash,
    Boot,
    FailedRestore,
    ProfileSwitch,
    RemovedTeam,
    /// The window's repo was removed; handled like `Close`.
    RepoRemoved,
}

/// Returns `items` to `main` under the held lock, then sends `main` one
/// `window:items-returned`. Each transfer sends `main` its new owner map before the event; a
/// key no satellite holds sends nothing and is still in the event. There is no per-kind or
/// per-reason branch: `main`'s handler decides.
pub fn return_by_kind_locked(
    host: &impl MoveHost,
    locked: &mut Locked<'_>,
    items: &[ItemKey],
    reason: ReturnReason,
) {
    // Until the registry carries a shell flag, a shell window's keys return like any other.
    for key in items {
        if let Err(e) = Locked::reassign_item(locked, host, key, MAIN_LABEL) {
            log::warn!(target: "windows", "{} not returned: {e}", ItemKey::canonical(key));
        }
    }
    // Journal seam: every reason but `Boot` records the return here, once the window journal
    // exists.
    MoveHost::send_event(
        host,
        MAIN_LABEL,
        ITEMS_RETURNED_EVENT,
        serde_json::json!({ "items": items, "reason": reason }),
    );
}

/// [`return_by_kind_locked`] under the registry's lock, for a caller that removes no window.
pub fn return_by_kind(
    host: &impl MoveHost,
    registry: &WindowRegistry,
    items: &[ItemKey],
    reason: ReturnReason,
) {
    let mut locked = WindowRegistry::locked(registry);
    return_by_kind_locked(host, &mut locked, items, reason);
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::windows::moves::MoveTimer;
    use crate::windows::registry::{WindowHost, WindowSlice};
    use std::cell::RefCell;

    #[derive(Debug, Clone, PartialEq)]
    pub enum Fx {
        Slice(String),
        Event(String, String, serde_json::Value),
    }

    /// Records the slices and events a return sends, in order.
    #[derive(Default)]
    pub struct Rec {
        pub fx: RefCell<Vec<Fx>>,
    }

    impl Rec {
        pub fn returned(&self) -> Vec<serde_json::Value> {
            Iterator::filter_map(self.fx.borrow().iter(), |f| match f {
                Fx::Event(label, event, payload)
                    if label == MAIN_LABEL && event == ITEMS_RETURNED_EVENT =>
                {
                    Some(payload.clone())
                }
                _ => None,
            })
            .collect()
        }

        pub fn slices_to(&self, label: &str) -> usize {
            Iterator::filter(
                self.fx.borrow().iter(),
                |f| matches!(f, Fx::Slice(l) if l == label),
            )
            .count()
        }

        pub fn clear(&self) {
            self.fx.borrow_mut().clear();
        }
    }

    impl WindowHost for Rec {
        fn send_slice(&self, slice: &WindowSlice) {
            self.fx.borrow_mut().push(Fx::Slice(slice.label.clone()));
        }

        fn focus(&self, _: &str) {}
    }

    impl MoveHost for Rec {
        fn send_event(&self, label: &str, event: &str, payload: serde_json::Value) {
            self.fx
                .borrow_mut()
                .push(Fx::Event(label.to_owned(), event.to_owned(), payload));
        }

        fn window_exists(&self, _: &str) -> bool {
            true
        }

        fn create_window(&self, _: &str) -> Result<(), String> {
            Ok(())
        }

        fn destroy_window(&self, _: &str) {}

        fn schedule(&self, _: u64, _: MoveTimer) {}
    }

    pub fn key(kind: &str, team: &str, id: &str) -> ItemKey {
        ItemKey {
            kind: kind.into(),
            team: team.into(),
            id: id.into(),
        }
    }

    /// `main` plus a ready satellite per `(label, held keys)`, and a cleared recorder.
    pub fn reg(windows: &[(&str, &[ItemKey])]) -> (WindowRegistry, Rec) {
        let rec = Rec::default();
        let reg = WindowRegistry::new();
        for (label, keys) in windows {
            reg.add_satellite(&rec, label).unwrap();
            reg.ready(&rec, label).unwrap();
            for k in *keys {
                reg.reassign_item(&rec, k, label).unwrap();
            }
        }
        rec.clear();
        (reg, rec)
    }
}

#[cfg(test)]
mod by_kind {
    use super::bench::*;
    use super::*;

    const ALL: [ReturnReason; 7] = [
        ReturnReason::Close,
        ReturnReason::Crash,
        ReturnReason::Boot,
        ReturnReason::FailedRestore,
        ReturnReason::ProfileSwitch,
        ReturnReason::RemovedTeam,
        ReturnReason::RepoRemoved,
    ];

    fn tab(id: &str) -> ItemKey {
        key("tab", "acme:docs", id)
    }

    #[test]
    fn each_reason_returns_the_key_to_main_and_names_itself_on_the_wire() {
        let wire = [
            "close",
            "crash",
            "boot",
            "failed_restore",
            "profile_switch",
            "removed_team",
            "repo_removed",
        ];
        for (reason, name) in ALL.into_iter().zip(wire) {
            let a = tab("/repo/a.md");
            let (reg, rec) = reg(&[("sat-1", &[a.clone()])]);
            return_by_kind(&rec, &reg, &[a.clone()], reason);
            assert_eq!(reg.owner(&a), MAIN_LABEL, "{name}");
            assert_eq!(
                rec.returned(),
                vec![serde_json::json!({ "items": [a], "reason": name })],
                "{name}"
            );
        }
    }

    #[test]
    fn the_owner_map_reaches_main_before_the_event() {
        let a = tab("/repo/a.md");
        let (reg, rec) = reg(&[("sat-1", &[a.clone()])]);
        return_by_kind(&rec, &reg, &[a], ReturnReason::Close);
        let fx = rec.fx.borrow();
        let map = fx
            .iter()
            .position(|f| matches!(f, Fx::Slice(l) if l == MAIN_LABEL))
            .expect("main's slice");
        let event = fx
            .iter()
            .position(|f| matches!(f, Fx::Event(..)))
            .expect("the event");
        assert!(map < event, "{fx:?}");
        assert_eq!(event, fx.len() - 1, "the event is last: {fx:?}");
    }

    #[test]
    fn a_workspace_key_and_an_unknown_kind_return_like_a_tab() {
        let workspace = key("workspace", "acme:docs", "ws-1");
        let newer = key("hologram", "acme:docs", "h-1");
        let (reg, rec) = reg(&[("sat-1", &[workspace.clone(), newer.clone()])]);
        let items = [workspace.clone(), newer.clone()];
        return_by_kind(&rec, &reg, &items, ReturnReason::Crash);
        assert_eq!(reg.owner(&workspace), MAIN_LABEL);
        assert_eq!(reg.owner(&newer), MAIN_LABEL);
        assert_eq!(
            rec.returned(),
            vec![serde_json::json!({ "items": items, "reason": "crash" })]
        );
    }

    #[test]
    fn an_unheld_boot_key_sends_nothing_but_the_event_and_is_in_it() {
        let a = tab("/repo/a.md");
        let (reg, rec) = reg(&[]);
        return_by_kind(&rec, &reg, &[a.clone()], ReturnReason::Boot);
        assert_eq!(reg.owner(&a), MAIN_LABEL);
        assert_eq!(rec.slices_to(MAIN_LABEL), 0);
        assert_eq!(
            rec.returned(),
            vec![serde_json::json!({ "items": [a], "reason": "boot" })]
        );
        assert_eq!(rec.fx.borrow().len(), 1);
    }

    #[test]
    fn n_held_keys_send_n_slices_to_main_and_one_event() {
        let keys = [tab("/repo/a.md"), tab("/repo/b.md"), tab("/repo/c.md")];
        let (reg, rec) = reg(&[("sat-1", &keys[..2]), ("sat-2", &keys[2..])]);
        return_by_kind(&rec, &reg, &keys, ReturnReason::ProfileSwitch);
        assert_eq!(rec.slices_to(MAIN_LABEL), 3);
        assert_eq!(rec.returned().len(), 1);
        for k in &keys {
            assert_eq!(reg.owner(k), MAIN_LABEL);
        }
    }

    #[test]
    fn the_locked_form_then_removing_the_window_under_one_lock() {
        let keys = [tab("/repo/a.md"), key("workspace", "acme:docs", "ws-1")];
        let (reg, rec) = reg(&[("sat-1", &keys)]);
        {
            let mut locked = WindowRegistry::locked(&reg);
            return_by_kind_locked(&rec, &mut locked, &keys, ReturnReason::Close);
            Locked::remove_empty_satellite(&mut locked, "sat-1").unwrap();
            assert!(!Locked::has_window(&locked, "sat-1"));
        }
        for k in &keys {
            assert_eq!(reg.owner(k), MAIN_LABEL);
        }
        assert_eq!(rec.returned().len(), 1);
    }
}

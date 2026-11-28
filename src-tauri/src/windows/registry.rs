// SPDX-License-Identifier: MIT
//! `WindowRegistry`: one entry per window, `{label, kind, layoutRef, items, pending}`.
//!
//! - **Slices.** Each window reads its own entry as a versioned [`WindowSlice`]. Every
//!   change bumps the affected windows' versions and is sent with `emit_to` to those
//!   labels only; nothing here broadcasts (the `windows_no_broadcast_guard` scans this
//!   file). A booting window pulls its slice once its listeners have mounted, calls
//!   `window_ready`, and ignores any slice older than the version it holds.
//! - **Ownership.** `items` holds satellite items only. The owner of a key is the
//!   satellite whose `items` hold it, else `main`. `items` is private to this file and
//!   changed only by the transaction methods below, so no other module can move an item.
//! - **One Layout per window.** `layoutRef` is an opaque Layout id or `None`; two windows
//!   never hold the same non-null one.
//!
//! A few std calls are written as paths (`Iterator::find(..)`, `Vec::is_empty(..)`) or
//! reborrows (`&*label`) so `explicit_sync_unattended_writer_guard`'s call graph resolves
//! them without a ceiling raise.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime};

use super::item_key::ItemKey;
use super::label::MAIN_LABEL;

/// The event a window's new slice is sent on, to that window only.
pub const SLICE_EVENT: &str = "window:slice";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Main,
    Satellite,
}

/// One window's entry. `items` is private: only this file's methods change it.
#[derive(Debug)]
pub struct WindowEntry {
    label: String,
    kind: WindowKind,
    layout_ref: Option<String>,
    items: BTreeSet<ItemKey>,
    pending: bool,
    version: u64,
}

impl WindowEntry {
    fn new(label: &str, kind: WindowKind, pending: bool) -> Self {
        Self {
            label: label.to_owned(),
            kind,
            layout_ref: None,
            items: BTreeSet::new(),
            pending,
            version: 1,
        }
    }
}

/// What a window reads of its own entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSlice {
    pub label: String,
    pub kind: WindowKind,
    pub version: u64,
    pub layout_ref: Option<String>,
    pub items: Vec<ItemKey>,
    pub pending: bool,
    /// `main`'s slice only: every satellite-owned key (canonical string) → its owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<BTreeMap<String, String>>,
}

/// The result of `window_set_layout`: `focused` names the window that already held the
/// Layout (and was focused instead); `None` means the Layout was set or already held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetLayoutOutcome {
    pub focused: Option<String>,
}

/// Where the registry's effects land: a slice sent to one window, a window focused.
pub trait WindowHost {
    fn send_slice(&self, slice: &WindowSlice);
    fn focus(&self, label: &str);
}

impl<R: Runtime> WindowHost for tauri::AppHandle<R> {
    fn send_slice(&self, slice: &WindowSlice) {
        if let Err(e) = self.emit_to(&*slice.label, SLICE_EVENT, slice) {
            log::warn!(target: "windows", "slice v{} to {} not sent: {e}", slice.version, slice.label);
        }
    }

    fn focus(&self, label: &str) {
        match self.get_webview_window(label) {
            Some(window) => {
                if let Err(e) = window.set_focus() {
                    log::warn!(target: "windows", "focus {label} failed: {e}");
                }
            }
            None => log::warn!(target: "windows", "focus {label}: no such window"),
        }
    }
}

#[derive(Debug)]
struct State {
    entries: BTreeMap<String, WindowEntry>,
}

impl State {
    fn entry(&self, label: &str) -> Result<&WindowEntry, String> {
        self.entries
            .get(label)
            .ok_or_else(|| format!("no window {label:?}"))
    }

    fn owner(&self, key: &ItemKey) -> &str {
        Iterator::find(&mut self.entries.values(), |e| e.items.contains(key))
            .map_or(MAIN_LABEL, |e| e.label.as_str())
    }

    fn owners(&self) -> BTreeMap<String, String> {
        self.entries
            .values()
            .flat_map(|e| e.items.iter().map(|k| (k.canonical(), e.label.clone())))
            .collect()
    }

    fn slice(&self, label: &str) -> Result<WindowSlice, String> {
        let e = self.entry(label)?;
        Ok(WindowSlice {
            label: e.label.clone(),
            kind: e.kind,
            version: e.version,
            layout_ref: e.layout_ref.clone(),
            items: e.items.iter().cloned().collect(),
            pending: e.pending,
            owners: (e.kind == WindowKind::Main).then(|| self.owners()),
        })
    }

    /// Bumps `label`'s version and sends it its new slice, while the lock is held so
    /// slices reach each window in version order.
    fn bump_slice(&mut self, host: &impl WindowHost, label: &str) {
        if let Some(e) = self.entries.get_mut(label) {
            e.version += 1;
        }
        if let Ok(slice) = self.slice(label) {
            host.send_slice(&slice);
        }
    }
}

/// Tauri managed state: every window, created with `main`'s entry.
#[derive(Debug)]
pub struct WindowRegistry {
    state: Mutex<State>,
}

impl Default for WindowRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowRegistry {
    pub fn new() -> Self {
        let main = WindowEntry::new(MAIN_LABEL, WindowKind::Main, false);
        Self {
            state: Mutex::new(State {
                entries: BTreeMap::from([(MAIN_LABEL.to_owned(), main)]),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The window that owns `key`: the satellite whose `items` hold it, else `main`.
    pub fn owner(&self, key: &ItemKey) -> String {
        self.lock().owner(key).to_owned()
    }

    /// `label`'s slice, read by that window or by `main`.
    pub fn get_slice(&self, caller: &str, label: &str) -> Result<WindowSlice, String> {
        if caller != label && caller != MAIN_LABEL {
            return Err(format!("{caller} cannot read the slice of {label}"));
        }
        self.lock().slice(label)
    }

    /// The window's listeners have mounted and it holds its slice. Clears `pending`.
    pub fn ready(&self, host: &impl WindowHost, label: &str) -> Result<(), String> {
        let mut state = self.lock();
        let entry = state
            .entries
            .get_mut(label)
            .ok_or_else(|| format!("no window {label:?}"))?;
        if entry.pending {
            entry.pending = false;
            state.bump_slice(host, label);
        }
        Ok(())
    }

    /// Sets `label`'s Layout. A window sets only its own; `main` may set any. When
    /// another window already holds the non-null `layout_ref`, nothing changes: that
    /// window is focused and named in the outcome.
    pub fn set_layout(
        &self,
        host: &impl WindowHost,
        caller: &str,
        label: &str,
        layout_ref: Option<String>,
    ) -> Result<SetLayoutOutcome, String> {
        if caller != label && caller != MAIN_LABEL {
            return Err(format!("{caller} cannot set the Layout of {label}"));
        }
        let mut state = self.lock();
        state.entry(label)?;
        if let Some(wanted) = layout_ref.as_deref() {
            let holder = Iterator::find(&mut state.entries.values(), |e| {
                e.label != label && e.layout_ref.as_deref() == Some(wanted)
            })
            .map(|e| e.label.clone());
            if let Some(holder) = holder {
                drop(state);
                host.focus(&holder);
                return Ok(SetLayoutOutcome {
                    focused: Some(holder),
                });
            }
        }
        let entry = state.entries.get_mut(label).expect("checked above");
        if entry.layout_ref != layout_ref {
            entry.layout_ref = layout_ref;
            state.bump_slice(host, label);
        }
        Ok(SetLayoutOutcome { focused: None })
    }

    /// Creates a satellite entry with no items, no Layout and `pending` set, and sends it
    /// its first slice. Bumps no other window.
    #[cfg_attr(not(test), allow(dead_code))] // Called when a window opens; nothing opens one yet.
    pub fn add_satellite(
        &self,
        host: &impl WindowHost,
        label: &str,
    ) -> Result<WindowSlice, String> {
        let mut state = self.lock();
        if state.entries.contains_key(label) {
            return Err(format!("window {label:?} already exists"));
        }
        state.entries.insert(
            label.to_owned(),
            WindowEntry::new(label, WindowKind::Satellite, true),
        );
        let slice = state.slice(label)?;
        host.send_slice(&slice);
        Ok(slice)
    }

    /// Sets `label`'s `pending` flag. Bumps only that window.
    #[cfg_attr(not(test), allow(dead_code))] // Called by the move; nothing moves an item yet.
    pub fn set_pending(
        &self,
        host: &impl WindowHost,
        label: &str,
        pending: bool,
    ) -> Result<(), String> {
        let mut state = self.lock();
        let entry = state
            .entries
            .get_mut(label)
            .ok_or_else(|| format!("no window {label:?}"))?;
        if entry.pending != pending {
            entry.pending = pending;
            state.bump_slice(host, label);
        }
        Ok(())
    }

    /// Moves `key` from its owner to `to` in one step; with `to` = `main` the key leaves
    /// every satellite. `main`'s new owner map is sent (a bump of `main`'s slice) before
    /// the satellites' slices and before this returns, so an item event a caller sends
    /// afterwards reaches `main` after the map. Returns whether anything changed.
    #[cfg_attr(not(test), allow(dead_code))] // Called by the move; nothing moves an item yet.
    pub fn reassign_item(
        &self,
        host: &impl WindowHost,
        key: &ItemKey,
        to: &str,
    ) -> Result<bool, String> {
        let mut state = self.lock();
        state.entry(to)?;
        let holders: Vec<String> = state
            .entries
            .values()
            .filter(|e| e.items.contains(key))
            .map(|e| e.label.clone())
            .collect();
        let to_main = to == MAIN_LABEL;
        if (Vec::is_empty(&holders) && to_main) || (holders.len() == 1 && holders[0] == to) {
            return Ok(false);
        }
        let mut changed: Vec<String> = Vec::new();
        for label in &holders {
            if label != to {
                if let Some(e) = state.entries.get_mut(label) {
                    e.items.remove(key);
                }
                changed.push(label.clone());
            }
        }
        if !to_main {
            if let Some(e) = state.entries.get_mut(to) {
                if e.items.insert(key.clone()) {
                    changed.push(to.to_owned());
                }
            }
        }
        state.bump_slice(host, MAIN_LABEL);
        for label in changed {
            state.bump_slice(host, &label);
        }
        Ok(true)
    }

    /// Returns `key` to `main`: it leaves its satellite. Returns whether it was held.
    #[cfg_attr(not(test), allow(dead_code))] // Called by the return path; nothing holds an item yet.
    pub fn return_to_main(&self, host: &impl WindowHost, key: &ItemKey) -> Result<bool, String> {
        self.reassign_item(host, key, MAIN_LABEL)
    }

    /// Focuses the satellite that owns `key`; a no-op for a key `main` owns. Returns the
    /// focused label.
    pub fn focus_owner(&self, host: &impl WindowHost, key: &ItemKey) -> Option<String> {
        let owner = self.owner(key);
        if owner == MAIN_LABEL {
            return None;
        }
        host.focus(&owner);
        Some(owner)
    }
}

#[cfg(test)]
pub(crate) mod test_host {
    use super::*;
    use std::cell::RefCell;

    /// Records every effect in order.
    #[derive(Default)]
    pub struct Recorder {
        pub effects: RefCell<Vec<Effect>>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Effect {
        Sent(WindowSlice),
        Focused(String),
    }

    impl Recorder {
        pub fn sent_to(&self) -> Vec<(String, u64)> {
            self.effects
                .borrow()
                .iter()
                .filter_map(|e| match e {
                    Effect::Sent(s) => Some((s.label.clone(), s.version)),
                    Effect::Focused(_) => None,
                })
                .collect()
        }

        pub fn focused(&self) -> Vec<String> {
            self.effects
                .borrow()
                .iter()
                .filter_map(|e| match e {
                    Effect::Focused(l) => Some(l.clone()),
                    Effect::Sent(_) => None,
                })
                .collect()
        }

        pub fn clear(&self) {
            self.effects.borrow_mut().clear();
        }
    }

    /// A window's receiving side: keeps the newest slice and ignores older ones.
    #[derive(Default)]
    pub struct Holder {
        pub held: Option<WindowSlice>,
    }

    impl Holder {
        pub fn accept(&mut self, slice: WindowSlice) -> bool {
            if self
                .held
                .as_ref()
                .is_some_and(|h| h.version >= slice.version)
            {
                return false;
            }
            self.held = Some(slice);
            true
        }
    }

    impl WindowHost for Recorder {
        fn send_slice(&self, slice: &WindowSlice) {
            self.effects.borrow_mut().push(Effect::Sent(slice.clone()));
        }

        fn focus(&self, label: &str) {
            self.effects
                .borrow_mut()
                .push(Effect::Focused(label.to_owned()));
        }
    }
}

#[cfg(test)]
mod slices {
    use super::test_host::{Holder, Recorder};
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use tauri::Listener;

    fn with_satellites(labels: &[&str]) -> WindowRegistry {
        let reg = WindowRegistry::new();
        {
            let mut state = reg.lock();
            for l in labels {
                state.entries.insert(
                    (*l).to_owned(),
                    WindowEntry::new(l, WindowKind::Satellite, true),
                );
            }
        }
        reg
    }

    #[test]
    fn main_exists_at_creation_with_version_one_and_no_items() {
        let reg = WindowRegistry::new();
        let slice = reg.get_slice(MAIN_LABEL, MAIN_LABEL).unwrap();
        assert_eq!(slice.kind, WindowKind::Main);
        assert_eq!(slice.version, 1);
        assert!(slice.items.is_empty());
        assert_eq!(slice.layout_ref, None);
        assert!(!slice.pending);
        assert_eq!(slice.owners, Some(BTreeMap::new()));
    }

    #[test]
    fn a_satellite_slice_has_no_owner_map() {
        let reg = with_satellites(&["sat-1"]);
        assert_eq!(reg.get_slice("sat-1", "sat-1").unwrap().owners, None);
    }

    #[test]
    fn a_window_reads_only_its_own_slice_and_main_reads_any() {
        let reg = with_satellites(&["sat-1", "sat-2"]);
        assert!(reg.get_slice("sat-1", "sat-2").is_err());
        assert!(reg.get_slice("sat-1", MAIN_LABEL).is_err());
        assert!(reg.get_slice(MAIN_LABEL, "sat-2").is_ok());
        assert!(reg.get_slice(MAIN_LABEL, "nope").is_err());
    }

    #[test]
    fn every_change_bumps_the_version() {
        let host = Recorder::default();
        let reg = with_satellites(&["sat-1"]);
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        reg.set_layout(&host, "sat-1", "sat-1", None).unwrap();
        assert_eq!(reg.get_slice("sat-1", "sat-1").unwrap().version, 3);
        assert_eq!(
            host.sent_to(),
            vec![("sat-1".into(), 2), ("sat-1".into(), 3)]
        );
    }

    #[test]
    fn a_no_op_change_bumps_nothing() {
        let host = Recorder::default();
        let reg = with_satellites(&["sat-1"]);
        reg.set_layout(&host, "sat-1", "sat-1", None).unwrap();
        reg.ready(&host, MAIN_LABEL).unwrap();
        assert!(host.sent_to().is_empty());
        assert_eq!(reg.get_slice("sat-1", "sat-1").unwrap().version, 1);
    }

    #[test]
    fn a_listener_that_mounts_late_pulls_then_readies() {
        let host = Recorder::default();
        let reg = with_satellites(&["sat-1"]);
        // A change lands before the window's listener exists: the emit is lost.
        reg.set_layout(&host, MAIN_LABEL, "sat-1", Some("grp_a".into()))
            .unwrap();
        let mut window = Holder::default();
        // Listener mounts, then pulls: the pull carries the change.
        assert!(window.accept(reg.get_slice("sat-1", "sat-1").unwrap()));
        assert_eq!(
            window.held.as_ref().unwrap().layout_ref.as_deref(),
            Some("grp_a")
        );
        host.clear();
        reg.ready(&host, "sat-1").unwrap();
        let [(label, version)] = host.sent_to().try_into().unwrap();
        assert_eq!(label, "sat-1");
        let ready = reg.get_slice("sat-1", "sat-1").unwrap();
        assert_eq!(ready.version, version);
        assert!(!ready.pending);
        assert!(window.accept(ready));
    }

    #[test]
    fn a_stale_emit_is_ignored() {
        let host = Recorder::default();
        let reg = with_satellites(&["sat-1"]);
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        let stale = reg.get_slice("sat-1", "sat-1").unwrap();
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_b".into()))
            .unwrap();
        let mut window = Holder::default();
        assert!(window.accept(reg.get_slice("sat-1", "sat-1").unwrap()));
        assert!(!window.accept(stale));
        assert_eq!(window.held.unwrap().layout_ref.as_deref(), Some("grp_b"));
    }

    #[test]
    fn in_three_windows_one_change_emits_once_to_the_affected_label() {
        let host = Recorder::default();
        let reg = with_satellites(&["sat-1", "sat-2"]);
        reg.set_layout(&host, MAIN_LABEL, "sat-2", Some("grp_a".into()))
            .unwrap();
        assert_eq!(host.sent_to(), vec![("sat-2".into(), 2)]);
        for other in [MAIN_LABEL, "sat-1"] {
            assert_eq!(reg.get_slice(MAIN_LABEL, other).unwrap().version, 1);
        }
    }

    #[test]
    fn emit_to_reaches_only_the_affected_webview() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let reg = with_satellites(&["sat-1", "sat-2"]);
        let seen: Arc<StdMutex<Vec<(String, u64)>>> = Arc::default();
        for label in [MAIN_LABEL, "sat-1", "sat-2"] {
            let window =
                tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
                    .build()
                    .unwrap();
            let seen = seen.clone();
            let me = label.to_owned();
            window.listen(SLICE_EVENT, move |event| {
                let v: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
                assert_eq!(v["label"], me.as_str());
                seen.lock()
                    .unwrap()
                    .push((me.clone(), v["version"].as_u64().unwrap()));
            });
        }
        reg.set_layout(app.handle(), MAIN_LABEL, "sat-1", Some("grp_a".into()))
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![("sat-1".to_owned(), 2)]);
    }

    #[test]
    fn the_slice_serializes_in_camel_case() {
        let reg = WindowRegistry::new();
        let v = serde_json::to_value(reg.get_slice(MAIN_LABEL, MAIN_LABEL).unwrap()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "label": "main", "kind": "main", "version": 1, "layoutRef": null,
                "items": [], "pending": false, "owners": {}
            })
        );
    }
}

#[cfg(test)]
mod layout {
    use super::test_host::Recorder;
    use super::*;

    fn reg() -> WindowRegistry {
        let reg = WindowRegistry::new();
        {
            let mut state = reg.lock();
            for l in ["sat-1", "sat-2"] {
                state.entries.insert(
                    l.to_owned(),
                    WindowEntry::new(l, WindowKind::Satellite, false),
                );
            }
        }
        reg
    }

    #[test]
    fn a_held_layout_focuses_its_owner_and_changes_nothing() {
        let host = Recorder::default();
        let reg = reg();
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        host.clear();
        let outcome = reg
            .set_layout(&host, "sat-2", "sat-2", Some("grp_a".into()))
            .unwrap();
        assert_eq!(outcome.focused.as_deref(), Some("sat-1"));
        assert_eq!(host.focused(), vec!["sat-1".to_owned()]);
        assert!(host.sent_to().is_empty());
        let sat2 = reg.get_slice("sat-2", "sat-2").unwrap();
        assert_eq!((sat2.layout_ref, sat2.version), (None, 1));
    }

    #[test]
    fn re_setting_a_window_s_own_layout_is_not_a_clash() {
        let host = Recorder::default();
        let reg = reg();
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        let again = reg
            .set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        assert_eq!(again.focused, None);
        assert!(host.focused().is_empty());
    }

    #[test]
    fn null_is_never_unique() {
        let host = Recorder::default();
        let reg = reg();
        for l in ["sat-1", "sat-2", MAIN_LABEL] {
            let out = reg.set_layout(&host, l, l, None).unwrap();
            assert_eq!(out.focused, None);
        }
        reg.set_layout(&host, "sat-1", "sat-1", Some("grp_a".into()))
            .unwrap();
        let out = reg.set_layout(&host, "sat-1", "sat-1", None).unwrap();
        assert_eq!(out.focused, None);
        assert_eq!(reg.get_slice("sat-1", "sat-1").unwrap().layout_ref, None);
        assert!(host.focused().is_empty());
    }

    #[test]
    fn a_satellite_cannot_set_another_window_s_layout() {
        let host = Recorder::default();
        let reg = reg();
        assert!(reg
            .set_layout(&host, "sat-1", "sat-2", Some("grp_a".into()))
            .is_err());
        assert!(reg
            .set_layout(&host, "sat-1", MAIN_LABEL, Some("grp_a".into()))
            .is_err());
        assert!(host.effects.borrow().is_empty());
    }

    #[test]
    fn main_may_set_any_window_s_layout() {
        let host = Recorder::default();
        let reg = reg();
        reg.set_layout(&host, MAIN_LABEL, "sat-2", Some("grp_a".into()))
            .unwrap();
        assert_eq!(
            reg.get_slice("sat-2", "sat-2")
                .unwrap()
                .layout_ref
                .as_deref(),
            Some("grp_a")
        );
    }

    #[test]
    fn an_unknown_window_is_refused() {
        let host = Recorder::default();
        let reg = reg();
        assert!(reg
            .set_layout(&host, MAIN_LABEL, "nope", Some("grp_a".into()))
            .is_err());
    }
}

#[cfg(test)]
mod owners {
    use super::test_host::{Effect, Holder, Recorder};
    use super::*;

    fn key(id: &str) -> ItemKey {
        ItemKey {
            kind: "tab".into(),
            team: "acme:docs".into(),
            id: id.into(),
        }
    }

    fn reg(host: &Recorder, labels: &[&str]) -> WindowRegistry {
        let reg = WindowRegistry::new();
        for l in labels {
            reg.add_satellite(host, l).unwrap();
            reg.ready(host, l).unwrap();
        }
        host.clear();
        reg
    }

    fn version(reg: &WindowRegistry, label: &str) -> u64 {
        reg.get_slice(MAIN_LABEL, label).unwrap().version
    }

    fn owners(reg: &WindowRegistry) -> BTreeMap<String, String> {
        reg.get_slice(MAIN_LABEL, MAIN_LABEL)
            .unwrap()
            .owners
            .unwrap()
    }

    #[test]
    fn main_owns_every_key_no_satellite_holds() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1"]);
        assert_eq!(reg.owner(&key("a.md")), MAIN_LABEL);
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        assert_eq!(reg.owner(&key("a.md")), "sat-1");
        assert_eq!(reg.owner(&key("A.md")), MAIN_LABEL);
    }

    #[test]
    fn main_s_slice_carries_the_map_and_satellites_get_none() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1"]);
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        assert_eq!(
            owners(&reg),
            BTreeMap::from([(key("a.md").canonical(), "sat-1".to_owned())])
        );
        for effect in host.effects.borrow().iter() {
            let Effect::Sent(slice) = effect else {
                continue;
            };
            assert_eq!(
                slice.owners.is_some(),
                slice.label == MAIN_LABEL,
                "{slice:?}"
            );
        }
        let sat = reg.get_slice("sat-1", "sat-1").unwrap();
        assert_eq!((sat.owners, sat.items), (None, vec![key("a.md")]));
    }

    #[test]
    fn reassign_from_main_bumps_main_first_then_the_satellite() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1", "sat-2"]);
        assert!(reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap());
        assert_eq!(
            host.sent_to(),
            vec![(MAIN_LABEL.into(), 2), ("sat-1".into(), 3)]
        );
        assert_eq!(version(&reg, "sat-2"), 2);
    }

    #[test]
    fn reassign_between_satellites_changes_only_main_s_map_in_main() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1", "sat-2", "sat-3"]);
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        let before = reg.get_slice(MAIN_LABEL, MAIN_LABEL).unwrap();
        host.clear();
        assert!(reg.reassign_item(&host, &key("a.md"), "sat-2").unwrap());
        let after = reg.get_slice(MAIN_LABEL, MAIN_LABEL).unwrap();
        assert_eq!(after.version, before.version + 1);
        assert_eq!(
            (&after.items, &after.layout_ref, after.pending),
            (&before.items, &before.layout_ref, before.pending)
        );
        assert_eq!(after.owners.unwrap()[&key("a.md").canonical()], "sat-2");
        let sent: Vec<String> = host.sent_to().into_iter().map(|(l, _)| l).collect();
        assert_eq!(sent, vec![MAIN_LABEL, "sat-1", "sat-2"]);
        assert!(reg.get_slice("sat-1", "sat-1").unwrap().items.is_empty());
        assert_eq!(
            reg.get_slice("sat-2", "sat-2").unwrap().items,
            vec![key("a.md")]
        );
        assert_eq!(version(&reg, "sat-3"), 2);
    }

    #[test]
    fn reassign_to_main_takes_the_key_out_of_every_satellite() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1", "sat-2"]);
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        host.clear();
        assert!(reg.reassign_item(&host, &key("a.md"), MAIN_LABEL).unwrap());
        assert_eq!(reg.owner(&key("a.md")), MAIN_LABEL);
        assert!(owners(&reg).is_empty());
        let sent: Vec<String> = host.sent_to().into_iter().map(|(l, _)| l).collect();
        assert_eq!(sent, vec![MAIN_LABEL, "sat-1"]);
    }

    #[test]
    fn a_reassign_that_changes_nothing_sends_nothing() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1"]);
        assert!(!reg.reassign_item(&host, &key("a.md"), MAIN_LABEL).unwrap());
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        host.clear();
        assert!(!reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap());
        assert!(host.sent_to().is_empty());
        assert!(reg.reassign_item(&host, &key("a.md"), "nope").is_err());
    }

    #[test]
    fn return_to_main_removes_the_key_from_its_satellite() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1", "sat-2"]);
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        host.clear();
        assert!(reg.return_to_main(&host, &key("a.md")).unwrap());
        assert_eq!(reg.owner(&key("a.md")), MAIN_LABEL);
        let sent: Vec<String> = host.sent_to().into_iter().map(|(l, _)| l).collect();
        assert_eq!(sent, vec![MAIN_LABEL, "sat-1"]);
        assert!(!reg.return_to_main(&host, &key("a.md")).unwrap());
    }

    #[test]
    fn set_pending_bumps_only_its_own_window() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1", "sat-2"]);
        reg.set_pending(&host, "sat-1", true).unwrap();
        assert_eq!(host.sent_to(), vec![("sat-1".into(), 3)]);
        assert!(reg.get_slice("sat-1", "sat-1").unwrap().pending);
        host.clear();
        reg.set_pending(&host, "sat-1", true).unwrap();
        assert!(host.sent_to().is_empty());
    }

    #[test]
    fn add_satellite_creates_a_pending_entry_and_bumps_no_other_window() {
        let host = Recorder::default();
        let reg = reg(&host, &[]);
        let slice = reg.add_satellite(&host, "sat-1").unwrap();
        assert_eq!(slice.kind, WindowKind::Satellite);
        assert_eq!((slice.layout_ref, slice.pending), (None, true));
        assert!(slice.items.is_empty());
        assert_eq!(host.sent_to(), vec![("sat-1".into(), 1)]);
        assert_eq!(version(&reg, MAIN_LABEL), 1);
        assert!(reg.add_satellite(&host, "sat-1").is_err());
        assert!(reg.add_satellite(&host, MAIN_LABEL).is_err());
    }

    #[test]
    fn add_satellite_then_ready_leaves_it_not_pending() {
        let host = Recorder::default();
        let reg = reg(&host, &[]);
        reg.add_satellite(&host, "sat-1").unwrap();
        reg.ready(&host, "sat-1").unwrap();
        assert!(!reg.get_slice("sat-1", "sat-1").unwrap().pending);
    }

    #[test]
    fn a_stale_hydrate_pull_reply_is_ignored() {
        let host = Recorder::default();
        let reg = reg(&host, &["sat-1"]);
        // `main` pulls; the reply is still in flight when a reassignment pushes a newer map.
        let pulled = reg.get_slice(MAIN_LABEL, MAIN_LABEL).unwrap();
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        let pushed = match host.effects.borrow().first() {
            Some(Effect::Sent(slice)) if slice.label == MAIN_LABEL => slice.clone(),
            other => panic!("main's map was not sent first: {other:?}"),
        };
        let mut main = Holder::default();
        assert!(main.accept(pushed));
        assert!(!main.accept(pulled));
        assert_eq!(main.held.unwrap().owners.unwrap().len(), 1);
    }
}

#[cfg(test)]
mod focus {
    use super::test_host::Recorder;
    use super::*;

    fn key(id: &str) -> ItemKey {
        ItemKey {
            kind: "tab".into(),
            team: "acme:docs".into(),
            id: id.into(),
        }
    }

    #[test]
    fn focus_owner_focuses_the_satellite_that_holds_the_key() {
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-1").unwrap();
        reg.reassign_item(&host, &key("a.md"), "sat-1").unwrap();
        host.clear();
        assert_eq!(
            reg.focus_owner(&host, &key("a.md")).as_deref(),
            Some("sat-1")
        );
        assert_eq!(host.focused(), vec!["sat-1".to_owned()]);
        assert!(host.sent_to().is_empty());
    }

    #[test]
    fn focus_owner_is_a_no_op_for_a_key_main_owns() {
        let host = Recorder::default();
        let reg = WindowRegistry::new();
        reg.add_satellite(&host, "sat-1").unwrap();
        host.clear();
        assert_eq!(reg.focus_owner(&host, &key("a.md")), None);
        assert!(host.effects.borrow().is_empty());
    }
}

// SPDX-License-Identifier: MIT
//! `window_move_item`: the one way an item changes window, as safe as closing its tab.
//!
//! A move is keyed by a `moveId` and lives in the registry's [`MoveBook`], under the
//! registry's one lock, so ownership and the move's state change together.
//!
//! - **pending** (`to:"new"` only): the target's entry exists and its window is booting.
//!   It stays `pending` after `window_ready`; ready only starts the hand-off.
//! - **handing-off:** the source gets `window:hand-off {key, moveId, budgetMs}`, flushes
//!   the item's frame writes within `budgetMs` ([`FLUSH_ACK_MS`]), lets the item go and
//!   answers with `window_hand_off_ack`. Only the source's ack for the current `moveId`
//!   counts.
//! - **committed:** ownership moves through the registry's `reassign_item`, which sends `main`'s
//!   owner map first. A satellite target mounts the item from its next slice; `main` as
//!   target gets `window:items-returned`. The target is focused after the lock is released.
//! - **aborted:** a dirty ack, a source or target that is gone (a target's window is checked
//!   at the move and again at the ack), a failed transfer, the pending timeout or no ack within
//!   [`HAND_OFF_MS`]. The source gets `window:move-aborted {key, moveId, reason}` and keeps
//!   or reopens its item; a half-made target is dropped from the registry and its window
//!   destroyed after the lock is released.
//!
//! A ready, an ack and a timer are each one transition under the lock: whichever arrives
//! first decides, and a late one finds its move gone or past its phase and is ignored.
//!
//! Calls on this file's own types are written as paths (`MoveBook::find_key(..)`) so
//! `explicit_sync_unattended_writer_guard`'s call graph resolves them.

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime};

use super::item_key::ItemKey;
use super::label::MAIN_LABEL;
use super::pending_timeout::PENDING_TIMEOUT_MS;
use super::registry::{Incoming, Locked, WindowHost, WindowRegistry};

/// How long the source may take to flush the item's frame writes and let it go.
pub const FLUSH_ACK_MS: u64 = 1_500;

/// How long the registry waits for the source's ack before the move aborts as `no_ack`.
pub const HAND_OFF_MS: u64 = FLUSH_ACK_MS + 500;

/// To the source: flush the item, let it go and ack.
pub const HAND_OFF_EVENT: &str = "window:hand-off";

/// To the source: the move ended without a commit; keep or reopen the item.
pub const MOVE_ABORTED_EVENT: &str = "window:move-aborted";

/// To `main`: items it owns again, to open.
pub const ITEMS_RETURNED_EVENT: &str = "window:items-returned";

/// The `to` that asks for a new window.
pub const NEW_WINDOW: &str = "new";

/// Refusal and abort reasons, sent to callers as written.
pub mod reason {
    pub const STALE: &str = "stale";
    pub const MOVING: &str = "moving";
    pub const PENDING_TARGET: &str = "pending_target";
    pub const SELF: &str = "self";
    pub const UNKNOWN_TARGET: &str = "unknown_target";
    pub const TILES_OFF: &str = "tiles_off";
    pub const DIRTY: &str = "dirty";
    pub const GONE: &str = "gone";
    pub const TIMEOUT: &str = "timeout";
    pub const NO_ACK: &str = "no_ack";
    pub const WINDOW_FAILED: &str = "window_failed";
}

/// A per-kind refusal: `Some(reason)` refuses the move before any registry change.
type KindCheck = fn(&ItemKey) -> Option<&'static str>;

/// Per-kind checks, by `ItemKey::kind`. Other kinds register theirs here.
const KIND_CHECKS: &[(&str, KindCheck)] = &[];

/// The refusal, if any, the item's kind gives for a move.
pub fn kind_check(key: &ItemKey) -> Option<&'static str> {
    kind_check_in(KIND_CHECKS, key)
}

fn kind_check_in(checks: &[(&str, KindCheck)], key: &ItemKey) -> Option<&'static str> {
    let (_, check) = Iterator::find(&mut checks.iter(), |(kind, _)| *kind == key.kind)?;
    check(key)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// The new target's window is booting.
    Pending,
    /// The source has been asked to let the item go.
    HandingOff,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub id: String,
    pub key: ItemKey,
    pub source: String,
    pub target: String,
    /// The target was made for this move, so an abort drops it.
    pub created: bool,
    pub phase: Phase,
}

/// The moves in flight, by `moveId`. One per key at a time.
#[derive(Debug, Default)]
pub struct MoveBook {
    next: u64,
    moves: BTreeMap<String, Move>,
}

impl MoveBook {
    /// Whether `label` is the target of a move in flight.
    pub(super) fn targets(&self, label: &str) -> bool {
        self.moves.values().any(|m| m.target == label)
    }

    fn find_key(&self, key: &ItemKey) -> Option<&Move> {
        Iterator::find(&mut self.moves.values(), |m| m.key == *key)
    }

    fn open(
        &mut self,
        key: &ItemKey,
        source: &str,
        target: &str,
        created: bool,
        phase: Phase,
    ) -> Move {
        self.next += 1;
        let m = Move {
            id: format!("mv-{}", self.next),
            key: key.clone(),
            source: source.to_owned(),
            target: target.to_owned(),
            created,
            phase,
        };
        self.moves.insert(m.id.clone(), m.clone());
        m
    }

    fn move_by_id(&self, id: &str) -> Option<&Move> {
        self.moves.get(id)
    }

    fn set_phase(&mut self, id: &str, phase: Phase) {
        if let Some(m) = self.moves.get_mut(id) {
            m.phase = phase;
        }
    }

    fn close(&mut self, id: &str) -> Option<Move> {
        self.moves.remove(id)
    }

    #[cfg(test)]
    fn ids(&self) -> Vec<String> {
        BTreeMap::keys(&self.moves).cloned().collect()
    }

    /// Moves whose source or target is `label`.
    fn touching(&self, label: &str) -> Vec<String> {
        self.moves
            .values()
            .filter(|m| m.source == label || m.target == label)
            .map(|m| m.id.clone())
            .collect()
    }

    /// The move waiting for `label` to boot.
    fn pending_for(&self, label: &str) -> Option<String> {
        Iterator::find(&mut self.moves.values(), |m| {
            m.target == label && m.phase == Phase::Pending
        })
        .map(|m| m.id.clone())
    }
}

/// The timers a move arms. Each names its move and the phase it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveTimer {
    /// The new target's window has not booted within [`PENDING_TIMEOUT_MS`].
    Pending(String),
    /// The source has not acked within [`HAND_OFF_MS`].
    HandOff(String),
}

/// What a move does outside the registry: events to one window, windows made and
/// destroyed, timers. Slices and focus go through [`WindowHost`].
pub trait MoveHost: WindowHost {
    fn send_event(&self, label: &str, event: &str, payload: serde_json::Value);
    fn window_exists(&self, label: &str) -> bool;
    fn create_window(&self, label: &str) -> Result<(), String>;
    fn destroy_window(&self, label: &str);
    fn schedule(&self, ms: u64, timer: MoveTimer);
}

impl<R: Runtime> MoveHost for tauri::AppHandle<R> {
    fn send_event(&self, label: &str, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.emit_to(label, event, payload) {
            log::warn!(target: "windows", "{event} to {label} not sent: {e}");
        }
    }

    fn window_exists(&self, label: &str) -> bool {
        self.get_webview_window(label).is_some()
    }

    fn create_window(&self, label: &str) -> Result<(), String> {
        // The builder's default size until the window is placed.
        let url = tauri::WebviewUrl::App(format!("index.html?window={label}").into());
        tauri::WebviewWindowBuilder::new(self, label, url)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn destroy_window(&self, label: &str) {
        if let Some(window) = self.get_webview_window(label) {
            if let Err(e) = window.destroy() {
                log::warn!(target: "windows", "destroy {label} failed: {e}");
            }
        }
    }

    fn schedule(&self, ms: u64, timer: MoveTimer) {
        let app = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            let registry = app.state::<WindowRegistry>();
            on_timer(&app, &registry, &timer);
        });
    }
}

/// The answer to `window_move_item`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MoveStart {
    /// The move is in flight; its outcome reaches the source as a commit or an abort.
    Started {
        #[serde(rename = "moveId")]
        move_id: String,
        target: String,
    },
    /// Nothing changed.
    Refused { reason: String },
}

fn refused(reason: &str) -> MoveStart {
    MoveStart::Refused {
        reason: reason.to_owned(),
    }
}

/// What runs after the lock is released.
#[derive(Debug, Default)]
struct After {
    timers: Vec<(u64, MoveTimer)>,
    focus: Option<String>,
    destroy: Vec<String>,
}

fn run_after(host: &impl MoveHost, after: After) {
    destroy_after(host, after.destroy);
    if let Some(label) = after.focus {
        WindowHost::focus(host, &label);
    }
    for (ms, timer) in after.timers {
        MoveHost::schedule(host, ms, timer);
    }
}

/// Destroys the windows an abort left, once the lock is released.
fn destroy_after(host: &impl MoveHost, labels: Vec<String>) {
    for label in labels {
        MoveHost::destroy_window(host, &label);
    }
}

/// Starts moving `key` from `caller` to `to` (`"new"`, `"main"` or a window's label).
/// `tiles_on` is the launch-time `tiles` flag; with it off no new window opens.
pub fn move_item(
    host: &impl MoveHost,
    registry: &WindowRegistry,
    caller: &str,
    key: &ItemKey,
    to: &str,
    tiles_on: bool,
) -> MoveStart {
    let mut locked = registry.locked();
    if Locked::item_owner(&locked, key) != caller {
        return refused(reason::STALE);
    }
    if MoveBook::find_key(Locked::book_ref(&locked), key).is_some() {
        return refused(reason::MOVING);
    }
    if to == caller {
        return refused(reason::SELF);
    }
    let new = to == NEW_WINDOW;
    if new {
        if !tiles_on {
            return refused(reason::TILES_OFF);
        }
    } else if !Locked::has_window(&locked, to) {
        return refused(reason::UNKNOWN_TARGET);
    } else if Locked::is_pending(&locked, to) {
        return refused(reason::PENDING_TARGET);
    } else if !MoveHost::window_exists(host, to) {
        // The entry outlives a closed window until the registry drops it on close.
        return refused(reason::UNKNOWN_TARGET);
    }
    if let Some(why) = kind_check(key) {
        return refused(why);
    }

    let mut after = After::default();
    let mut create = None;
    let started = if new {
        let label = format!("pane-{}", uuid::Uuid::new_v4());
        let incoming = Incoming {
            key: key.clone(),
            from_number: Locked::number_of(&locked, caller).unwrap_or(1),
        };
        if let Err(e) = Locked::add_pending_target(&mut locked, host, &label, incoming) {
            log::warn!(target: "windows", "move target {label} not added: {e}");
            return refused(reason::WINDOW_FAILED);
        }
        let m = MoveBook::open(
            Locked::book(&mut locked),
            key,
            caller,
            &label,
            true,
            Phase::Pending,
        );
        create = Some(label);
        after
            .timers
            .push((PENDING_TIMEOUT_MS, MoveTimer::Pending(m.id.clone())));
        m
    } else {
        let m = MoveBook::open(
            Locked::book(&mut locked),
            key,
            caller,
            to,
            false,
            Phase::HandingOff,
        );
        send_hand_off(host, &m);
        after
            .timers
            .push((HAND_OFF_MS, MoveTimer::HandOff(m.id.clone())));
        m
    };
    drop(locked);

    if let Some(label) = create {
        if let Err(e) = MoveHost::create_window(host, &label) {
            log::warn!(target: "windows", "move window {label} not built: {e}");
            // The caller gets the refusal; the source never heard of this move, so no
            // `window:move-aborted` follows it.
            let mut locked = registry.locked();
            MoveBook::close(Locked::book(&mut locked), &started.id);
            if let Err(e) = Locked::remove_empty_satellite(&mut locked, &label) {
                log::warn!(target: "windows", "move target {label} not removed: {e}");
            }
            return refused(reason::WINDOW_FAILED);
        }
    }
    run_after(host, after);
    MoveStart::Started {
        move_id: started.id,
        target: started.target,
    }
}

fn send_hand_off(host: &impl MoveHost, m: &Move) {
    MoveHost::send_event(
        host,
        &m.source,
        HAND_OFF_EVENT,
        serde_json::json!({ "key": m.key, "moveId": m.id, "budgetMs": FLUSH_ACK_MS }),
    );
}

/// `label` has mounted its listeners and holds its slice. Marks it ready; for a move's
/// target this starts the hand-off and leaves `pending` set until the move ends.
pub fn window_ready(
    host: &impl MoveHost,
    registry: &WindowRegistry,
    label: &str,
) -> Result<(), String> {
    let mut locked = registry.locked();
    Locked::mark_window_ready(&mut locked, host, label)?;
    let Some(id) = MoveBook::pending_for(Locked::book_ref(&locked), label) else {
        return Ok(());
    };
    let mut after = After::default();
    let m = MoveBook::move_by_id(Locked::book_ref(&locked), &id)
        .cloned()
        .expect("pending_for names a move in the book");
    if !MoveHost::window_exists(host, &m.source) {
        after.destroy = abort_locked(&mut locked, host, &id, reason::GONE);
    } else {
        MoveBook::set_phase(Locked::book(&mut locked), &id, Phase::HandingOff);
        send_hand_off(host, &m);
        after.timers.push((HAND_OFF_MS, MoveTimer::HandOff(id)));
    }
    drop(locked);
    run_after(host, after);
    Ok(())
}

/// The source's answer to `window:hand-off`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandOffAck {
    pub move_id: String,
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// What an ack did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AckOutcome {
    Committed,
    Aborted,
    /// Not the current move's ack from its source, or the move is past its hand-off.
    Ignored,
}

/// Commits the move on `ok`, else aborts it with the ack's reason (`dirty` by default).
pub fn hand_off_ack(
    host: &impl MoveHost,
    registry: &WindowRegistry,
    caller: &str,
    ack: &HandOffAck,
) -> AckOutcome {
    let mut locked = registry.locked();
    let Some(m) = MoveBook::move_by_id(Locked::book_ref(&locked), &ack.move_id).cloned() else {
        return AckOutcome::Ignored;
    };
    if m.source != caller || m.phase != Phase::HandingOff {
        return AckOutcome::Ignored;
    }
    let mut after = After::default();
    let abort_why = if !ack.ok {
        Some(ack.reason.as_deref().unwrap_or(reason::DIRTY))
    } else if !MoveHost::window_exists(host, &m.target) {
        // The target closed after the move began: the source keeps or reopens the item.
        Some(reason::GONE)
    } else if let Err(e) = commit_locked(&mut locked, host, &m) {
        log::warn!(target: "windows", "move {} not transferred: {e}", m.id);
        Some(reason::GONE)
    } else {
        None
    };
    let outcome = match abort_why {
        None => {
            after.focus = Some(m.target.clone());
            AckOutcome::Committed
        }
        Some(why) => {
            after.destroy = abort_locked(&mut locked, host, &m.id, why);
            AckOutcome::Aborted
        }
    };
    drop(locked);
    run_after(host, after);
    outcome
}

/// Transfers the item and closes the move. On an error the move stays open, for the
/// caller to abort.
fn commit_locked(locked: &mut Locked<'_>, host: &impl MoveHost, m: &Move) -> Result<(), String> {
    Locked::reassign_item(locked, host, &m.key, &m.target)?;
    MoveBook::close(Locked::book(locked), &m.id);
    if m.target == MAIN_LABEL {
        MoveHost::send_event(
            host,
            MAIN_LABEL,
            ITEMS_RETURNED_EVENT,
            serde_json::json!({ "items": [m.key], "reason": "move" }),
        );
    }
    if m.created {
        if let Err(e) = Locked::clear_target_pending(locked, host, &m.target) {
            log::warn!(target: "windows", "move target {} not cleared: {e}", m.target);
        }
    }
    Ok(())
}

/// Ends move `id` without a commit, under the lock. Returns the windows to destroy once
/// the lock is released.
fn abort_locked(locked: &mut Locked<'_>, host: &impl MoveHost, id: &str, why: &str) -> Vec<String> {
    let Some(m) = MoveBook::close(Locked::book(locked), id) else {
        return Vec::new();
    };
    let mut destroy = Vec::new();
    if m.created {
        if let Err(e) = Locked::remove_empty_satellite(locked, &m.target) {
            log::warn!(target: "windows", "move target {} not removed: {e}", m.target);
        }
        destroy.push(m.target.clone());
    }
    MoveHost::send_event(
        host,
        &m.source,
        MOVE_ABORTED_EVENT,
        serde_json::json!({ "key": m.key, "moveId": m.id, "reason": why }),
    );
    destroy
}

/// A move timer fired. It aborts its move only if the move is still in the phase the
/// timer was armed for.
pub fn on_timer(host: &impl MoveHost, registry: &WindowRegistry, timer: &MoveTimer) {
    let (id, phase, why) = match timer {
        MoveTimer::Pending(id) => (id, Phase::Pending, reason::TIMEOUT),
        MoveTimer::HandOff(id) => (id, Phase::HandingOff, reason::NO_ACK),
    };
    let mut locked = registry.locked();
    let current =
        MoveBook::move_by_id(Locked::book_ref(&locked), id).is_some_and(|m| m.phase == phase);
    if !current {
        return;
    }
    let destroy = abort_locked(&mut locked, host, id, why);
    drop(locked);
    destroy_after(host, destroy);
}

/// `label`'s window is gone: every move it is the source or target of aborts as `gone`.
pub fn window_gone(host: &impl MoveHost, registry: &WindowRegistry, label: &str) {
    let mut locked = registry.locked();
    let mut destroy = Vec::new();
    for id in MoveBook::touching(Locked::book_ref(&locked), label) {
        Vec::extend(
            &mut destroy,
            abort_locked(&mut locked, host, &id, reason::GONE),
        );
    }
    drop(locked);
    destroy_after(host, destroy);
}

/// Aborts every move in flight with `why`, under the caller's lock. Returns the windows
/// to destroy once the caller releases it.
#[cfg(test)]
pub fn abort_all_moves_locked(
    locked: &mut Locked<'_>,
    host: &impl MoveHost,
    why: &str,
) -> Vec<String> {
    let mut destroy = Vec::new();
    for id in MoveBook::ids(Locked::book_ref(locked)) {
        Vec::extend(&mut destroy, abort_locked(locked, host, &id, why));
    }
    destroy
}

/// Aborts every move in flight with `why`.
#[cfg(test)]
pub fn abort_all_moves(host: &impl MoveHost, registry: &WindowRegistry, why: &str) {
    let mut locked = registry.locked();
    let destroy = abort_all_moves_locked(&mut locked, host, why);
    drop(locked);
    destroy_after(host, destroy);
}

/// Moves `key` from the calling window to `to`: `"new"`, `"main"` or a window's label.
#[tauri::command]
pub async fn window_move_item(
    app: tauri::AppHandle,
    window: tauri::Window,
    key: ItemKey,
    to: String,
) -> MoveStart {
    let tiles_on = crate::flags::tiles_enabled(app.state::<crate::flags::TilesFlag>());
    let registry = app.state::<WindowRegistry>();
    move_item(
        &app,
        &registry,
        tauri::Window::label(&window),
        &key,
        &to,
        tiles_on,
    )
}

/// The source's answer to `window:hand-off`.
#[tauri::command]
pub async fn window_hand_off_ack(
    app: tauri::AppHandle,
    window: tauri::Window,
    ack: HandOffAck,
) -> AckOutcome {
    let registry = app.state::<WindowRegistry>();
    hand_off_ack(&app, &registry, tauri::Window::label(&window), &ack)
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::windows::registry::WindowSlice;
    use std::cell::RefCell;
    use std::collections::BTreeSet;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Fx {
        Slice(WindowSlice),
        Focused {
            label: String,
            under_lock: bool,
        },
        Event {
            label: String,
            event: String,
            payload: serde_json::Value,
        },
        Created(String),
        Destroyed {
            label: String,
            under_lock: bool,
        },
        Scheduled(u64, MoveTimer),
    }

    /// Records every effect in order, and which windows exist.
    pub struct Rec<'a> {
        pub reg: &'a WindowRegistry,
        pub fx: RefCell<Vec<Fx>>,
        pub windows: RefCell<BTreeSet<String>>,
        pub fail_create: bool,
    }

    impl<'a> Rec<'a> {
        pub fn new(reg: &'a WindowRegistry) -> Self {
            Self {
                reg,
                fx: RefCell::default(),
                windows: RefCell::new(BTreeSet::from([MAIN_LABEL.to_owned()])),
                fail_create: false,
            }
        }

        pub fn events(&self, event: &str) -> Vec<(String, serde_json::Value)> {
            self.fx
                .borrow()
                .iter()
                .filter_map(|f| match f {
                    Fx::Event {
                        label,
                        event: e,
                        payload,
                    } if e == event => Some((label.clone(), payload.clone())),
                    _ => None,
                })
                .collect()
        }

        pub fn timers(&self) -> Vec<MoveTimer> {
            self.fx
                .borrow()
                .iter()
                .filter_map(|f| match f {
                    Fx::Scheduled(_, t) => Some(t.clone()),
                    _ => None,
                })
                .collect()
        }

        pub fn clear(&self) {
            self.fx.borrow_mut().clear();
        }
    }

    impl WindowHost for Rec<'_> {
        fn send_slice(&self, slice: &WindowSlice) {
            self.fx.borrow_mut().push(Fx::Slice(slice.clone()));
        }

        fn focus(&self, label: &str) {
            let under_lock = self.reg.is_locked();
            self.fx.borrow_mut().push(Fx::Focused {
                label: label.to_owned(),
                under_lock,
            });
        }
    }

    impl MoveHost for Rec<'_> {
        fn send_event(&self, label: &str, event: &str, payload: serde_json::Value) {
            self.fx.borrow_mut().push(Fx::Event {
                label: label.to_owned(),
                event: event.to_owned(),
                payload,
            });
        }

        fn window_exists(&self, label: &str) -> bool {
            self.windows.borrow().contains(label)
        }

        fn create_window(&self, label: &str) -> Result<(), String> {
            if self.fail_create {
                return Err("no display".to_owned());
            }
            self.windows.borrow_mut().insert(label.to_owned());
            self.fx.borrow_mut().push(Fx::Created(label.to_owned()));
            Ok(())
        }

        fn destroy_window(&self, label: &str) {
            let under_lock = self.reg.is_locked();
            self.windows.borrow_mut().remove(label);
            self.fx.borrow_mut().push(Fx::Destroyed {
                label: label.to_owned(),
                under_lock,
            });
        }

        fn schedule(&self, ms: u64, timer: MoveTimer) {
            self.fx.borrow_mut().push(Fx::Scheduled(ms, timer));
        }
    }

    pub fn tab(id: &str) -> ItemKey {
        ItemKey {
            kind: "tab".to_owned(),
            team: "org/team".to_owned(),
            id: id.to_owned(),
        }
    }

    /// Opens a ready satellite `label` holding `items`.
    pub fn satellite(rec: &Rec<'_>, label: &str, items: &[ItemKey]) {
        rec.reg.add_satellite(rec, label).unwrap();
        rec.reg.ready(rec, label).unwrap();
        for key in items {
            rec.reg.reassign_item(rec, key, label).unwrap();
        }
        rec.windows.borrow_mut().insert(label.to_owned());
    }

    pub fn started(outcome: MoveStart) -> (String, String) {
        match outcome {
            MoveStart::Started { move_id, target } => (move_id, target),
            MoveStart::Refused { reason } => panic!("refused: {reason}"),
        }
    }

    pub fn reason_of(outcome: MoveStart) -> String {
        match outcome {
            MoveStart::Refused { reason } => reason,
            MoveStart::Started { move_id, .. } => panic!("started {move_id}"),
        }
    }

    pub fn ack(move_id: &str, ok: bool, reason: Option<&str>) -> HandOffAck {
        HandOffAck {
            move_id: move_id.to_owned(),
            ok,
            reason: reason.map(str::to_owned),
        }
    }

    /// `label`'s slice, as `main` reads it.
    pub fn slice(reg: &WindowRegistry, label: &str) -> WindowSlice {
        reg.get_slice(MAIN_LABEL, label).unwrap()
    }
}

#[cfg(test)]
mod call {
    use super::bench::*;
    use super::*;

    #[test]
    fn a_caller_that_does_not_own_the_key_is_refused_as_stale() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[]);
        let out = move_item(&rec, &reg, "sat-1", &key, MAIN_LABEL, true);
        assert_eq!(reason_of(out), reason::STALE);
    }

    #[test]
    fn a_pending_window_is_never_a_target() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        reg.add_satellite(&rec, "sat-1").unwrap();
        let out = move_item(&rec, &reg, MAIN_LABEL, &tab("a.md"), "sat-1", true);
        assert_eq!(reason_of(out), reason::PENDING_TARGET);
    }

    #[test]
    fn a_key_already_moving_is_locked() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        satellite(&rec, "sat-1", &[]);
        let key = tab("a.md");
        started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        let out = move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true);
        assert_eq!(reason_of(out), reason::MOVING);
    }

    #[test]
    fn a_move_to_the_caller_s_own_window_is_refused_as_self() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let out = move_item(&rec, &reg, MAIN_LABEL, &tab("a.md"), MAIN_LABEL, true);
        assert_eq!(reason_of(out), reason::SELF);
    }

    #[test]
    fn an_unknown_target_is_refused() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let out = move_item(&rec, &reg, MAIN_LABEL, &tab("a.md"), "pane-x", true);
        assert_eq!(reason_of(out), reason::UNKNOWN_TARGET);
    }

    #[test]
    fn a_refusal_changes_nothing() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let before = slice(&reg, MAIN_LABEL);
        for to in ["pane-x", MAIN_LABEL] {
            move_item(&rec, &reg, MAIN_LABEL, &tab("a.md"), to, true);
        }
        assert_eq!(slice(&reg, MAIN_LABEL), before);
        assert!(rec.fx.borrow().is_empty());
    }

    #[test]
    fn a_new_window_with_tiles_off_is_refused_before_any_entry_exists() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let out = move_item(&rec, &reg, MAIN_LABEL, &tab("a.md"), NEW_WINDOW, false);
        assert_eq!(reason_of(out), reason::TILES_OFF);
        assert_eq!(slice(&reg, MAIN_LABEL).owners, Some(Default::default()));
        assert!(
            rec.fx.borrow().is_empty(),
            "no entry, no window: {:?}",
            rec.fx.borrow()
        );
    }

    #[test]
    fn a_move_to_main_with_tiles_off_is_not_refused_for_the_flag() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[key.clone()]);
        started(move_item(&rec, &reg, "sat-1", &key, MAIN_LABEL, false));
    }

    #[test]
    fn a_new_window_creates_one_registered_pending_entry() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, target) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        assert!(target.starts_with("pane-"), "{target}");
        let s = slice(&reg, &target);
        assert!(s.pending);
        assert!(s.items.is_empty(), "no item until commit");
        assert_eq!(s.number, 2);
        assert_eq!(
            s.incoming,
            Some(Incoming {
                key,
                from_number: 1
            })
        );
        let created: Vec<_> = rec
            .fx
            .borrow()
            .iter()
            .filter(|f| matches!(f, bench::Fx::Created(_)))
            .cloned()
            .collect();
        assert_eq!(created, vec![bench::Fx::Created(target)]);
        assert_eq!(rec.timers(), vec![MoveTimer::Pending(move_id)]);
        assert!(
            rec.events(HAND_OFF_EVENT).is_empty(),
            "the hand-off waits for ready"
        );
    }

    #[test]
    fn a_new_target_stays_pending_after_ready_and_ready_starts_the_hand_off() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, target) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        rec.clear();
        window_ready(&rec, &reg, &target).unwrap();
        assert!(slice(&reg, &target).pending);
        assert_eq!(
            rec.events(HAND_OFF_EVENT),
            vec![(
                MAIN_LABEL.to_owned(),
                serde_json::json!({"key": key, "moveId": move_id, "budgetMs": FLUSH_ACK_MS})
            )]
        );
        assert_eq!(rec.timers(), vec![MoveTimer::HandOff(move_id)]);
    }

    #[test]
    fn a_move_to_an_existing_window_hands_off_at_once() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        satellite(&rec, "sat-1", &[]);
        rec.clear();
        let key = tab("a.md");
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        assert_eq!(rec.events(HAND_OFF_EVENT).len(), 1);
        assert_eq!(rec.timers(), vec![MoveTimer::HandOff(move_id)]);
    }

    #[test]
    fn the_kind_check_refuses_with_its_own_reason_before_any_change() {
        fn no_tabs(_: &ItemKey) -> Option<&'static str> {
            Some("tab_refused")
        }
        let checks: &[(&str, KindCheck)] = &[("tab", no_tabs)];
        assert_eq!(kind_check_in(checks, &tab("a.md")), Some("tab_refused"));
        let other = ItemKey {
            kind: "tile".to_owned(),
            ..tab("a.md")
        };
        assert_eq!(kind_check_in(checks, &other), None);
        assert!(
            std::hint::black_box(KIND_CHECKS).is_empty(),
            "no kind registers a check yet"
        );
        assert_eq!(kind_check(&tab("a.md")), None);
    }

    #[test]
    fn new_windows_take_the_lowest_free_number() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let (_, a) = started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("a.md"),
            NEW_WINDOW,
            true,
        ));
        let (_, b) = started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("b.md"),
            NEW_WINDOW,
            true,
        ));
        assert_eq!((slice(&reg, &a).number, slice(&reg, &b).number), (2, 3));
    }

    #[test]
    fn the_answer_serializes_with_its_status() {
        let started = MoveStart::Started {
            move_id: "mv-1".to_owned(),
            target: "pane-x".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            serde_json::json!({"status": "started", "moveId": "mv-1", "target": "pane-x"})
        );
        assert_eq!(
            serde_json::to_value(refused(reason::STALE)).unwrap(),
            serde_json::json!({"status": "refused", "reason": "stale"})
        );
    }
}

#[cfg(test)]
mod commit {
    use super::bench::*;
    use super::*;

    #[test]
    fn a_move_to_a_new_window_commits_on_the_source_s_ack() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, target) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        window_ready(&rec, &reg, &target).unwrap();
        let out = hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        assert_eq!(out, AckOutcome::Committed);
        assert_eq!(reg.owner(&key), target);
        let s = slice(&reg, &target);
        assert_eq!(s.items, vec![key]);
        assert!(!s.pending);
        assert_eq!(s.incoming, None);
    }

    #[test]
    fn a_move_to_main_returns_the_item_after_the_owner_map() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[key.clone()]);
        let (move_id, _) = started(move_item(&rec, &reg, "sat-1", &key, MAIN_LABEL, true));
        rec.clear();
        hand_off_ack(&rec, &reg, "sat-1", &ack(&move_id, true, None));
        assert_eq!(reg.owner(&key), MAIN_LABEL);
        let fx = rec.fx.borrow();
        let map = fx
            .iter()
            .position(|f| matches!(f, Fx::Slice(s) if s.label == MAIN_LABEL))
            .expect("main's map is sent");
        let returned = fx
            .iter()
            .position(|f| matches!(f, Fx::Event { event, .. } if event == ITEMS_RETURNED_EVENT))
            .expect("main hears the return");
        assert!(map < returned, "{fx:?}");
        assert_eq!(
            rec.events(ITEMS_RETURNED_EVENT),
            vec![(
                MAIN_LABEL.to_owned(),
                serde_json::json!({"items": [key], "reason": "move"})
            )]
        );
    }

    #[test]
    fn a_move_between_satellites_leaves_the_source_open_and_empty() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[key.clone()]);
        satellite(&rec, "sat-2", &[]);
        let (move_id, _) = started(move_item(&rec, &reg, "sat-1", &key, "sat-2", true));
        hand_off_ack(&rec, &reg, "sat-1", &ack(&move_id, true, None));
        assert_eq!(reg.owner(&key), "sat-2");
        let source = slice(&reg, "sat-1");
        assert!(source.items.is_empty());
        assert!(
            rec.window_exists("sat-1"),
            "closing it is the person's choice"
        );
        assert!(rec.events(ITEMS_RETURNED_EVENT).is_empty());
    }

    #[test]
    fn an_ack_with_a_wrong_move_id_or_from_another_window_is_ignored() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[]);
        satellite(&rec, "sat-2", &[]);
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        let wrong = hand_off_ack(&rec, &reg, MAIN_LABEL, &ack("mv-99", true, None));
        let other = hand_off_ack(&rec, &reg, "sat-2", &ack(&move_id, true, None));
        assert_eq!((wrong, other), (AckOutcome::Ignored, AckOutcome::Ignored));
        assert_eq!(reg.owner(&key), MAIN_LABEL);
        assert_eq!(
            hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None)),
            AckOutcome::Committed
        );
        assert_eq!(
            hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None)),
            AckOutcome::Ignored
        );
    }

    #[test]
    fn an_ack_before_the_hand_off_is_ignored() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        let out = hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        assert_eq!(out, AckOutcome::Ignored);
        assert_eq!(reg.owner(&key), MAIN_LABEL);
    }

    #[test]
    fn the_target_is_focused_after_the_commit_outside_the_lock() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[]);
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        rec.clear();
        hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        let fx = rec.fx.borrow();
        assert_eq!(
            fx.last(),
            Some(&Fx::Focused {
                label: "sat-1".to_owned(),
                under_lock: false
            })
        );
    }

    #[test]
    fn a_ready_but_uncommitted_window_is_refused_as_a_target() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let (_, target) = started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("a.md"),
            NEW_WINDOW,
            true,
        ));
        window_ready(&rec, &reg, &target).unwrap();
        let out = move_item(&rec, &reg, MAIN_LABEL, &tab("b.md"), &target, true);
        assert_eq!(reason_of(out), reason::PENDING_TARGET);
    }

    #[test]
    fn a_move_builds_and_commits_on_the_mock_runtime() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, MAIN_LABEL, tauri::WebviewUrl::default())
            .build()
            .unwrap();
        app.manage(WindowRegistry::new());
        let handle = app.handle();
        let reg = app.state::<WindowRegistry>();
        let key = tab("a.md");
        let (move_id, target) =
            started(move_item(handle, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        assert!(
            handle.get_webview_window(&target).is_some(),
            "the target window is built"
        );
        window_ready(handle, &reg, &target).unwrap();
        let out = hand_off_ack(handle, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        assert_eq!(out, AckOutcome::Committed);
        assert_eq!(reg.owner(&key), target);
    }
}

#[cfg(test)]
mod abort {
    use super::bench::*;
    use super::*;

    fn aborted(rec: &Rec<'_>) -> Vec<(String, serde_json::Value)> {
        rec.events(MOVE_ABORTED_EVENT)
    }

    #[test]
    fn a_dirty_ack_aborts_and_the_source_keeps_the_item() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, target) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        window_ready(&rec, &reg, &target).unwrap();
        let out = hand_off_ack(
            &rec,
            &reg,
            MAIN_LABEL,
            &ack(&move_id, false, Some(reason::DIRTY)),
        );
        assert_eq!(out, AckOutcome::Aborted);
        assert_eq!(reg.owner(&key), MAIN_LABEL);
        assert_eq!(
            aborted(&rec),
            vec![(
                MAIN_LABEL.to_owned(),
                serde_json::json!({"key": key, "moveId": move_id, "reason": "dirty"})
            )]
        );
        assert!(
            reg.get_slice(MAIN_LABEL, &target).is_err(),
            "the half-made entry is gone"
        );
        assert!(!rec.window_exists(&target), "and its window");
    }

    #[test]
    fn no_ack_aborts_and_the_source_is_told_to_reopen() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[]);
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        on_timer(&rec, &reg, &MoveTimer::HandOff(move_id.clone()));
        assert_eq!(reg.owner(&key), MAIN_LABEL);
        assert_eq!(aborted(&rec)[0].1["reason"], "no_ack");
        assert!(
            rec.window_exists("sat-1"),
            "an existing target is never destroyed"
        );
        let late = hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        assert_eq!(late, AckOutcome::Ignored);
        assert_eq!(reg.owner(&key), MAIN_LABEL);
    }

    #[test]
    fn the_pending_timeout_first_wins_and_a_late_ready_is_ignored() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, target) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        on_timer(&rec, &reg, &MoveTimer::Pending(move_id));
        assert_eq!(aborted(&rec)[0].1["reason"], "timeout");
        rec.clear();
        assert!(
            window_ready(&rec, &reg, &target).is_err(),
            "the entry is gone"
        );
        assert!(rec.events(HAND_OFF_EVENT).is_empty());
    }

    #[test]
    fn a_ready_first_wins_and_the_late_pending_timeout_is_ignored() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        let (move_id, target) = started(move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true));
        window_ready(&rec, &reg, &target).unwrap();
        on_timer(&rec, &reg, &MoveTimer::Pending(move_id.clone()));
        assert!(aborted(&rec).is_empty());
        assert_eq!(
            hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None)),
            AckOutcome::Committed
        );
    }

    #[test]
    fn a_source_that_is_gone_at_ready_aborts() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[key.clone()]);
        let (_, target) = started(move_item(&rec, &reg, "sat-1", &key, NEW_WINDOW, true));
        rec.windows.borrow_mut().remove("sat-1");
        window_ready(&rec, &reg, &target).unwrap();
        assert_eq!(aborted(&rec)[0].1["reason"], "gone");
        assert!(rec.events(HAND_OFF_EVENT).is_empty());
        assert!(!rec.window_exists(&target));
    }

    #[test]
    fn a_source_that_goes_during_the_hand_off_aborts() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[key.clone()]);
        let (move_id, target) = started(move_item(&rec, &reg, "sat-1", &key, NEW_WINDOW, true));
        window_ready(&rec, &reg, &target).unwrap();
        window_gone(&rec, &reg, "sat-1");
        assert_eq!(aborted(&rec)[0].1["reason"], "gone");
        assert!(!rec.window_exists(&target));
        let late = hand_off_ack(&rec, &reg, "sat-1", &ack(&move_id, true, None));
        assert_eq!(late, AckOutcome::Ignored);
    }

    #[test]
    fn the_half_made_window_is_destroyed_after_the_lock_is_released() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let (move_id, target) = started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("a.md"),
            NEW_WINDOW,
            true,
        ));
        window_ready(&rec, &reg, &target).unwrap();
        hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, false, None));
        let destroyed: Vec<_> = rec
            .fx
            .borrow()
            .iter()
            .filter(|f| matches!(f, Fx::Destroyed { .. }))
            .cloned()
            .collect();
        assert_eq!(
            destroyed,
            vec![Fx::Destroyed {
                label: target,
                under_lock: false
            }]
        );
    }

    #[test]
    fn a_target_whose_window_is_gone_is_refused_though_its_entry_remains() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        satellite(&rec, "sat-1", &[]);
        rec.windows.borrow_mut().remove("sat-1");
        rec.clear();
        let out = move_item(&rec, &reg, MAIN_LABEL, &tab("a.md"), "sat-1", true);
        assert_eq!(reason_of(out), reason::UNKNOWN_TARGET);
        assert!(rec.fx.borrow().is_empty());
        assert_eq!(reg.owner(&tab("a.md")), MAIN_LABEL);
    }

    #[test]
    fn an_ack_for_a_target_that_closed_aborts_as_gone_and_the_source_keeps_the_item() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[]);
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        rec.windows.borrow_mut().remove("sat-1");
        let out = hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        assert_eq!(out, AckOutcome::Aborted);
        assert_eq!(reg.owner(&key), MAIN_LABEL);
        assert_eq!(aborted(&rec)[0].1["reason"], "gone");
        assert!(slice(&reg, "sat-1").items.is_empty());
        assert!(!rec
            .fx
            .borrow()
            .iter()
            .any(|f| matches!(f, Fx::Focused { .. })));
    }

    #[test]
    fn a_failed_transfer_aborts_the_move_instead_of_reporting_a_commit() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let key = tab("a.md");
        satellite(&rec, "sat-1", &[]);
        let (move_id, _) = started(move_item(&rec, &reg, MAIN_LABEL, &key, "sat-1", true));
        // The window is alive but its entry is gone, so the transfer has no target.
        {
            let mut locked = reg.locked();
            Locked::remove_empty_satellite(&mut locked, "sat-1").unwrap();
        }
        let out = hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None));
        assert_eq!(out, AckOutcome::Aborted);
        assert_eq!(reg.owner(&key), MAIN_LABEL);
        assert_eq!(aborted(&rec)[0].1["reason"], "gone");
        assert_eq!(
            hand_off_ack(&rec, &reg, MAIN_LABEL, &ack(&move_id, true, None)),
            AckOutcome::Ignored,
            "the move is closed"
        );
    }

    #[test]
    fn a_window_that_fails_to_build_aborts_the_move() {
        let reg = WindowRegistry::new();
        let mut rec = Rec::new(&reg);
        rec.fail_create = true;
        let key = tab("a.md");
        let out = move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true);
        assert_eq!(reason_of(out), reason::WINDOW_FAILED);
        assert_eq!(slice(&reg, MAIN_LABEL).owners, Some(Default::default()));
        assert!(rec.timers().is_empty());
        assert!(
            aborted(&rec).is_empty(),
            "the caller gets the refusal alone; no move-aborted for a move it never heard of"
        );
        let again = move_item(&rec, &reg, MAIN_LABEL, &key, NEW_WINDOW, true);
        assert_eq!(
            reason_of(again),
            reason::WINDOW_FAILED,
            "the key is not left locked"
        );
    }

    #[test]
    fn abort_all_moves_ends_every_move_in_flight() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        satellite(&rec, "sat-1", &[]);
        let (_, new) = started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("a.md"),
            NEW_WINDOW,
            true,
        ));
        started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("b.md"),
            "sat-1",
            true,
        ));
        abort_all_moves(&rec, &reg, "quit");
        let reasons: Vec<_> = aborted(&rec)
            .into_iter()
            .map(|(_, p)| p["reason"].clone())
            .collect();
        assert_eq!(reasons, vec!["quit", "quit"]);
        assert!(!rec.window_exists(&new));
        assert!(rec.window_exists("sat-1"));
        assert!(reg.get_slice(MAIN_LABEL, &new).is_err());
        started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("a.md"),
            "sat-1",
            true,
        ));
    }

    #[test]
    fn abort_all_moves_locked_leaves_the_destroys_to_the_caller() {
        let reg = WindowRegistry::new();
        let rec = Rec::new(&reg);
        let (_, new) = started(move_item(
            &rec,
            &reg,
            MAIN_LABEL,
            &tab("a.md"),
            NEW_WINDOW,
            true,
        ));
        let destroy = {
            let mut locked = reg.locked();
            abort_all_moves_locked(&mut locked, &rec, "profile_switch")
        };
        assert_eq!(destroy, vec![new.clone()]);
        assert!(
            rec.window_exists(&new),
            "nothing is destroyed under the lock"
        );
    }
}

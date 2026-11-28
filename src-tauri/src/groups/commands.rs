// SPDX-License-Identifier: MIT
//! The window's two group commands: `group_read` hydrates a layout from its group file and
//! `group_commit` sends the kit ops of a gesture, written by the store as the person at that
//! window, which then publishes the change on the host-only `group` and `groups` topics. Both
//! refuse with the tiles flag off.
//!
//! A window's pins go through `window_pins_read` and `window_pins_write`, over the store's one
//! pins accessor in the active org's group folder, keyed by the calling window's own label.
//!
//! Each command runs its store work (the lock, the fsync, the projection) on the blocking pool,
//! off the command workers.

use serde::{Deserialize, Serialize};

use super::ops::parse_op;
use super::shape::{OwnerKind, SavedNode};
use super::store::{GroupStore, StoreError, StoreWrite, Writer};
use crate::commands::async_helpers::await_blocking;

/// Which group file a command names.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupFileRef {
    pub owner: OwnerKind,
    pub id: String,
}

/// A file's head as `group_read` returns it; `tree` is null for a deleted file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GroupHead {
    pub rev: u64,
    pub tree: Option<SavedNode>,
}

/// What `group_commit` did: `{rev}` when the ops were written, `{conflict}` when nothing was.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CommitReply {
    Placed { rev: u64 },
    Conflict { conflict: CommitConflict },
}

/// A refused commit. `collided` is set only when an agent's write touched the op's tile keys:
/// the window reloads the head and drops the op. Without it the window replays on the head.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitConflict {
    pub current_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collided: Option<Vec<String>>,
}

/// `group_read` on `store`.
pub fn read(store: &GroupStore, file: &GroupFileRef) -> Result<Option<GroupHead>, String> {
    if !GroupStore::tiles(store) {
        return Err(StoreError::TilesOff.to_string());
    }
    let head = GroupStore::group_head(store, &file.id).map_err(|e| e.to_string())?;
    Ok(head.map(|(rev, tree)| GroupHead { rev, tree }))
}

/// `group_commit` on `store` from the window labelled `window`.
pub fn commit(
    store: &GroupStore,
    window: &str,
    file: &GroupFileRef,
    base_rev: u64,
    ops: &[serde_json::Value],
) -> Result<CommitReply, String> {
    let ops = ops
        .iter()
        .map(parse_op)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|why| format!("refused: {why}"))?;
    let write = StoreWrite {
        writer: Writer::Person {
            window: window.to_string(),
        },
        base_rev,
        owner: file.owner,
        ops,
    };
    match GroupStore::write(store, &file.id, write) {
        Ok(placed) => Ok(CommitReply::Placed { rev: placed.rev }),
        Err(StoreError::Conflict { current_revision }) => Ok(CommitReply::Conflict {
            conflict: CommitConflict {
                current_revision,
                collided: None,
            },
        }),
        Err(StoreError::Collided(collision)) => Ok(CommitReply::Conflict {
            conflict: CommitConflict {
                current_revision: collision.current_revision,
                collided: Some(collision.keys),
            },
        }),
        Err(error) => Err(error.to_string()),
    }
}

/// What `window_pins_write` did: `{ok: true}`, or `{refused}` with why nothing was written.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PinsReply {
    Written { ok: bool },
    Refused { refused: PinsRefusal },
}

/// Why a pins write was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PinsRefusal {
    /// The window already holds three pins.
    Fourth,
    /// The tiles flag is off.
    FlagOff,
    /// No org is active, so there is no group folder to hold them.
    NoOrg,
}

/// `window_pins_read` on the active org's `store` (`None` with no active org): no pins then.
pub fn read_pins(
    tiles: bool,
    store: Option<&GroupStore>,
    label: &str,
) -> Result<Vec<String>, String> {
    if !tiles {
        return Err(StoreError::TilesOff.to_string());
    }
    match store {
        None => Ok(vec![]),
        Some(store) => GroupStore::window_pins(store, label).map_err(|e| e.to_string()),
    }
}

/// `window_pins_write` on the active org's `store` (`None` with no active org).
pub fn write_pins(
    tiles: bool,
    store: Option<&GroupStore>,
    label: &str,
    keys: Vec<String>,
) -> Result<PinsReply, String> {
    if !tiles {
        return Ok(PinsReply::Refused {
            refused: PinsRefusal::FlagOff,
        });
    }
    let Some(store) = store else {
        return Ok(PinsReply::Refused {
            refused: PinsRefusal::NoOrg,
        });
    };
    match GroupStore::set_window_pins(store, label, keys) {
        Ok(()) => Ok(PinsReply::Written { ok: true }),
        Err(StoreError::TilesOff) => Ok(PinsReply::Refused {
            refused: PinsRefusal::FlagOff,
        }),
        Err(StoreError::PinsFull) => Ok(PinsReply::Refused {
            refused: PinsRefusal::Fourth,
        }),
        Err(error) => Err(error.to_string()),
    }
}

/// The store of the active org, or `None` when no org is active.
fn active_store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tiles: bool,
) -> Result<Option<GroupStore>, String> {
    let home = crate::commands::paths::codesense_home_dir()
        .ok_or_else(|| "the CodeSense folder is unavailable".to_string())?;
    match crate::context_repo::scratch_space::active_org(&home) {
        None => Ok(None),
        Some(org) => store_for(app, tiles, &org).map(Some),
    }
}

/// The store of the active profile's private layer for the context repo `org`.
fn store_for<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tiles: bool,
    org: &str,
) -> Result<GroupStore, String> {
    let principal = crate::commands::local_profile::active(app)?.principal;
    let home = crate::commands::paths::codesense_home_dir()
        .ok_or_else(|| "the CodeSense folder is unavailable".to_string())?;
    let store = GroupStore::at(&home, &principal, org, tiles).map_err(|e| e.to_string())?;
    let suppression = tauri::Manager::try_state::<crate::commands::watch::WatcherState>(app)
        .map(|state| state.dispatcher.suppression_handle());
    Ok(match suppression {
        Some(handle) => store.with_suppression(handle),
        None => store,
    })
}

/// The group file `file` of the context repo `org`, as a window hydrates it: null when it
/// doesn't exist.
#[tauri::command]
pub async fn group_read(
    app: tauri::AppHandle,
    flag: tauri::State<'_, crate::flags::TilesFlag>,
    org: String,
    file: GroupFileRef,
) -> Result<Option<GroupHead>, String> {
    let tiles = flag.is_on();
    await_blocking("group_read", move || {
        read(&store_for(&app, tiles, &org)?, &file)
    })
    .await
}

/// Writes a gesture's kit ops to the group file `file` of the context repo `org`, as the person
/// at the calling window, on the `baseRev` the window last read.
#[tauri::command]
pub async fn group_commit(
    app: tauri::AppHandle,
    window: tauri::Window,
    flag: tauri::State<'_, crate::flags::TilesFlag>,
    org: String,
    file: GroupFileRef,
    base_rev: u64,
    ops: Vec<serde_json::Value>,
) -> Result<CommitReply, String> {
    let tiles = flag.is_on();
    let label = String::from(tauri::Window::label(&window));
    await_blocking("group_commit", move || {
        let store = store_for(&app, tiles, &org)?;
        let reply = commit(&store, &label, &file, base_rev, &ops)?;
        if let CommitReply::Placed { .. } = reply {
            // The write is placed whatever the publish does; a window that misses the delta
            // reads the head on its next conflict.
            if let Err(e) = crate::live_hub::groups::publish_change(&app, &store, &file.id) {
                log::warn!(target: "groups", "could not publish a group change: {e}");
            }
        }
        Ok(reply)
    })
    .await
}

/// The calling window's pins, from the active org's group folder: none when no org is active.
/// Refused with tiles off.
#[tauri::command]
pub async fn window_pins_read(
    app: tauri::AppHandle,
    window: tauri::Window,
    flag: tauri::State<'_, crate::flags::TilesFlag>,
) -> Result<Vec<String>, String> {
    let tiles = flag.is_on();
    let label = String::from(tauri::Window::label(&window));
    await_blocking("window_pins_read", move || {
        let store = active_store(&app, tiles)?;
        read_pins(tiles, store.as_ref(), &label)
    })
    .await
}

/// Replaces the calling window's pins with `keys`, in one write.
#[tauri::command]
pub async fn window_pins_write(
    app: tauri::AppHandle,
    window: tauri::Window,
    flag: tauri::State<'_, crate::flags::TilesFlag>,
    keys: Vec<String>,
) -> Result<PinsReply, String> {
    let tiles = flag.is_on();
    let label = String::from(tauri::Window::label(&window));
    await_blocking("window_pins_write", move || {
        let store = active_store(&app, tiles)?;
        write_pins(tiles, store.as_ref(), &label, keys)
    })
    .await
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;

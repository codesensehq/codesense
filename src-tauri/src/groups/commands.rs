// SPDX-License-Identifier: MIT
//! The window's two group commands: `group_read` hydrates a layout from its group file and
//! `group_commit` sends the kit ops of a gesture, written by the store as the person at that
//! window. Both refuse with the tiles flag off.

use serde::{Deserialize, Serialize};

use super::ops::parse_op;
use super::shape::{OwnerKind, SavedNode};
use super::store::{GroupStore, StoreError, StoreWrite, Writer};

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
    let head = GroupStore::head(store, &file.id).map_err(|e| e.to_string())?;
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
    match store.write(&file.id, write) {
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
pub fn group_read(
    app: tauri::AppHandle,
    flag: tauri::State<'_, crate::flags::TilesFlag>,
    org: String,
    file: GroupFileRef,
) -> Result<Option<GroupHead>, String> {
    read(&store_for(&app, flag.is_on(), &org)?, &file)
}

/// Writes a gesture's kit ops to the group file `file` of the context repo `org`, as the person
/// at the calling window, on the `baseRev` the window last read.
#[tauri::command]
pub fn group_commit(
    app: tauri::AppHandle,
    window: tauri::Window,
    flag: tauri::State<'_, crate::flags::TilesFlag>,
    org: String,
    file: GroupFileRef,
    base_rev: u64,
    ops: Vec<serde_json::Value>,
) -> Result<CommitReply, String> {
    let store = store_for(&app, flag.is_on(), &org)?;
    commit(&store, window.label(), &file, base_rev, &ops)
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;

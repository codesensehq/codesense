// SPDX-License-Identifier: MIT
//! The media sidecar `chats/<slug>.media.json`: what a chat message's image became
//! after its send (fetched, failed, view ping sent). The log line keeps the image as
//! sent and is never rewritten; reads overlay this file by message id. It holds no
//! bytes. Writes go through `write_json_atomic` under the store lock; a corrupt or
//! unreadable file reads as missing, and the next write replaces it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::super::index::{chats_dir, log_path, workspace_slug};
use super::super::model::{ChatMediaState, WorkspaceChatMessage};
use super::{read_messages, validate_workspace_id, ChatStoreError, WorkspaceChatStore};
use crate::media::Attachment;
use crate::shared::json_io::{read_json, write_json_atomic, JsonIoError};

/// One message's image as it stands now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMediaEntry {
    pub attachments: Vec<Attachment>,
    pub state: ChatMediaState,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct ChatMediaSidecar {
    #[serde(default)]
    messages: BTreeMap<i64, ChatMediaEntry>,
}

impl ChatMediaSidecar {
    fn overlay(&self, message: &mut WorkspaceChatMessage) {
        if let Some(entry) = self.messages.get(&message.message_id) {
            message.attachments = entry.attachments.clone();
            message.media_state = Some(entry.state);
        }
    }
}

fn sidecar_path(home: &Path, workspace: &str) -> PathBuf {
    chats_dir(home).join(format!("{}.media.json", workspace_slug(workspace)))
}

fn load(path: &Path) -> ChatMediaSidecar {
    match read_json::<ChatMediaSidecar>(path) {
        Ok(sidecar) => sidecar,
        Err(JsonIoError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            ChatMediaSidecar::default()
        }
        Err(e) => {
            log::warn!(
                target: "workspace_chat",
                "media sidecar {} unreadable, reading rows as sent: {e}",
                path.display(),
            );
            ChatMediaSidecar::default()
        }
    }
}

/// Message `message_id` of the log at `path`, as sent.
fn row(path: &Path, message_id: i64) -> Result<Option<WorkspaceChatMessage>, ChatStoreError> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(read_messages(path, Some(message_id - 1), 1)?
        .into_iter()
        .find(|m| m.message_id == message_id))
}

/// `messages` with their media as the sidecar of `workspace` says, if any carries media.
pub(super) fn overlay(home: &Path, workspace: &str, messages: &mut [WorkspaceChatMessage]) {
    if messages.iter().all(|m| m.attachments.is_empty()) {
        return;
    }
    let sidecar = load(&sidecar_path(home, workspace));
    for message in messages {
        sidecar.overlay(message);
    }
}

impl WorkspaceChatStore {
    /// Run `f` on message `message_id`'s media entry (the sidecar's, else the row's as
    /// sent) and write the sidecar when `f` changed it, all under the store lock.
    /// `None` when the message is unknown or carries no media.
    fn with_media<T>(
        &self,
        workspace: &str,
        message_id: i64,
        f: impl FnOnce(&mut ChatMediaEntry) -> T,
    ) -> Result<Option<T>, ChatStoreError> {
        let workspace = validate_workspace_id(workspace)?;
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let home = inner.home.as_ref().ok_or(ChatStoreError::NotInstalled)?;
        let path = sidecar_path(home, &workspace);
        let mut sidecar = load(&path);
        let current = match sidecar.messages.get(&message_id) {
            Some(entry) => entry.clone(),
            None => {
                let Some(row) = row(&log_path(home, &workspace_slug(&workspace)), message_id)?
                else {
                    return Ok(None);
                };
                let Some(state) = row.media_state.filter(|_| !row.attachments.is_empty()) else {
                    return Ok(None);
                };
                ChatMediaEntry {
                    attachments: row.attachments,
                    state,
                }
            }
        };
        let mut next = current.clone();
        let out = f(&mut next);
        if next != current {
            sidecar.messages.insert(message_id, next);
            write_json_atomic(&path, &sidecar)?;
        }
        Ok(Some(out))
    }

    /// Record message `message_id`'s image as `attachments` in `state`: a fetch result.
    /// A view ping settled meanwhile stays settled. `false` when the message is unknown
    /// or carries no media.
    pub fn set_media(
        &self,
        workspace: &str,
        message_id: i64,
        attachments: Vec<Attachment>,
        state: ChatMediaState,
    ) -> Result<bool, ChatStoreError> {
        let mut attachments = attachments;
        self.with_media(workspace, message_id, |entry| {
            for (a, was) in attachments.iter_mut().zip(&entry.attachments) {
                a.onload_sent |= was.onload_sent;
            }
            *entry = ChatMediaEntry { attachments, state };
        })
        .map(|done| done.is_some())
    }

    /// Mark the view ping of attachment `slot` on message `message_id` settled. Returns
    /// the message's attachments when this call marked it, `None` when it was settled
    /// already or there is no such attachment.
    pub fn mark_media_onload(
        &self,
        workspace: &str,
        message_id: i64,
        slot: usize,
    ) -> Result<Option<Vec<Attachment>>, ChatStoreError> {
        let marked = self.with_media(workspace, message_id, |entry| {
            match entry.attachments.get_mut(slot) {
                Some(a) if !a.onload_sent => {
                    a.onload_sent = true;
                    Some(entry.attachments.clone())
                }
                _ => None,
            }
        })?;
        Ok(marked.flatten())
    }

    /// Message `message_id` with its media as it stands now; `None` when unknown.
    pub fn media_message(
        &self,
        workspace: &str,
        message_id: i64,
    ) -> Result<Option<WorkspaceChatMessage>, ChatStoreError> {
        let workspace = validate_workspace_id(workspace)?;
        let home = self.home()?;
        let Some(mut message) = row(&log_path(&home, &workspace_slug(&workspace)), message_id)?
        else {
            return Ok(None);
        };
        overlay(&home, &workspace, std::slice::from_mut(&mut message));
        Ok(Some(message))
    }

    /// Every message of `workspace` that carries media, as it stands now: what the
    /// media index learns of the chat.
    pub fn media_messages(
        &self,
        workspace: &str,
    ) -> Result<Vec<WorkspaceChatMessage>, ChatStoreError> {
        let workspace = validate_workspace_id(workspace)?;
        let home = self.home()?;
        let path = log_path(&home, &workspace_slug(&workspace));
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut messages: Vec<_> = read_messages(&path, None, u32::MAX)?
            .into_iter()
            .filter(|m| !m.attachments.is_empty())
            .collect();
        overlay(&home, &workspace, &mut messages);
        Ok(messages)
    }

    fn home(&self) -> Result<PathBuf, ChatStoreError> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .home
            .clone()
            .ok_or(ChatStoreError::NotInstalled)
    }
}

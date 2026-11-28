// SPDX-License-Identifier: MIT
//! The one send core both chat senders share: an agent's MCP post and the person's
//! compose. Everything is checked before anything is written, so a refused send writes
//! nothing and fans nothing out.

use std::future::Future;
use std::sync::Arc;

use super::media::{ChatSender, MediaRefusal};
use super::model::{MessageContentType, MessageKind, MessageOnClick, WorkspaceChatMessage};
use super::store::{ChatAppend, ChatStoreError, WorkspaceChatStore};
use crate::commands::agent_inbox::InboxHost;
use crate::media::MediaInput;

/// A post to a workspace chat, as its sender wrote it.
#[derive(Debug, Clone)]
pub(crate) struct ChatPost {
    pub workspace: String,
    pub from_name: String,
    /// Optional when `media` is set; blank text without media is refused.
    pub text: String,
    pub content_type: Option<MessageContentType>,
    pub on_click: Option<MessageOnClick>,
    pub primary_file: Option<String>,
    pub media: Option<MediaInput>,
}

/// Why a send was refused. Nothing was written.
#[derive(Debug)]
pub(crate) enum SendRefusal {
    Store(ChatStoreError),
    Media(MediaRefusal),
    /// The blocking append's task ended without a result.
    Join(String),
}

/// Post `post` as `sender`. Text, media and the encoded line are checked before
/// `started` (the first-use anchor) runs or anything is appended. A post with media is
/// then indexed, registered once and, when admitted, fetched in the background; then
/// `fanout` runs once with the stored message.
pub(crate) async fn send(
    host: &Arc<dyn InboxHost>,
    store: &WorkspaceChatStore,
    sender: ChatSender,
    post: ChatPost,
    started: impl Future<Output = ()>,
    fanout: impl FnOnce(&WorkspaceChatMessage),
) -> Result<WorkspaceChatMessage, SendRefusal> {
    if post.text.trim() == "" && post.media.is_none() {
        return Err(SendRefusal::Store(ChatStoreError::EmptyText));
    }
    let prepared = match &post.media {
        Some(input) => Some(
            super::media::prepare(&**host, &sender, input)
                .await
                .map_err(SendRefusal::Media)?,
        ),
        None => None,
    };
    let fetch = prepared.as_ref().is_some_and(|p| p.fetch);
    let at = ChatAppend {
        workspace_id: post.workspace,
        from: sender.from().to_string(),
        from_name: post.from_name,
        text: post.text,
        kind: MessageKind::Chat,
        content_type: post.content_type,
        on_click: post.on_click,
        primary_file: post.primary_file,
        media: prepared.map(|p| p.media),
    };
    store.check_line(&at).map_err(SendRefusal::Store)?;
    started.await;
    let writer = store.clone();
    // The fetch's in-flight mark is taken with the append, so a send dropped before the
    // fetch starts drops the mark with it.
    let (message, in_flight) = tauri::async_runtime::spawn_blocking(move || {
        let message = writer.append(at, chrono::Utc::now().timestamp_millis())?;
        let in_flight = fetch.then(|| writer.in_flight(&message.workspace_id, message.message_id));
        Ok::<_, ChatStoreError>((message, in_flight))
    })
    .await
    .map_err(|e| SendRefusal::Join(e.to_string()))?
    .map_err(SendRefusal::Store)?;
    super::media::stored(host, &message, in_flight).await;
    fanout(&message);
    Ok(message)
}

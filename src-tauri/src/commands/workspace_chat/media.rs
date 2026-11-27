// SPDX-License-Identifier: MIT
//! Images on workspace chat messages, by the inbox's rules: the send path prepares
//! and admits one, the media index owns it, and the app window loads and reads it.
//! The sender session's team governs a message's image; that team's Off switch wins
//! at every later step.

use std::sync::Arc;

use serde::Serialize;

use super::model::{ChatMediaState, WorkspaceChatMessage};
use super::store::{ChatAppendMedia, InFlight, WorkspaceChatStore};
use crate::commands::agent_inbox::{
    handle_team, human_media_refusal, team_inbox, InboxHost, InboxMediaBytes, StoredMedia,
    MEDIA_SLOT,
};
use crate::commands::dashboard_launch::LaunchTeam;
use crate::context_repo::caller_scope::CallerScope;
use crate::media::{index::Owner, Attachment, MediaInput, Remote};

/// Emitted when a chat message's image changes state on this Mac (a fetch finished).
pub const MEDIA_EVENT: &str = "codesense:workspace-chat-media";

/// The longest `alt` a chat image may carry, in bytes, so a post stays well inside the
/// log's line bound.
pub const MAX_ALT_BYTES: usize = 1024;

/// The longest `url` a chat image may carry, in bytes, for the same reason.
pub const MAX_URL_BYTES: usize = 2048;

/// The [`MEDIA_EVENT`] payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMediaPayload {
    pub workspace_id: String,
    pub message_id: i64,
}

/// An image ready to append: `fetch` when the send admitted it to load now.
#[derive(Debug, Clone)]
pub(crate) struct PreparedChatMedia {
    pub media: ChatAppendMedia,
    pub fetch: bool,
}

/// The media index owner of chat message `message_id` in `workspace`.
pub(crate) fn owner(team: &LaunchTeam, workspace: &str, message_id: i64) -> Owner {
    crate::gif::register::owner_of(team, Some(workspace), message_id)
}

/// Who sends a chat post: an agent's session, or the person at this Mac.
#[derive(Debug, Clone)]
pub(crate) enum ChatSender {
    /// The session under `handle`, `remote` when it runs on another machine. Its team,
    /// read scope and workspace come from its session.
    Session { handle: String, remote: bool },
    /// The person, sending with `team`, the chat's team; the team is read only when the
    /// post carries media.
    Human { team: Option<LaunchTeam> },
}

impl ChatSender {
    /// The `from` a post by this sender is stored with.
    pub(crate) fn from(&self) -> &str {
        match self {
            Self::Session { handle, .. } => &handle[..],
            Self::Human { .. } => super::model::HUMAN,
        }
    }
}

/// Why a post's media was refused. The person's refusals are typed so the app can
/// say how to recover; a session's are always [`MediaRefusal::Invalid`], told as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MediaRefusal {
    /// The person's GIF has a blank description.
    NoAlt,
    /// The person's send has no team, or a team this Mac doesn't sync.
    NoTeam,
    /// Anything else, with the engine's reason.
    Invalid(String),
}

impl MediaRefusal {
    /// The engine's reason, as an agent or a log reads it.
    pub(crate) fn reason(&self) -> String {
        match self {
            Self::NoAlt => "media.alt is required".into(),
            Self::NoTeam => "media needs a team this machine syncs".into(),
            Self::Invalid(reason) => reason.clone(),
        }
    }
}

/// The length limits every sender's media is held to.
fn check_bounds(input: &MediaInput) -> Result<(), String> {
    if input.alt.len() > MAX_ALT_BYTES {
        return Err(format!("media.alt exceeds {MAX_ALT_BYTES} bytes"));
    }
    if input.url.as_ref().is_some_and(|u| u.len() > MAX_URL_BYTES) {
        return Err(format!("media.url exceeds {MAX_URL_BYTES} bytes"));
    }
    Ok(())
}

/// Prepare `input` for a post by `sender`, as `send_message` does, and record what the
/// send admitted.
///
/// A session's media is refused when invalid, with an overlong alt or url, a file path
/// from a session not on this machine, or a session with no team. The person's is
/// refused with no team or one this Mac doesn't sync (checked first, so nothing is
/// prepared for it), a blank alt, a `path`, or an invalid or overlong input; their
/// `url` is this machine's own, read with the person's scope and no workspace root.
pub(crate) async fn prepare(
    host: &dyn InboxHost,
    sender: &ChatSender,
    input: &MediaInput,
) -> Result<PreparedChatMedia, MediaRefusal> {
    let (team, own, scope, workspace_root) = match sender {
        ChatSender::Session { handle, remote } => {
            let invalid = MediaRefusal::Invalid;
            input.validate().map_err(invalid)?;
            check_bounds(input).map_err(invalid)?;
            // Decided on the sender: a remote team's caller scope would read its path here.
            let own = !remote && host.own_media_sender(handle).await;
            if input.path.is_some() && !own {
                return Err(invalid(
                    "media.path needs a session on this machine; send a url instead".into(),
                ));
            }
            let team = handle_team(host, handle).await.ok_or_else(|| {
                invalid(
                    "media needs a session in a team; this session has none, so send text only"
                        .into(),
                )
            })?;
            let scope = host.caller_scope(handle).await;
            let workspace_root = host.caller_media_workspace(handle).await;
            (team, own, scope, workspace_root)
        }
        ChatSender::Human { team } => {
            let team = team.clone().ok_or(MediaRefusal::NoTeam)?;
            let team = team_inbox(host, team)
                .await
                .map_err(|e| {
                    log::warn!(target: "workspace_chat", "chat media: team inbox unavailable: {e:?}");
                    MediaRefusal::NoTeam
                })?
                .team;
            if input.alt.trim().is_empty() {
                return Err(MediaRefusal::NoAlt);
            }
            if let Some(reason) = human_media_refusal(input) {
                return Err(MediaRefusal::Invalid(reason));
            }
            check_bounds(input).map_err(MediaRefusal::Invalid)?;
            (team, true, CallerScope::Human, None)
        }
    };
    let (attachment, auto) = host
        .prepare_media(
            &team,
            input,
            input.url.is_some() && own,
            &scope,
            workspace_root.as_deref(),
        )
        .await
        .map_err(MediaRefusal::Invalid)?;
    let off = host.media_config(&team).remote == Remote::Off;
    let state = if attachment.state == "cached" {
        ChatMediaState::Cached
    } else if auto && !off {
        ChatMediaState::Pending
    } else {
        ChatMediaState::TapToLoad
    };
    Ok(PreparedChatMedia {
        media: ChatAppendMedia {
            team,
            attachment,
            state,
        },
        fetch: state == ChatMediaState::Pending,
    })
}

/// `message` was appended with media: index it, register it once, and start the fetch
/// the send admitted, which owns `in_flight` until it ends. The fetch runs with no store
/// lock held.
pub(crate) async fn stored(
    host: &Arc<dyn InboxHost>,
    message: &WorkspaceChatMessage,
    in_flight: Option<InFlight>,
) {
    let (Some(team), Some(attachment)) = (&message.media_team, message.attachments.first()) else {
        return;
    };
    let workspace = &message.workspace_id;
    host.note_chat_media(
        owner(team, workspace, message.message_id),
        &message.attachments,
    )
    .await;
    host.media_sent(&StoredMedia {
        team: team.clone(),
        message_id: message.message_id,
        slot: MEDIA_SLOT,
        attachment: attachment.clone(),
        chat: Some(workspace.clone()),
    });
    let Some(in_flight) = in_flight else {
        return;
    };
    let Some(store) = host.chat_store() else {
        return;
    };
    let (host, team, workspace, attachment) = (
        host.clone(),
        team.clone(),
        workspace.clone(),
        attachment.clone(),
    );
    let message_id = message.message_id;
    tauri::async_runtime::spawn(async move {
        // Dropped when the task ends, by a result, an error, a panic or a cancel.
        let _in_flight = in_flight;
        if let Err(e) = finish_fetch(
            &host, &store, &team, &workspace, message_id, attachment, true,
        )
        .await
        {
            log::warn!(target: "workspace_chat", "chat media: {e}");
        }
    });
}

/// Fetch `attachment` of chat message `message_id` and record the result in the media
/// sidecar, then in the index and the provider registration. An automatic fetch that
/// errors is recorded as failed, so the message does not stay pending; a tap's error
/// goes back to the tap.
async fn finish_fetch(
    host: &Arc<dyn InboxHost>,
    store: &WorkspaceChatStore,
    team: &LaunchTeam,
    workspace: &str,
    message_id: i64,
    attachment: Attachment,
    automatic: bool,
) -> Result<(), String> {
    let (fetched, ok) = match host.fetch_media(team, attachment.clone(), automatic).await {
        Ok(fetched) => (fetched, true),
        Err(e) if automatic => {
            log::warn!(target: "workspace_chat", "chat media: fetch failed: {e}");
            let mut failed = attachment;
            super::store::mark_failed(&mut failed, "fetch");
            (failed, false)
        }
        Err(e) => return Err(e),
    };
    let state = ChatMediaState::of(&fetched);
    let (writer, ws, done) = (store.clone(), workspace.to_string(), fetched.clone());
    crate::commands::await_blocking("chat_media.fetched", move || {
        writer
            .set_media(&ws, message_id, vec![done], state)
            .map_err(|e| e.to_string())
    })
    .await?;
    let owner = owner(team, workspace, message_id);
    if ok {
        host.chat_media_fetched(owner.clone(), MEDIA_SLOT, &fetched);
    }
    host.note_chat_media(owner, std::slice::from_ref(&fetched))
        .await;
    host.chat_media_changed(workspace, message_id);
    Ok(())
}

/// Chat message `message_id` with its media now, and the team that governs it.
async fn media_message(
    host: &dyn InboxHost,
    workspace: &str,
    message_id: i64,
) -> Result<(WorkspaceChatStore, WorkspaceChatMessage, LaunchTeam), String> {
    let store = host.chat_store().ok_or("workspace chat unavailable")?;
    let (reader, ws) = (store.clone(), workspace.to_string());
    let message = crate::commands::await_blocking("chat_media.message", move || {
        reader
            .media_message(&ws, message_id)
            .map_err(|e| e.to_string())
    })
    .await?
    .ok_or("message unavailable")?;
    if message.attachments.is_empty() {
        return Err("message has no media".into());
    }
    let team = message
        .media_team
        .clone()
        .ok_or("message has no media team")?;
    if host.media_config(&team).remote == Remote::Off {
        return Err("media is off in team config".into());
    }
    Ok((store, message, team))
}

/// `messages` of chat `workspace` as the app shows them: each image presented against
/// its message's team config, after the chat is indexed. Media Off reads as blocked,
/// with no hash of cached bytes.
pub(crate) async fn present(
    host: &dyn InboxHost,
    workspace: &str,
    messages: &mut [WorkspaceChatMessage],
) {
    if messages.iter().all(|m| m.attachments.is_empty()) {
        return;
    }
    host.index_chat_media(workspace).await;
    for message in messages {
        let Some(team) = &message.media_team else {
            continue;
        };
        host.present_media(team, &mut message.attachments);
        for a in &mut message.attachments {
            if a.state == "blocked" {
                a.sha256 = None;
            }
        }
    }
}

/// Load the image of chat message `message_id`, held for a tap or failed retryably.
pub(crate) async fn load(
    host: &Arc<dyn InboxHost>,
    workspace: &str,
    message_id: i64,
) -> Result<(), String> {
    let (store, message, team) = media_message(&**host, workspace, message_id).await?;
    if !matches!(
        message.media_state,
        Some(ChatMediaState::TapToLoad | ChatMediaState::Failed)
    ) {
        return Err("media cannot be loaded".into());
    }
    let attachment = &message.attachments[MEDIA_SLOT];
    if message.media_state == Some(ChatMediaState::Failed) && !attachment.retryable {
        return Err("media cannot be retried".into());
    }
    let attachment = message.attachments[MEDIA_SLOT].clone();
    finish_fetch(
        host,
        &store,
        &team,
        &message.workspace_id,
        message_id,
        attachment,
        false,
    )
    .await
}

/// The bytes of image `sha256` on chat message `message_id`: the message must carry it
/// as a cached attachment.
pub(crate) async fn read(
    host: &Arc<dyn InboxHost>,
    workspace: &str,
    message_id: i64,
    sha256: &str,
) -> Result<InboxMediaBytes, String> {
    if !crate::media::valid_sha(sha256) {
        return Err("invalid media hash".into());
    }
    let (_, mut message, team) = media_message(&**host, workspace, message_id).await?;
    // The chat is indexed before its media is presented or served, so a re-fetch of a
    // GIF sent from this machine is admitted.
    host.index_chat_media(&message.workspace_id).await;
    host.present_media(&team, &mut message.attachments);
    let attachment = crate::media::cached_attachment(&message.attachments, sha256)
        .ok_or("media unavailable")?
        .clone();
    let bytes = host.cached_media(&team, &attachment).await?;
    let (mime, _, _) =
        crate::media::inspect(&bytes).map_err(|_| "media unavailable".to_string())?;
    Ok(InboxMediaBytes { mime, bytes })
}

/// Add every media message of workspace chat `workspace` to the sha index, once.
pub(crate) async fn index_chat(
    state: &Arc<crate::media::MediaState>,
    store: &WorkspaceChatStore,
    workspace: &str,
) {
    if state.index.is_chat_indexed(workspace) {
        return;
    }
    let (state, store, ws) = (state.clone(), store.clone(), workspace.to_string());
    let indexed = crate::commands::await_blocking("media.index_chat", move || {
        for m in store.media_messages(&ws).map_err(|e| e.to_string())? {
            let Some(team) = &m.media_team else {
                continue;
            };
            state.note(
                &owner(team, &ws, m.message_id),
                m.created_at_ms,
                &m.attachments,
            );
        }
        state.index.mark_chat(&ws);
        Ok(())
    })
    .await;
    if let Err(e) = indexed {
        log::warn!(target: "workspace_chat", "chat media: could not index a chat: {e}");
    }
}

/// Mark the view ping of attachment `slot` on the chat message `owner` names settled,
/// in the media sidecar and the index.
pub(crate) async fn mark_onload_sent(host: &Arc<dyn InboxHost>, owner: Owner, slot: usize) {
    let (Some(store), Some(workspace)) = (host.chat_store(), owner.chat.clone()) else {
        return;
    };
    let message_id = owner.message_id;
    let marked = crate::commands::await_blocking("chat_media.onload", move || {
        store
            .mark_media_onload(&workspace, message_id, slot)
            .map_err(|e| e.to_string())
    })
    .await;
    match marked {
        Ok(Some(attachments)) => host.note_chat_media(owner, &attachments).await,
        Ok(None) => {}
        Err(e) => log::warn!("chat media: a view ping could not be marked: {e}"),
    }
}

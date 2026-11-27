// SPDX-License-Identifier: MIT
//! The two MCP tools agents call to post to and read from a
//! workspace chat.
//!
//! The verified connection supplies the caller session. The tool
//! resolves the session's bound workspace (via
//! `DashboardLaunchState::workspace_for_session`), rejects unbound sessions,
//! rejects a `workspace` override that doesn't match, rejects writes to an
//! archived workspace (reads `WorkspaceRegistryState`), then
//! append-or-reads through the engine.

use rmcp::model::ErrorData;
use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::agent_inbox::InboxHost;
use crate::commands::dashboard_launch::DashboardLaunchState;
use crate::commands::workspace_chat::{
    fire_fanout, ChatAppend, ChatMediaState, ChatStoreError, MessageKind, WorkspaceChatMessage,
    WorkspaceChatStore,
};
use crate::commands::workspace_registry::WorkspaceRegistryState;
use crate::weft::inbox::{MessageContentType, MessageOnClick};

/// `workspace_chat_send` params.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatSendParams {
    /// Omit to use the verified connection. A supplied id must name the same caller.
    #[serde(default)]
    pub session_id: String,
    /// The post. Optional when `media` is set; blank text without media is refused.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub content_type: Option<MessageContentType>,
    #[serde(default)]
    pub on_click: Option<MessageOnClick>,
    #[serde(default)]
    pub primary_file: Option<String>,
    /// One image, as for `send_message`: `{url|path, alt, provider?, providerId?}`.
    #[serde(default)]
    pub media: Option<crate::media::MediaInput>,
}

/// `workspace_chat_send` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatSendResult {
    pub status: &'static str, // always "sent"
    pub message_id: i64,
    pub workspace_id: String,
}

/// `workspace_chat_read` params.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatReadParams {
    /// Omit to use the verified connection. A supplied id must name the same caller.
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub workspace: Option<String>,
}

/// `workspace_chat_read` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatReadResult {
    pub workspace_id: String,
    pub messages: Vec<WorkspaceChatReadMessage>,
    pub head_id: i64,
    pub archived: bool,
    pub unread_remaining: u32,
}

/// A message as `workspace_chat_read` returns it: the chat row, with its image told as
/// `media` rather than as stored attachments.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatReadMessage {
    #[serde(flatten)]
    pub message: WorkspaceChatMessage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<WorkspaceChatMediaView>,
}

/// A chat message's image as an agent reads it: what it shows and where it stands on
/// this Mac. Never its URL or hash.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChatMediaView {
    pub alt: String,
    /// The GIF provider the image is attributed to, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::media::MediaProvider>,
    pub state: ChatMediaViewState,
}

/// Where a chat message's image stands, as a reader on this Mac sees it: the stored
/// [`ChatMediaState`], or `blocked` while the team's media is off. `blocked` is only ever
/// presented, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatMediaViewState {
    Pending,
    TapToLoad,
    Cached,
    Failed,
    /// The image comes from a URL and this Mac's team config has media off.
    Blocked,
}

impl From<ChatMediaState> for ChatMediaViewState {
    fn from(state: ChatMediaState) -> Self {
        match state {
            ChatMediaState::Pending => Self::Pending,
            ChatMediaState::TapToLoad => Self::TapToLoad,
            ChatMediaState::Cached => Self::Cached,
            ChatMediaState::Failed => Self::Failed,
        }
    }
}

impl From<WorkspaceChatMessage> for WorkspaceChatReadMessage {
    fn from(mut message: WorkspaceChatMessage) -> Self {
        let attachments = std::mem::take(&mut message.attachments);
        message.media_team = None;
        let state = message.media_state.take();
        let media = attachments.first().map(|a| WorkspaceChatMediaView {
            alt: a.alt.clone(),
            provider: a.attribution(),
            state: if a.state == "blocked" {
                ChatMediaViewState::Blocked
            } else {
                state.unwrap_or_else(|| ChatMediaState::of(a)).into()
            },
        });
        Self { message, media }
    }
}

/// `messages` as `workspace_chat_read` returns them, each image presented against this
/// Mac's team config first, so one from a URL reads `blocked` while media is off.
pub(crate) async fn read_view(
    host: &dyn InboxHost,
    workspace: &str,
    mut messages: Vec<WorkspaceChatMessage>,
) -> Vec<WorkspaceChatReadMessage> {
    crate::commands::workspace_chat::media::present(host, workspace, &mut messages).await;
    messages.into_iter().map(Into::into).collect()
}

fn resolve_bound_workspace(
    app: &AppHandle,
    session_id: &str,
) -> Result<(String, String), ErrorData> {
    let launch = app
        .try_state::<DashboardLaunchState>()
        .ok_or_else(|| ErrorData::internal_error("dashboard launch state unavailable", None))?;
    let handle = launch
        .handle_for_session(session_id)
        .or_else(|| launch.remote_handle_for_session(session_id))
        .ok_or_else(|| ErrorData::invalid_params("no session binding".to_string(), None))?;
    let bound = launch.workspace_for_session(session_id).ok_or_else(|| {
        ErrorData::invalid_params("session not bound to a workspace".to_string(), None)
    })?;
    Ok((handle, bound))
}

fn check_override(override_ws: Option<&str>, bound: &str) -> Result<(), ErrorData> {
    if let Some(w) = override_ws {
        let trimmed = w.trim();
        // Treat a whitespace-only / empty override as absent so the
        // agent's error message blames the real problem (blank parameter,
        // Jinja default rendering an unset variable) rather than falsely
        // claiming a mismatch against the bound workspace.
        if trimmed.is_empty() {
            return Ok(());
        }
        if trimmed != bound {
            return Err(ErrorData::invalid_params(
                "workspace override does not match session's bound workspace".to_string(),
                None,
            ));
        }
    }
    Ok(())
}

/// Who posts to a workspace chat, as the send resolved them.
pub(crate) struct ChatPoster {
    pub handle: String,
    pub from_name: String,
    pub workspace: String,
    /// The session runs on another machine: its media is held for a tap, and it can't
    /// send a file path.
    pub remote: bool,
}

/// A poster runs on another machine when its handle has a remote caller team, or when only
/// a remote session (not a local tab) answers to its session id.
pub(crate) fn poster_is_remote(
    has_remote_team: bool,
    has_local_handle: bool,
    has_remote_handle: bool,
) -> bool {
    has_remote_team || (!has_local_handle && has_remote_handle)
}

fn store_error(e: ChatStoreError) -> ErrorData {
    match e {
        ChatStoreError::EmptyText
        | ChatStoreError::TooLong
        | ChatStoreError::InvalidWorkspaceId(_)
        | ChatStoreError::LineTooLong => ErrorData::invalid_params(e.to_string(), None),
        other => ErrorData::internal_error(other.to_string(), None),
    }
}

/// Post `params` as `poster`. Text, media and the encoded line are checked before
/// `started` (the first-use anchor) runs or anything is appended, so a refused send
/// writes nothing. A post with
/// media is then indexed, registered once and, when admitted, fetched in the background.
pub(crate) async fn send_core(
    host: &std::sync::Arc<dyn InboxHost>,
    store: &WorkspaceChatStore,
    poster: ChatPoster,
    params: WorkspaceChatSendParams,
    started: impl std::future::Future<Output = ()>,
) -> Result<WorkspaceChatMessage, ErrorData> {
    if params.text.trim().is_empty() && params.media.is_none() {
        return Err(store_error(ChatStoreError::EmptyText));
    }
    let prepared = match &params.media {
        Some(input) => Some(
            crate::commands::workspace_chat::media::prepare(
                &**host,
                &poster.handle,
                poster.remote,
                input,
            )
            .await
            .map_err(|e| ErrorData::invalid_params(e, None))?,
        ),
        None => None,
    };
    let fetch = prepared.as_ref().is_some_and(|p| p.fetch);
    let at = ChatAppend {
        workspace_id: poster.workspace,
        from: poster.handle,
        from_name: poster.from_name,
        text: params.text,
        kind: MessageKind::Chat,
        content_type: params.content_type,
        on_click: params.on_click,
        primary_file: params.primary_file,
        media: prepared.map(|p| p.media),
    };
    store.check_line(&at).map_err(store_error)?;
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
    .map_err(|e| ErrorData::internal_error(format!("join: {e}"), None))?
    .map_err(store_error)?;
    crate::commands::workspace_chat::media::stored(host, &message, in_flight).await;
    Ok(message)
}

/// MCP: `workspace_chat_send`.
pub async fn workspace_chat_send(
    app: &AppHandle,
    params: WorkspaceChatSendParams,
) -> Result<WorkspaceChatSendResult, ErrorData> {
    // Admission order: unbound session → archived workspace
    // → override mismatch. Checking override before archived would mask the
    // real refusal ("workspace archived") behind "override does not match"
    // when the caller passes a stale workspace id.
    let (handle, bound_ws) = resolve_bound_workspace(app, &params.session_id)?;

    // The workspace registry is the single source of truth for archived state.
    let archived = app
        .state::<WorkspaceRegistryState>()
        .get(&bound_ws)
        .archived_at_ms
        .is_some();
    if archived {
        return Err(ErrorData::invalid_params(
            "workspace archived".to_string(),
            None,
        ));
    }

    check_override(params.workspace.as_deref(), &bound_ws)?;

    let store = app.state::<WorkspaceChatStore>();
    if !store.is_installed() {
        return Err(ErrorData::internal_error(
            "workspace chat engine not installed",
            None,
        ));
    }

    // Resolve the agent's display name through the launch registry (same
    // seam the role inbox uses). Fall back to the handle itself.
    let from_name = app
        .state::<DashboardLaunchState>()
        .display_name(&handle)
        .unwrap_or_else(|| handle.clone());

    let launch = app.state::<DashboardLaunchState>();
    let poster = ChatPoster {
        remote: poster_is_remote(
            crate::mcp::remote_authority::caller_team(&handle).is_some(),
            launch.handle_for_session(&params.session_id).is_some(),
            launch
                .remote_handle_for_session(&params.session_id)
                .is_some(),
        ),
        handle,
        from_name,
        workspace: bound_ws.clone(),
    };
    let host = crate::commands::agent_inbox::AppInboxHost::port(app.clone());
    let store = store.inner().clone();
    // First-use: emit `Chat started.` so an agent's post into a fresh
    // workspace opens the thread with the lifecycle anchor.
    let started = crate::commands::workspace_chat::ensure_chat_started(app, &bound_ws);
    let message = send_core(&host, &store, poster, params, started).await?;

    // Share the Tauri `#[command]` path's fan-out helper so a future tweak
    // to the fan-out contract (payload field, additional subscribers) does
    // not drift between the two surfaces. The helper also gates the
    // routine note on MessageKind so the agent is not woken for engine
    // lifecycle rows — this path writes a regular chat row.
    fire_fanout(
        app,
        &bound_ws,
        message.message_id,
        message.kind,
        &message.from,
    );
    // An agent's post in its chat answers the person.
    crate::commands::reply_owed::replies_owed().answered(&message.from);

    Ok(WorkspaceChatSendResult {
        status: "sent",
        message_id: message.message_id,
        workspace_id: bound_ws,
    })
}

/// MCP: `workspace_chat_read`.
pub async fn workspace_chat_read(
    app: &AppHandle,
    params: WorkspaceChatReadParams,
) -> Result<WorkspaceChatReadResult, ErrorData> {
    let (handle, bound_ws) = resolve_bound_workspace(app, &params.session_id)?;
    check_override(params.workspace.as_deref(), &bound_ws)?;

    let archived = app
        .state::<WorkspaceRegistryState>()
        .get(&bound_ws)
        .archived_at_ms
        .is_some();

    let store = app.state::<WorkspaceChatStore>();
    if !store.is_installed() {
        return Err(ErrorData::internal_error(
            "workspace chat engine not installed",
            None,
        ));
    }
    let app_clone = app.clone();
    let bound_clone = bound_ws.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let store = app_clone.state::<WorkspaceChatStore>();
        store.read_for_session(
            &bound_clone,
            &handle,
            &params.session_id,
            params.since,
            params.limit,
        )
    })
    .await
    .map_err(|e| ErrorData::internal_error(format!("join: {e}"), None))?
    .map_err(|e| match e {
        crate::commands::workspace_chat::ChatStoreError::InvalidWorkspaceId(_) => {
            ErrorData::invalid_params(e.to_string(), None)
        }
        other => ErrorData::internal_error(other.to_string(), None),
    })?;

    let _ = app.emit("codesense:workspace-chat-updated", ());
    let host = crate::commands::agent_inbox::AppInboxHost::port(app.clone());
    let messages = read_view(&*host, &out.page.workspace_id, out.page.messages).await;
    Ok(WorkspaceChatReadResult {
        workspace_id: out.page.workspace_id,
        messages,
        head_id: out.page.head_id,
        unread_remaining: out.unread_remaining,
        archived,
    })
}

#[cfg(test)]
mod media_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_override_rejects_mismatch() {
        let err = check_override(Some("story:other"), "story:self").unwrap_err();
        assert!(
            err.to_string()
                .contains("workspace override does not match"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn a_poster_is_remote_by_its_team_or_by_only_a_remote_handle() {
        // A remote caller team, with or without a local tab.
        assert!(poster_is_remote(true, false, false));
        assert!(poster_is_remote(true, true, false), "the remote team wins over a local handle");
        assert!(poster_is_remote(true, true, true));
        // A local tab is local, even when a remote session shares its id.
        assert!(!poster_is_remote(false, true, false));
        assert!(!poster_is_remote(false, true, true));
        // Only a remote session answers to it.
        assert!(poster_is_remote(false, false, true));
        // Neither.
        assert!(!poster_is_remote(false, false, false));
    }

    #[test]
    fn check_override_accepts_matching_or_absent() {
        assert!(check_override(Some("story:self"), "story:self").is_ok());
        assert!(check_override(None, "story:self").is_ok());
    }

    // The admission order is enforced by the implementation code order in
    // `workspace_chat_send`: unbound session (`resolve_bound_workspace`) →
    // archived check (reads `WorkspaceRegistryState`) → override check
    // (`check_override`). The admission-order contract is a reading-level
    // guarantee — an integration test would need a live Tauri app with
    // every state registered, which the project's test harness does not
    // support for this layer. The unit tests below cover the individual
    // predicates; the order itself has no seam or e2e test yet.

    #[test]
    fn tool_signatures_round_trip_through_json() {
        let send = serde_json::json!({
            "sessionId": "sess-1",
            "text": "hi",
        });
        let send: WorkspaceChatSendParams = serde_json::from_value(send).unwrap();
        assert_eq!(send.session_id, "sess-1");
        assert_eq!(send.text, "hi");
        assert!(send.workspace.is_none());

        let read = serde_json::json!({
            "sessionId": "sess-1",
            "since": 7,
        });
        let read: WorkspaceChatReadParams = serde_json::from_value(read).unwrap();
        assert_eq!(read.session_id, "sess-1");
        assert_eq!(read.since, Some(7));
    }
}

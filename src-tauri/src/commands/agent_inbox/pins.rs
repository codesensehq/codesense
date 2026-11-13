// SPDX-License-Identifier: MIT
//! An agent thread's pin list through the inbox: the person pins from a page or the
//! overlay into any thread of a team; an agent pins only into its own thread, the saved
//! agent and story its session was launched with.

use serde::Serialize;

use super::{
    caller_handle, session_store, team_inbox, with_store, Caller, InboxHost, InboxLocation,
    InboxTeam, HUMAN,
};
use crate::commands::dashboard_launch::LaunchTeam;
use crate::weft::inbox;
use crate::weft::pins::{self, Pin, PinOutcome, PinPreview, ThreadKey};

/// Tells the viewer a thread's pin list changed, with [`PinsChanged`] as its payload.
/// Mirrored in `src/tauri/events.ts`.
pub(crate) const AGENT_PINS_CHANGED_EVENT: &str = "agent-pins-changed";

/// Which pin list changed: the team whose store holds it, and its thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinsChanged {
    pub org: String,
    pub team: String,
    pub agent_id: String,
    pub story_id: String,
}

impl PinsChanged {
    pub(crate) fn new(team: &LaunchTeam, thread: &ThreadKey) -> Self {
        Self {
            org: team.org.clone(),
            team: team.team.clone(),
            agent_id: thread.agent_id.clone(),
            story_id: thread.story_id.clone(),
        }
    }
}

/// A thread's live pins in one team's store, in list order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PinList {
    pub org: String,
    pub team: String,
    pub agent_id: String,
    pub story_id: String,
    pub pins: Vec<Pin>,
}

/// The outcome of a pins read or write.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum PinResult {
    /// The list after the call; `outcome` is set for a pin or unpin.
    Pins {
        #[serde(flatten)]
        list: PinList,
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<PinOutcome>,
    },
    /// An input that cannot be stored; `message` says which, in one sentence.
    Invalid { message: String },
}

impl PinResult {
    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
        }
    }
}

/// What one call does to a thread's list.
#[derive(Debug, Clone)]
pub(crate) enum PinOp {
    Read,
    Pin {
        message_id: i64,
        position: Option<u32>,
        preview: Option<PinPreview>,
    },
    Unpin {
        message_id: i64,
    },
    Reorder {
        message_ids: Vec<i64>,
    },
}

/// Run `op` on `thread`'s list in the store at `own`, as `by`. A session (`party`) pins
/// only mail it sent, received or is the reply target of, or a role message, as it
/// reacts; the person pins anything the team's inbox shows.
async fn pins_in(
    host: &dyn InboxHost,
    own: InboxLocation,
    thread: ThreadKey,
    op: PinOp,
    by: String,
    party: bool,
) -> Result<PinResult, String> {
    let InboxLocation { team, path } = own;
    // A reorder reports no outcome: it either applied or was refused.
    let reorder = matches!(op, PinOp::Reorder { .. });
    let stored = {
        let thread = thread.clone();
        with_store("pins", path, move |store| {
            if let (true, PinOp::Pin { message_id, .. }) = (party, &op) {
                let held = inbox::inbox_get(store, *message_id)?.is_some_and(|m| {
                    m.role.is_some()
                        || m.from == by
                        || m.to == by
                        || m.reply_to.as_deref() == Some(by.as_str())
                });
                if !held {
                    return Ok(Err(format!("no message {message_id}")));
                }
            }
            let outcome = match op {
                PinOp::Read => None,
                PinOp::Pin {
                    message_id,
                    position,
                    preview,
                } => Some(pins::pin_add(
                    store,
                    &thread,
                    message_id,
                    &by,
                    position,
                    preview.as_ref(),
                )?),
                PinOp::Unpin { message_id } => Some(pins::pin_remove(store, &thread, message_id)?),
                PinOp::Reorder { message_ids } => {
                    pins::pins_reorder(store, &thread, &message_ids)?;
                    Some(PinOutcome::Pinned)
                }
            };
            Ok(Ok((outcome, pins::pins_list(store, &thread)?)))
        })
        .await?
    };
    let (outcome, list) = match stored {
        Ok(Ok(found)) => found,
        Ok(Err(message)) | Err(message) => return Ok(PinResult::Invalid { message }),
    };
    if outcome.is_some_and(|o| o != PinOutcome::Unchanged) {
        host.pins_changed(&team, &thread);
    }
    Ok(PinResult::Pins {
        list: PinList {
            org: team.org,
            team: team.team,
            agent_id: thread.agent_id,
            story_id: thread.story_id,
            pins: list,
        },
        outcome: outcome.filter(|_| !reorder),
    })
}

/// The person reads or changes the pin list of the thread `agent_id` + `story_id` in
/// `team`'s store.
pub(crate) async fn pins_from_human(
    host: &dyn InboxHost,
    team: &LaunchTeam,
    agent_id: &str,
    story_id: Option<&str>,
    op: PinOp,
) -> Result<PinResult, String> {
    let thread = match ThreadKey::new(agent_id, story_id) {
        Ok(thread) => thread,
        Err(error) => return Ok(PinResult::invalid(error.to_string())),
    };
    let own = team_inbox(host, team.clone()).await?;
    pins_in(host, own, thread, op, HUMAN.to_string(), false).await
}

/// An agent pins (or, `remove`, unpins) message `message_id` in its own thread: the saved
/// agent and story its session was launched with, in the store of the team it was
/// launched in. There is no thread argument, so it can name no other thread. A `preview`
/// on a message already pinned replaces that pin's preview.
pub(crate) async fn pin_request<'a>(
    host: &dyn InboxHost,
    session_id: impl Into<Caller<'a>>,
    message_id: i64,
    position: Option<u32>,
    preview: Option<PinPreview>,
    remove: bool,
) -> Result<PinResult, String> {
    let sessions = host.sessions().await?;
    let handle = match caller_handle(&sessions, session_id) {
        Ok(Some(handle)) => handle,
        Ok(None) => return Ok(PinResult::invalid("pinning needs a running session")),
        Err(message) => return Ok(PinResult::Invalid { message }),
    };
    let Some((agent, story)) = host.launch_thread(&handle).await else {
        return Ok(PinResult::invalid(
            "only a session launched from a saved Agent has a pin thread",
        ));
    };
    let thread = match ThreadKey::new(&agent, story.as_deref()) {
        Ok(thread) => thread,
        Err(error) => return Ok(PinResult::invalid(error.to_string())),
    };
    let own = session_store(host, &handle).await?;
    let op = if remove {
        PinOp::Unpin { message_id }
    } else {
        PinOp::Pin {
            message_id,
            position,
            preview,
        }
    };
    pins_in(host, own, thread, op, handle, true).await
}

/// The person's pins verbs, one Tauri command: `op` is `read`, `pin`, `unpin` or
/// `reorder`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_pins(
    app: tauri::AppHandle,
    team: InboxTeam,
    agent_id: String,
    story_id: Option<String>,
    op: String,
    message_id: Option<i64>,
    position: Option<u32>,
    message_ids: Option<Vec<i64>>,
    preview: Option<PinPreview>,
) -> Result<PinResult, String> {
    let need_id = || message_id.ok_or_else(|| format!("{op} needs a messageId"));
    let op = match op.as_str() {
        "read" => PinOp::Read,
        "pin" => PinOp::Pin {
            message_id: need_id()?,
            position,
            preview,
        },
        "unpin" => PinOp::Unpin {
            message_id: need_id()?,
        },
        "reorder" => PinOp::Reorder {
            message_ids: message_ids.ok_or("reorder needs messageIds")?,
        },
        other => return Err(format!("unknown pins op {other}")),
    };
    pins_from_human(
        &super::AppInboxHost { app },
        &team.into(),
        &agent_id,
        story_id.as_deref(),
        op,
    )
    .await
}

/// Prepare the `pins` live view of the thread `agent_id` + `story_id` in `team` for a
/// page's subscription; returns its view key.
#[tauri::command]
pub async fn agent_pins_prepare_view(
    app: tauri::AppHandle,
    team: InboxTeam,
    agent_id: String,
    story_id: Option<String>,
) -> Result<String, String> {
    let thread = ThreadKey::new(&agent_id, story_id.as_deref()).map_err(|e| e.to_string())?;
    crate::live_hub::pins::prepare(&app, team.into(), thread).await
}

#[cfg(test)]
#[path = "pins_tests.rs"]
mod tests;

// SPDX-License-Identifier: MIT
//! An agent thread's pin list through the inbox: the person pins from a page or the
//! overlay into any thread of a team; an agent pins only into its own thread, the saved
//! agent and story its session was launched with.

use serde::Serialize;

use super::{
    caller_handle, is_party, session_store, team_inbox, with_store, Caller, InboxHost,
    InboxLocation, InboxTeam, HUMAN,
};
use crate::commands::dashboard_launch::LaunchTeam;
use crate::weft::inbox;
use crate::weft::pins::{self, Pin, PinOutcome, PinPreview, ThreadKey};
use crate::weft::sqlite::WvWriteError;

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

/// Tells the viewer about every thread that pins any of `message_ids` in `team`'s
/// store at `path`: archiving, withdrawing or restoring a message changes which of its
/// pins are live. A store that cannot be read leaves the lists as they are.
pub(crate) async fn refresh_pin_threads(
    host: &dyn InboxHost,
    team: &LaunchTeam,
    path: std::path::PathBuf,
    message_ids: Vec<i64>,
) {
    let found = with_store("pin_threads_for", path, move |store| {
        pins::pin_threads_for(store, &message_ids)
    })
    .await;
    if let Ok(Ok(threads)) = found {
        for thread in &threads {
            host.pins_changed(team, thread);
        }
    }
}

/// A pin as a refusal names it: its message id, and its short name when it has one.
fn pin_label(pin: &Pin) -> String {
    match pin.preview.as_ref().and_then(|p| p.short_name.clone()) {
        Some(name) => format!("{} ({name})", pin.message_id),
        None => format!("{}", pin.message_id),
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
    /// Bring an unpinned pin back as it was: the Undo of an unpin.
    Restore {
        message_id: i64,
    },
    /// Pin `message_id` in place of the shown pin `replaces`, in one step: the person
    /// pins at the cap by choosing which pin to replace.
    Replace {
        message_id: i64,
        replaces: i64,
    },
    /// The Undo of a replace, in one step: `replacing` goes and `message_id` comes back as
    /// it was, in its place.
    RestoreReplacing {
        message_id: i64,
        replacing: i64,
    },
    Reorder {
        message_ids: Vec<i64>,
    },
}

/// A refusal that names the thread's pins now, so whoever asked can see what changed.
fn refused_with_list(
    store: &crate::weft::store::WeftStore,
    thread: &ThreadKey,
    reason: &str,
) -> Result<String, WvWriteError> {
    let held = pins::pins_list(store, thread)?
        .iter()
        .map(pin_label)
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("{reason}. Pinned now: {held}"))
}

impl PinOp {
    /// The message a write puts into the list, which a session may name only if it is party
    /// to it: what a pin, restore or replace pins (or brings back).
    fn pinned_message(&self) -> Option<i64> {
        match self {
            PinOp::Pin { message_id, .. }
            | PinOp::Restore { message_id }
            | PinOp::Replace { message_id, .. }
            | PinOp::RestoreReplacing { message_id, .. } => Some(*message_id),
            PinOp::Read | PinOp::Unpin { .. } | PinOp::Reorder { .. } => None,
        }
    }
}

/// Run `op` on `thread`'s list in the store at `own`, as `by`. A session pins only mail
/// its thread holds: mail one of `parties` (the addresses of the thread it is a seat of,
/// its predecessors' included) sent, received or is the reply target of, or a role
/// message, as it reacts. The person (no `parties`) pins anything the team's inbox shows.
async fn pins_in(
    host: &dyn InboxHost,
    own: InboxLocation,
    thread: ThreadKey,
    op: PinOp,
    by: String,
    parties: Option<Vec<String>>,
) -> Result<PinResult, String> {
    let InboxLocation { team, path } = own;
    let stored = {
        let thread = thread.clone();
        with_store("pins", path, move |store| {
            if let (Some(parties), Some(message_id)) = (parties, op.pinned_message()) {
                let held = inbox::inbox_get(store, message_id)?
                    .is_some_and(|m| parties.iter().any(|who| is_party(&m, who)));
                if !held {
                    return Ok(Err(format!("no message {message_id}")));
                }
            }
            // What the call did, if it reports an outcome, and whether the list changed: a
            // reorder reports none, and it either applied or was refused.
            let (outcome, changed) = match op {
                PinOp::Read => (None, false),
                PinOp::Pin {
                    message_id,
                    position,
                    preview,
                } => {
                    match pins::pin_add(store, &thread, message_id, &by, position, preview.as_ref())
                    {
                        Ok(done) => (Some(done), done != PinOutcome::Unchanged),
                        // An agent reads its pins only through this reply, so a refusal names
                        // them: the cap says what to unpin.
                        Err(WvWriteError::Invalid(reason)) => {
                            let held = pins::pins_list(store, &thread)?
                                .iter()
                                .map(pin_label)
                                .collect::<Vec<_>>()
                                .join(", ");
                            return Ok(Err(format!("{}. Pinned now: {held}", reason.0)));
                        }
                        Err(other) => return Err(other),
                    }
                }
                PinOp::Unpin { message_id } => {
                    let done = pins::pin_remove(store, &thread, message_id)?;
                    (Some(done), done != PinOutcome::Unchanged)
                }
                PinOp::Restore { message_id } => {
                    match pins::pin_restore(store, &thread, message_id) {
                        Ok(done) => (Some(done), done != PinOutcome::Unchanged),
                        Err(WvWriteError::Invalid(reason)) => {
                            return Ok(Err(refused_with_list(store, &thread, &reason.0)?));
                        }
                        Err(other) => return Err(other),
                    }
                }
                PinOp::Replace {
                    message_id,
                    replaces,
                } => match pins::pin_replace(store, &thread, message_id, replaces, &by) {
                    Ok(done) => (Some(done), true),
                    Err(WvWriteError::Invalid(reason)) => {
                        return Ok(Err(refused_with_list(store, &thread, &reason.0)?));
                    }
                    Err(other) => return Err(other),
                },
                PinOp::RestoreReplacing {
                    message_id,
                    replacing,
                } => match pins::pin_restore_replacing(store, &thread, message_id, replacing) {
                    Ok(done) => (Some(done), done != PinOutcome::Unchanged),
                    Err(WvWriteError::Invalid(reason)) => {
                        return Ok(Err(refused_with_list(store, &thread, &reason.0)?));
                    }
                    Err(other) => return Err(other),
                },
                PinOp::Reorder { message_ids } => {
                    let moved = pins::pins_reorder(store, &thread, &message_ids)?;
                    (None, moved)
                }
            };
            Ok(Ok((outcome, changed, pins::pins_list(store, &thread)?)))
        })
        .await?
    };
    let (outcome, changed, list) = match stored {
        Ok(Ok(found)) => found,
        Ok(Err(message)) | Err(message) => return Ok(PinResult::Invalid { message }),
    };
    if changed {
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
        outcome,
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
    pins_in(host, own, thread, op, HUMAN.to_string(), None).await
}

/// A pins call from an HTML message rendered live (a message frame), as its `sender`. It
/// reads any thread of its team, as a page does, but a write lands only in its sender's own
/// thread (the saved agent and story the sending session was launched with), so a message
/// an agent posts can't change another agent's pins. A sender with no saved-agent thread
/// writes none.
pub(crate) async fn pins_from_frame(
    host: &dyn InboxHost,
    team: &LaunchTeam,
    agent_id: &str,
    story_id: Option<&str>,
    op: PinOp,
    sender: &str,
) -> Result<PinResult, String> {
    if matches!(op, PinOp::Read) {
        return pins_from_human(host, team, agent_id, story_id, op).await;
    }
    let Some((agent, story)) = host.launch_thread(sender).await else {
        return Ok(PinResult::invalid(
            "only a message from a session launched from a saved Agent can change pins",
        ));
    };
    let asked = ThreadKey::new(agent_id, story_id);
    let own = ThreadKey::new(&agent, story.as_deref());
    match (asked, own) {
        (Ok(asked), Ok(own)) if asked == own => {
            pins_from_human(host, team, agent_id, story_id, op).await
        }
        (Err(error), _) => Ok(PinResult::invalid(error.to_string())),
        _ => Ok(PinResult::invalid(
            "a message changes pins only in its sender's thread",
        )),
    }
}

/// What an agent's pin call does to its message: pin it, unpin it, or bring its unpinned
/// pin back as it was. `true` is an unpin, `false` a pin (the `remove` flag).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PinChange {
    Pin,
    Unpin,
    Restore,
}

impl From<bool> for PinChange {
    fn from(remove: bool) -> Self {
        if remove {
            PinChange::Unpin
        } else {
            PinChange::Pin
        }
    }
}

/// An agent pins (or unpins, or restores) message `message_id` in its own thread: the saved
/// agent and story its session was launched with, in the store of the team it was
/// launched in. There is no thread argument, so it can name no other thread. A `preview`
/// on a message already pinned replaces that pin's preview.
pub(crate) async fn pin_request<'a>(
    host: &dyn InboxHost,
    session_id: impl Into<Caller<'a>>,
    message_id: i64,
    position: Option<u32>,
    preview: Option<PinPreview>,
    change: impl Into<PinChange>,
) -> Result<PinResult, String> {
    let sessions = InboxHost::sessions(host).await?;
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
    let op = match change.into() {
        PinChange::Unpin => PinOp::Unpin { message_id },
        PinChange::Restore => PinOp::Restore { message_id },
        PinChange::Pin => PinOp::Pin {
            message_id,
            position,
            preview,
        },
    };
    // The thread's mail, as its read shows it to this seat: its own and its predecessors'
    // (by handle or tab session id), never a concurrent seat's.
    let mut parties = crate::commands::agent_read_model::thread_addresses(
        host,
        &sessions,
        &thread,
        Some(&handle),
    )
    .await?
    .addresses;
    if !parties.contains(&handle) {
        parties.push(handle.clone());
    }
    pins_in(host, own, thread, op, handle, Some(parties)).await
}

/// The person's pins verbs, one Tauri command: `op` is `read`, `pin`, `unpin`,
/// `restore` (the Undo of an unpin, or of a replace with `replacing`), `replace` (pin in
/// place of `replaces`) or `reorder`.
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
    replaces: Option<i64>,
    replacing: Option<i64>,
    sender: Option<String>,
) -> Result<PinResult, String> {
    let need_id = || message_id.ok_or_else(|| format!("{op} needs a messageId"));
    let op = match &*op {
        "read" => PinOp::Read,
        "pin" => PinOp::Pin {
            message_id: need_id()?,
            position,
            preview,
        },
        "unpin" => PinOp::Unpin {
            message_id: need_id()?,
        },
        "restore" => match replacing {
            Some(replacing) => PinOp::RestoreReplacing {
                message_id: need_id()?,
                replacing,
            },
            None => PinOp::Restore {
                message_id: need_id()?,
            },
        },
        "replace" => PinOp::Replace {
            message_id: need_id()?,
            replaces: replaces.ok_or("replace needs replaces")?,
        },
        "reorder" => PinOp::Reorder {
            message_ids: message_ids.ok_or("reorder needs messageIds")?,
        },
        other => return Err(format!("unknown pins op {other}")),
    };
    let host = super::AppInboxHost { app };
    // `sender`: the caller is a message frame, whose writes stay in its sender's thread.
    match sender {
        Some(sender) => {
            let team: LaunchTeam = team.into();
            pins_from_frame(&host, &team, &agent_id, story_id.as_deref(), op, &sender).await
        }
        None => {
            let team: LaunchTeam = team.into();
            pins_from_human(&host, &team, &agent_id, story_id.as_deref(), op).await
        }
    }
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

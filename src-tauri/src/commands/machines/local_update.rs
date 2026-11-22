// SPDX-License-Identifier: MIT
//! SW-AGR-19 PR-5: updating This Mac's terminal server. The app's own server
//! runs on this Mac, so the update is the confirmed, epoch-checked stop the
//! activity update already uses (the person confirmed ending exactly the
//! sessions they were shown), then this build's server is launched and the
//! app reattaches; its tabs are recorded first and reopened after (PR-4).

use serde::Serialize;
use tauri::Manager;

use super::restore::{self, RestoreSummary, UpdateEnd};
use super::terminal_server_info::{local_info, ServerRelation, TerminalServerInfo};
use super::LOCAL_MACHINE_ID;
use crate::commands::pty_backend::RestartError;
use crate::shared::machine_wording;
use crate::terminal::session_server::{LocalActivityUpgrade, SessionServerState, SIDECAR_BIN};

/// This Mac's server when it is not this app's build: what the confirmation
/// binds to (`expected`) and what it says (`terminal_server`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerUpdate {
    pub expected: LocalActivityUpgrade,
    pub terminal_server: TerminalServerInfo,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdateResult {
    /// The sessions that ended with the old server.
    pub sessions: u32,
    pub restored: Option<RestoreSummary>,
}

/// Whether This Mac's server is one to offer the update for: older than this
/// app, or another CodeSense build's (offered per machine only, never in
/// "Update all" — see [`ServerRelation::OtherBuild`]).
pub fn offers_update(relation: ServerRelation) -> bool {
    matches!(relation, ServerRelation::Older | ServerRelation::OtherBuild)
}

/// Whether `identity` (a fresh read of the running server) is the server the
/// app is connected to, whose build `info` describes.
pub fn same_server(
    client_server_id: &str,
    client_epoch: &str,
    identity: &LocalActivityUpgrade,
) -> bool {
    identity.server_id == client_server_id && identity.epoch == client_epoch
}

/// "<machine>'s terminal server <state>", worded for `os`.
pub(super) fn server_sentence(os: &str, state: &str) -> String {
    format!(
        "{}'s terminal server {state}",
        machine_wording::machine_noun(os)
    )
}

/// The local server is not available, worded for `os`.
fn server_not_available_for(os: &str) -> String {
    server_sentence(os, "is not available")
}

fn server_not_available() -> String {
    server_not_available_for(machine_wording::RUNNING_OS)
}

/// The local server is not connected, worded for `os`.
fn server_not_connected_for(os: &str) -> String {
    server_sentence(os, "is not connected")
}

fn server_not_connected() -> String {
    server_not_connected_for(machine_wording::RUNNING_OS)
}

/// The local server is not running, worded for `os`.
fn server_not_running_for(os: &str) -> String {
    server_sentence(os, "is not running")
}

fn server_not_running() -> String {
    server_not_running_for(machine_wording::RUNNING_OS)
}

/// The local server changed before the update was offered, worded for `os`.
fn server_changed_for(os: &str) -> String {
    server_sentence(os, "changed; try again")
}

fn server_changed() -> String {
    server_changed_for(machine_wording::RUNNING_OS)
}

/// The server or its sessions changed since review, worded for `os`.
fn sessions_changed_for(os: &str) -> String {
    server_sentence(
        os,
        "or its sessions changed since you reviewed them; nothing was stopped. Review the update again.",
    )
}

fn sessions_changed() -> String {
    sessions_changed_for(machine_wording::RUNNING_OS)
}

/// The local server is already this app's build, worded for `os`.
fn already_this_build_for(os: &str) -> String {
    server_sentence(os, "is already this app's build.")
}

fn already_this_build() -> String {
    already_this_build_for(machine_wording::RUNNING_OS)
}

/// Another update of the local server is running, worded for `os`.
fn already_updating_for(os: &str) -> String {
    server_sentence(os, "is being updated already; wait for it to finish.")
}

fn already_updating() -> String {
    already_updating_for(machine_wording::RUNNING_OS)
}

/// This Mac's connected server and how it compares with this app's build.
fn connected_info(
    app: &tauri::AppHandle,
) -> Result<
    (
        std::sync::Arc<crate::terminal::session_server::SessionServerClient>,
        TerminalServerInfo,
    ),
    String,
> {
    let state = app
        .try_state::<SessionServerState>()
        .ok_or_else(server_not_available)?;
    let client = state.connected().ok_or_else(server_not_connected)?;
    let shipped = crate::commands::deps::resolve_sidecar_source(SIDECAR_BIN).ok();
    let info = local_info(
        client.announced_version(),
        client.server_pid(),
        client.build_stamp(),
        shipped.as_deref(),
    );
    Ok((client, info))
}

/// SW-AGR-19: This Mac's update, when its server is not this app's build
/// (`None`: it is). An error when its server cannot be read.
#[tauri::command]
pub async fn local_terminal_server_update(
    app: tauri::AppHandle,
) -> Result<Option<LocalServerUpdate>, String> {
    crate::commands::await_blocking("local_terminal_server_update", move || {
        let (client, info) = connected_info(&app)?;
        if !offers_update(info.relation) {
            return Ok(None);
        }
        let identity = app
            .state::<SessionServerState>()
            .local_server_identity()?
            .ok_or_else(server_not_running)?;
        // The confirmation binds to the server whose build it shows.
        if !same_server(client.server_id(), client.epoch(), &identity) {
            return Err(server_changed());
        }
        Ok(Some(LocalServerUpdate {
            expected: identity,
            terminal_server: info,
        }))
    })
    .await
}

/// Why This Mac's update did not finish: whether the old server stopped, and
/// whether it was refused because the server or its sessions changed since
/// the person reviewed them (nothing stopped; review again).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUpdateError {
    pub old_stopped: bool,
    pub changed: bool,
    pub message: String,
}

impl LocalUpdateError {
    fn refused(message: impl Into<String>) -> Self {
        Self {
            old_stopped: false,
            changed: false,
            message: message.into(),
        }
    }
    fn changed() -> Self {
        Self {
            old_stopped: false,
            changed: true,
            message: sessions_changed(),
        }
    }
}

/// Still the confirmed server and sessions, and still one to update.
fn check(app: &tauri::AppHandle, expected: &LocalActivityUpgrade) -> Result<(), LocalUpdateError> {
    let (client, info) = connected_info(app).map_err(LocalUpdateError::refused)?;
    if !offers_update(info.relation) {
        return Err(LocalUpdateError::refused(already_this_build()));
    }
    if !same_server(client.server_id(), client.epoch(), expected) {
        return Err(LocalUpdateError::changed());
    }
    let current = app
        .state::<SessionServerState>()
        .local_server_identity()
        .map_err(LocalUpdateError::refused)?;
    if current.as_ref() != Some(expected) {
        return Err(LocalUpdateError::changed());
    }
    Ok(())
}

/// One update of This Mac at a time, in every window: held from the check
/// until its tabs are reopened.
static UPDATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct Updating;

impl Updating {
    fn claim() -> Option<Self> {
        UPDATING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .ok()
            .map(|_| Self)
    }
}

impl Drop for Updating {
    fn drop(&mut self) {
        UPDATING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// SW-AGR-19: replace This Mac's terminal server with this build's, ending
/// exactly the confirmed `expected` sessions (a changed server or session set
/// is refused before anything stops), then reopen its tabs.
#[tauri::command]
pub async fn update_local_terminal_server(
    app: tauri::AppHandle,
    expected: LocalActivityUpgrade,
) -> Result<LocalUpdateResult, LocalUpdateError> {
    // SW-AGR-19 PR-8: one update at a time — never beside an Update all run.
    super::update_all::refuse_while_running().map_err(LocalUpdateError::refused)?;
    update_local_now(app, expected).await
}

/// This Mac's update itself (the Update all run's own step).
pub(crate) async fn update_local_now(
    app: tauri::AppHandle,
    expected: LocalActivityUpgrade,
) -> Result<LocalUpdateResult, LocalUpdateError> {
    let Some(_updating) = Updating::claim() else {
        return Err(LocalUpdateError::refused(already_updating()));
    };
    // Still the confirmed server, its sessions, and still one to update.
    let check_app = app.clone();
    let check_expected = expected.clone();
    crate::commands::await_blocking("update_local_terminal_server check", move || {
        Ok(check(&check_app, &check_expected))
    })
    .await
    .map_err(LocalUpdateError::refused)??;
    let home = super::codesense_home_of(&app).await;
    let recorded = match &home {
        Some(home) => restore::capture(&app, home, LOCAL_MACHINE_ID).await,
        None => None,
    };
    let sessions = u32::try_from(expected.session_ids.len()).unwrap_or(u32::MAX);
    let replace_app = app.clone();
    let replaced = crate::commands::await_blocking("update_local_terminal_server", move || {
        Ok(crate::commands::pty_backend::replace_local_terminal_server(
            &replace_app,
            &expected,
        ))
    })
    .await
    .unwrap_or_else(|message| Err(RestartError::still_running(message)));
    let end = match &replaced {
        Ok(()) => UpdateEnd::Replaced,
        Err(error) if error.old_stopped => UpdateEnd::OldStopped,
        Err(_) => UpdateEnd::OldRunning,
    };
    let restored = match &home {
        Some(home) => {
            let label = machine_wording::machine_noun(machine_wording::RUNNING_OS);
            restore::finish(&app, home, LOCAL_MACHINE_ID, label, recorded, end).await
        }
        None => None,
    };
    match &replaced {
        Ok(()) => log::info!(
            target: "machines",
            "{} terminal server updated; {sessions} sessions ended",
            machine_wording::machine_noun(machine_wording::RUNNING_OS)
        ),
        Err(error) => log::warn!(
            target: "machines",
            "{} terminal server update failed (old stopped: {}): {}",
            machine_wording::machine_noun(machine_wording::RUNNING_OS),
            error.old_stopped,
            error.message
        ),
    }
    replaced
        .map(|()| LocalUpdateResult { sessions, restored })
        .map_err(|error| LocalUpdateError {
            old_stopped: error.old_stopped,
            changed: false,
            message: error.message,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agr19_this_mac_offers_the_update_for_an_older_or_other_build_only() {
        assert!(offers_update(ServerRelation::Older));
        assert!(offers_update(ServerRelation::OtherBuild));
        assert!(!offers_update(ServerRelation::Same));
        assert!(!offers_update(ServerRelation::Newer));
    }

    #[test]
    fn agr19_this_mac_update_binds_to_the_connected_server() {
        let identity = LocalActivityUpgrade {
            server_id: "srv".into(),
            epoch: "e1".into(),
            pid: 7,
            session_ids: vec!["a".into()],
        };
        assert!(same_server("srv", "e1", &identity));
        assert!(!same_server("srv", "e2", &identity), "a restarted server");
        assert!(!same_server("other", "e1", &identity), "another server");
    }

    #[test]
    fn agr19_this_mac_updates_one_at_a_time() {
        let first = Updating::claim().expect("free");
        assert!(
            Updating::claim().is_none(),
            "a second update waits its turn"
        );
        drop(first);
        assert!(Updating::claim().is_some(), "free again once it ends");
    }

    #[test]
    fn agr19_a_changed_review_is_its_own_refusal() {
        let wire = serde_json::to_value(LocalUpdateError::changed()).unwrap();
        assert_eq!(wire["changed"], true);
        assert_eq!(wire["oldStopped"], false);
    }

    #[test]
    fn machine_wording_follows_the_os() {
        let cases: [(fn(&str) -> String, &str, &str); 7] = [
            (
                server_not_available_for,
                "This Mac's terminal server is not available",
                "This computer's terminal server is not available",
            ),
            (
                server_not_connected_for,
                "This Mac's terminal server is not connected",
                "This computer's terminal server is not connected",
            ),
            (
                server_not_running_for,
                "This Mac's terminal server is not running",
                "This computer's terminal server is not running",
            ),
            (
                server_changed_for,
                "This Mac's terminal server changed; try again",
                "This computer's terminal server changed; try again",
            ),
            (
                sessions_changed_for,
                "This Mac's terminal server or its sessions changed since you reviewed them; nothing was stopped. Review the update again.",
                "This computer's terminal server or its sessions changed since you reviewed them; nothing was stopped. Review the update again.",
            ),
            (
                already_this_build_for,
                "This Mac's terminal server is already this app's build.",
                "This computer's terminal server is already this app's build.",
            ),
            (
                already_updating_for,
                "This Mac's terminal server is being updated already; wait for it to finish.",
                "This computer's terminal server is being updated already; wait for it to finish.",
            ),
        ];
        for (message_for, mac, other) in cases {
            assert_eq!(message_for("macos"), mac);
            assert_eq!(message_for("linux"), other);
        }
    }
}

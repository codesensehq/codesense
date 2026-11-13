// SPDX-License-Identifier: MIT
//! The `pins` topic: one view per team and agent thread, prepared when a page subscribes
//! and re-read when the thread's list changes or a message of the team is archived,
//! withdrawn or restored (a pin drops out or comes back with its message).

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::Manager;

use crate::commands::agent_inbox::pins::{pins_from_human, PinOp, PinResult};
use crate::commands::agent_inbox::AppInboxHost;
use crate::commands::dashboard_launch::LaunchTeam;
use crate::weft::pins::{Pin, ThreadKey};

pub const TOPIC: &str = "pins";

/// Every prepared pins view, by view key.
#[derive(Default)]
pub struct PinViews(Mutex<BTreeMap<String, (LaunchTeam, ThreadKey)>>);

/// The view key of `thread`'s list in `team`'s store.
pub fn view_key(team: &LaunchTeam, thread: &ThreadKey) -> String {
    format!(
        "pins:{}/{}:{}:{}",
        team.org, team.team, thread.agent_id, thread.story_id
    )
}

/// The view's rows, scoped to the view's key, ordered by their place in the list.
pub fn rows(
    key: &str,
    team: &LaunchTeam,
    thread: &ThreadKey,
    pins: &[Pin],
) -> Vec<(Option<String>, Value)> {
    pins.iter()
        .map(|pin| {
            (
                Some(key.to_owned()),
                json!({
                    "id": pin.message_id.to_string(),
                    "messageId": pin.message_id,
                    "position": pin.position,
                    "order": pin.position,
                    "pinnedBy": pin.pinned_by,
                    "pinnedAtMs": pin.pinned_at_ms,
                    "preview": pin.preview,
                    "previewAtMs": pin.preview_at_ms,
                    "org": team.org,
                    "team": team.team,
                    "agentId": thread.agent_id,
                    "storyId": thread.story_id,
                }),
            )
        })
        .collect()
}

async fn read(
    app: &tauri::AppHandle,
    team: &LaunchTeam,
    thread: &ThreadKey,
) -> Result<Vec<Pin>, String> {
    let host = AppInboxHost { app: app.clone() };
    let story = (!String::is_empty(&thread.story_id)).then_some(String::as_str(&thread.story_id));
    match pins_from_human(&host, team, &thread.agent_id, story, PinOp::Read).await? {
        PinResult::Pins { list, .. } => Ok(list.pins),
        PinResult::Invalid { message } => Err(message),
    }
}

async fn refresh_view(
    app: &tauri::AppHandle,
    key: &str,
    team: &LaunchTeam,
    thread: &ThreadKey,
) -> Result<(), String> {
    let pins = read(app, team, thread).await?;
    super::replace_view(app, TOPIC, key, rows(key, team, thread, &pins))
}

/// Prepare `thread`'s view in `team` for a subscriber and return its key.
pub async fn prepare(
    app: &tauri::AppHandle,
    team: LaunchTeam,
    thread: ThreadKey,
) -> Result<String, String> {
    let key = view_key(&team, &thread);
    refresh_view(app, &key, &team, &thread).await?;
    app.state::<PinViews>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key.clone(), (team, thread));
    Ok(key)
}

/// Re-read the prepared views of `team`: only `thread`'s when given, else all of them.
pub fn refresh(app: &tauri::AppHandle, team: LaunchTeam, thread: Option<ThreadKey>) {
    let Some(views) = app.try_state::<PinViews>() else {
        return;
    };
    let due: Vec<_> = views
        .0
        .lock()
        .map(|views| {
            views
                .iter()
                .filter(|(_, (t, k))| *t == team && thread.as_ref().is_none_or(|want| want == k))
                .map(|(key, (t, k))| (key.clone(), t.clone(), k.clone()))
                .collect()
        })
        .unwrap_or_default();
    if Vec::is_empty(&due) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for (key, team, thread) in due {
            if let Err(error) = refresh_view(&app, &key, &team, &thread).await {
                log::warn!("pins projection: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_is_keyed_by_team_and_thread_and_rows_carry_their_place() {
        let team = LaunchTeam {
            org: "acme".into(),
            team: "core".into(),
        };
        let thread = ThreadKey::new("acme/core/dev", Some("DEMO-1")).unwrap();
        let key = view_key(&team, &thread);
        assert_eq!(key, "pins:acme/core:acme/core/dev:DEMO-1");
        let pin = |message_id, position| Pin {
            message_id,
            position,
            pinned_by: "human".into(),
            pinned_at_ms: 1,
            preview: None,
            preview_at_ms: None,
        };
        let mut previewed = pin(3, 1);
        previewed.preview = Some(crate::weft::pins::PinPreview {
            value: Some("48 passed".into()),
            ..Default::default()
        });
        previewed.preview_at_ms = Some(2);
        let rows = rows(&key, &team, &thread, &[pin(7, 0), previewed]);
        assert_eq!(rows[0].1["preview"], Value::Null);
        assert_eq!(rows[1].1["preview"]["value"], "48 passed");
        assert_eq!(rows[1].1["previewAtMs"], 2);
        assert!(rows
            .iter()
            .all(|(scope, _)| scope.as_deref() == Some(key.as_str())));
        assert_eq!(rows[0].1["id"], "7");
        assert_eq!(rows[1].1["order"], 1);
        assert_eq!(rows[1].1["storyId"], "DEMO-1");
        let mut topics = super::super::projection::TopicRegistry::default();
        topics.replace_view(TOPIC, &key, rows).unwrap();
        let snapshot = topics.snapshot(TOPIC, &key).unwrap();
        let ids: Vec<_> = snapshot
            .snapshot
            .iter()
            .map(|r| r["messageId"].clone())
            .collect();
        assert_eq!(ids, vec![json!(7), json!(3)]);
        assert!(topics
            .snapshot(TOPIC, "pins:acme/other:acme/core/dev:DEMO-1")
            .unwrap()
            .snapshot
            .is_empty());
    }
}

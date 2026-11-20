// SPDX-License-Identifier: MIT
//! Indexing a team's stored messages, and the one-time purge of provider media that an
//! earlier version saved to the disk cache. Cache files are named only by sha256, so
//! the purge finds them through the messages that reference them.
use super::{index::Owner, Attachment, MediaProvider, MediaState};
use crate::commands::dashboard_launch::LaunchTeam;
use crate::weft::{inbox, WeftStore};
use std::path::{Path, PathBuf};

/// Written to the app data dir once every provider file is deleted and every
/// attachment backfilled. Until then the purge runs at each start.
pub const MARKER: &str = "inbox-media-provider-purge-v1";

fn owner(team: &LaunchTeam, message_id: i64) -> Owner {
    Owner {
        org: team.org.clone(),
        team: team.team.clone(),
        message_id,
    }
}

fn rows(path: &Path) -> Result<(WeftStore, Vec<(i64, i64, String)>), String> {
    let store = WeftStore::open(path.to_path_buf()).map_err(|e| e.to_string())?;
    let rows = inbox::inbox_attachments_raw(&store).map_err(|e| e.to_string())?;
    Ok((store, rows))
}

fn attachments(json: &str) -> Vec<Attachment> {
    serde_json::from_str(json).unwrap_or_default()
}

/// Index one stored message; a sha this makes memory-only loses its disk copy.
fn note_row(state: &MediaState, team: &LaunchTeam, (id, at, json): &(i64, i64, String)) {
    state.note(&owner(team, *id), *at, &attachments(json));
}

/// Add every message of `team`'s store at `path` to the sha index, then mark the
/// team indexed.
pub(crate) fn index_store(
    state: &MediaState,
    team: &LaunchTeam,
    path: &Path,
) -> Result<(), String> {
    let (_, rows) = rows(path)?;
    for row in &rows {
        note_row(state, team, row);
    }
    state.index.mark_team(&team.org, &team.team);
    Ok(())
}

/// `json` with `mediaProvider` added to each attachment that has a sha, no
/// `mediaProvider` and a provider source host. Every other byte is kept: keys keep
/// their order and an existing value (`none` included) is never overwritten. `None`
/// when nothing changes or the JSON doesn't parse.
pub(crate) fn backfill(json: &str) -> Option<String> {
    let mut attachments: Vec<indexmap::IndexMap<String, serde_json::Value>> =
        serde_json::from_str(json).ok()?;
    let mut changed = false;
    for a in &mut attachments {
        if a.contains_key("mediaProvider") || !a.get("sha256").is_some_and(|v| v.is_string()) {
            continue;
        }
        let host = a.get("sourceHost").and_then(|v| v.as_str());
        if let Some(host) = host.filter(|h| super::is_provider(None, Some(*h))) {
            let provider = MediaProvider::of_host(host);
            a.insert("mediaProvider".into(), serde_json::json!(provider));
            changed = true;
        }
    }
    changed
        .then(|| serde_json::to_string(&attachments).ok())
        .flatten()
}

/// What a purge run did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Purged {
    /// The marker was there: nothing to do.
    AlreadyDone,
    /// Files deleted and attachments backfilled; the marker is written.
    Done { deleted: usize, backfilled: usize },
}

/// The one-time purge, over every synced team's store, once the sha index holds them all:
/// 1. read each store's messages;
/// 2. collect every sha with a provider reference in the index;
/// 3. delete those files from the disk cache, shared ones too;
/// 4. only once every deletion succeeded, backfill `mediaProvider` on old provider
///    attachments, then write the marker.
///
/// Any failure returns before the marker, so the next start runs it again. Deleting
/// is idempotent.
pub(crate) fn run(
    state: &MediaState,
    stores: &[(LaunchTeam, PathBuf)],
    data_dir: &Path,
) -> Result<Purged, String> {
    let marker = data_dir.join(MARKER);
    if marker.exists() {
        return Ok(Purged::AlreadyDone);
    }
    let mut scanned = Vec::new();
    for (team, path) in stores {
        // A team the index lacks could hide a provider sha: no marker until it has it.
        if !state.index.is_team_indexed(&team.org, &team.team) {
            return Err(format!("{}/{} is not indexed yet", team.org, team.team));
        }
        let (store, rows) = rows(path)?;
        scanned.push((store, rows));
    }
    let mut deleted = 0;
    for sha in state.index.provider_shas() {
        let existed = state.dir().join(&sha).exists();
        state
            .remove_file(&sha)
            .map_err(|e| format!("purge could not delete a provider file: {e}"))?;
        deleted += usize::from(existed);
    }
    let mut backfilled = 0;
    for (store, rows) in scanned {
        for (id, _, json) in rows {
            let Some(filled) = backfill(&json) else {
                continue;
            };
            if inbox::inbox_replace_attachments_raw(&store, id, &json, &filled)
                .map_err(|e| e.to_string())?
            {
                backfilled += 1;
            }
        }
    }
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    std::fs::write(&marker, b"").map_err(|e| e.to_string())?;
    Ok(Purged::Done {
        deleted,
        backfilled,
    })
}

#[cfg(test)]
mod tests;

// SPDX-License-Identifier: MIT
//! `charge_session_story`: count a session's usage to a story from a moment on.
//!
//! A kept seat that starts another story, or a lead that moves on to its next one, is charged to
//! that story, so its cost splits between the stories it worked (see `session_usage::charge`).
//!
//! What a charge moves is cost attribution only: no content, credentials or files. A caller could
//! move cost off its own story, or onto another lead's, so a seat may charge only its own session
//! or a session its own launch chain started, in the same org and team. The chain is followed by
//! the launcher tab each record keeps; handles are reused, so an older record that names only a
//! handle is followed to the session that held it then, never a later holder. A charge cannot
//! start before the session's first usage or its record, nor more than a minute ahead; a session
//! has at most 100 charges, and a charge is replaced only by the seat that made it. Every charge
//! keeps the caller's handle and verified tab, and `session_read` lists a session's charges, so a
//! misuse is visible and a later charge reverses it.

use std::path::{Path, PathBuf};

use rmcp::schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::session_usage::charge::Charge;
use crate::session_usage::record::SessionRecord;
use crate::session_usage::UsageStore;

/// How far ahead of this Mac's clock a charge may start.
pub(crate) const FUTURE_SLACK_MS: i64 = 60_000;
/// The most charges one session may have: each splits its usage into one more row.
pub(crate) const MAX_CHARGES: usize = 100;
/// The most launches a chain is followed back.
pub(crate) const MAX_HOPS: usize = 8;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChargeSessionStoryParams {
    /// The story the session's usage counts to from `fromMs` on (a story id of the session's own
    /// team, e.g. `DEMO-5`).
    pub story: String,
    /// The session to charge, by its CodeSense session id (its `$CODESENSE_TAB_SESSION_ID`).
    /// Omitted: your own session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// When the charge starts, epoch milliseconds. Omitted: now. At most 60 s ahead, and not
    /// before the session's first usage or its record.
    #[serde(default)]
    pub from_ms: Option<i64>,
}

/// Who is charging, as the connection verified it.
pub(crate) struct Caller {
    /// The tab this connection runs as.
    pub session: String,
    /// Its handle, from the launch registry or the remote authority. Kept with the charge; never
    /// what authorizes it.
    pub handle: Option<String>,
    /// Its org and team, for a caller whose own record is not on this Mac (a remote tab, from its
    /// authority).
    pub team: Option<(String, String)>,
}

/// Charge the session `params` names (else the caller's own) to `params.story`. `story_in_team`
/// finds a story's file in an org's team; `normalize` reads a recorded `launched_by` as a handle.
pub(crate) fn charge(
    store: &UsageStore,
    caller: &Caller,
    params: &ChargeSessionStoryParams,
    now: i64,
    story_in_team: &dyn Fn(&str, &str, &str) -> Option<PathBuf>,
    normalize: &dyn Fn(&str) -> String,
) -> Result<Value, String> {
    let story = params.story.trim();
    if str::is_empty(story) {
        return Err("invalid: story must be a story id".into());
    }
    let named = params
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !str::is_empty(id))
        .unwrap_or(std::string::String::as_str(&caller.session));
    let target = store.read_session_record(named)?.ok_or_else(|| {
        format!("invalid: session {named} has no session record here; only a session CodeSense launched can be charged")
    })?;
    // The caller's own record, never another session whose native id happens to match its tab.
    let caller_record = store.read_session_record(&caller.session)?.filter(|r| r.session_id == caller.session);
    let caller_team = match &caller_record {
        Some(record) => record.org.clone().zip(record.team.clone()),
        None => caller.team.clone(),
    };
    let Some((org, team)) = target.org.clone().zip(target.team.clone()) else {
        return Err(format!("invalid: session {} has no org and team, so it has no story to charge", target.session_id));
    };
    if caller_team.as_ref() != Some(&(org.clone(), team.clone())) {
        return Err(format!(
            "invalid: session {} is another team's; a seat charges only sessions of its own org and team",
            target.session_id
        ));
    }
    authorize(store, caller, &target, normalize)?;
    if story_in_team(&org, &team, story).is_none() {
        return Err(format!("invalid: {story} is not a story of {org}/{team}"));
    }
    let from_ms = params.from_ms.unwrap_or(now);
    if from_ms > now + FUTURE_SLACK_MS {
        return Err("invalid: fromMs is more than 60 s ahead of now".into());
    }
    let start = match store.first_usage_ms(&target.session_id)? {
        Some(first) => first.min(target.recorded_at_ms),
        None => target.recorded_at_ms,
    };
    if from_ms < start {
        return Err(format!(
            "invalid: fromMs {from_ms} is before session {} started ({start}, its first usage or record)",
            target.session_id
        ));
    }
    let existing = store.charges_for(&target.session_id)?;
    match Iterator::find(&mut existing.iter(), |c| c.from_ms == from_ms) {
        // A charge at the same moment is replaced only by whoever made it, so no seat can rewrite
        // another's charge and its record of who made it.
        Some(earlier) if earlier.charged_by_session != caller.session => {
            return Err(format!(
                "invalid: session {}'s charge at {from_ms} was made by {}; charge at another moment instead",
                target.session_id,
                earlier.charged_by.as_deref().unwrap_or(std::string::String::as_str(&earlier.charged_by_session))
            ));
        }
        Some(_) => {}
        None if existing.len() >= MAX_CHARGES => {
            return Err(format!(
                "invalid: session {} already has {MAX_CHARGES} charges, the most a session may have",
                target.session_id
            ));
        }
        None => {}
    }
    let charge = Charge {
        story_id: story.to_owned(),
        from_ms,
        org: Some(org),
        team: Some(team),
        charged_by: caller.handle.clone(),
        charged_by_session: caller.session.clone(),
        charged_at_ms: now,
    };
    store.charge_story(&target.session_id, &charge)?;
    let charges: Vec<Value> = store
        .charges_for(&target.session_id)?
        .iter()
        .map(|c| json!({"story": c.story_id, "fromMs": c.from_ms, "chargedBy": c.charged_by}))
        .collect();
    Ok(json!({
        "sessionId": target.session_id,
        "story": story,
        "fromMs": from_ms,
        "chargedBy": caller.handle,
        "charges": charges,
    }))
}

/// Whether `caller` may charge `target`: it is the target itself, or the target's launch chain
/// runs through it. A record that names its launcher's tab is followed by that tab. An older record
/// that names only its launcher's handle is followed to the session that held the handle when
/// the record was written, so a handle reused later never counts. A remote caller is matched only
/// by its own tab.
fn authorize(
    store: &UsageStore,
    caller: &Caller,
    target: &SessionRecord,
    normalize: &dyn Fn(&str) -> String,
) -> Result<(), String> {
    if target.session_id == caller.session {
        return Ok(());
    }
    let mut current = target.clone();
    for _ in 0..MAX_HOPS {
        // The recorded launcher tab is the caller's, even when its record is not here (a remote tab).
        if current.launched_by_session.as_deref() == Some(std::string::String::as_str(&caller.session)) {
            return Ok(());
        }
        let Some(launcher) = launcher_of(store, &current, normalize)? else {
            break;
        };
        if launcher.session_id == caller.session {
            return Ok(());
        }
        current = launcher;
    }
    Err(format!(
        "invalid: you may charge only your own session or a session your launch chain started (at most {MAX_HOPS} launches back); {} is neither",
        target.session_id
    ))
}

/// The record of the session that launched `record`, when this Mac has it: the launcher tab it
/// recorded, else (an older record) the tab its `launched_by` names, else the session that held
/// the handle its `launched_by` names when `record` was written. A launcher recorded after
/// `record` is no launcher of it.
fn launcher_of(
    store: &UsageStore,
    record: &SessionRecord,
    normalize: &dyn Fn(&str) -> String,
) -> Result<Option<SessionRecord>, String> {
    let launched_before = |tab: &str| -> Result<Option<SessionRecord>, String> {
        Ok(store
            .read_session_record(tab)?
            .filter(|r| r.session_id == tab && r.recorded_at_ms <= record.recorded_at_ms))
    };
    if let Some(tab) = record.launched_by_session.as_deref().filter(|t| !str::is_empty(t)) {
        return launched_before(tab);
    }
    let Some(launcher) = record.launched_by.as_deref().map(str::trim).filter(|l| !str::is_empty(l)) else {
        return Ok(None);
    };
    // A launcher recorded by its tab is that tab, or nobody when the tab was recorded later.
    if store.read_session_record(launcher)?.is_some_and(|r| r.session_id == launcher) {
        return launched_before(launcher);
    }
    store.handle_holder(&normalize(launcher), record.recorded_at_ms)
}

/// The story file of `id` in `org`'s `team`, through the index the usage report reads stories by.
pub(crate) fn story_in_team(home: &Path, org: &str, team: &str, id: &str) -> Option<PathBuf> {
    crate::context_repo::org_enumeration::enumerate_all_org_roots(home)
        .into_iter()
        .filter(|root| crate::context_repo::org_slug_from_org_root(&root.to_string_lossy()) == Some(org))
        .find_map(|root| {
            crate::session_usage::story::story_file_in_org(&root, id).filter(|path| path.starts_with(root.join(team)))
        })
}

#[cfg(test)]
mod tests;

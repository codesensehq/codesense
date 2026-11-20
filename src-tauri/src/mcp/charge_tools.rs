// SPDX-License-Identifier: MIT
//! `charge_session_story`: count a session's usage to a story from a moment on.
//!
//! A kept seat that starts another story, or a lead that moves on to its next one, is charged to
//! that story, so its cost splits between the stories it worked (see `session_usage::charge`).
//!
//! What a charge moves is cost attribution only: no content, credentials or files. A caller could
//! move cost off its own story, or onto another lead's, so a seat may charge only its own session
//! or a session its own launch chain started, in the same org and team. Handles are reused, so each
//! hop of the chain follows the session that held the handle when the next one launched, never a
//! later holder. A charge cannot start before the session's first usage or its record, nor more than
//! a minute ahead. Every charge keeps the caller's handle and verified tab, and `session_read`
//! lists a session's charges, so a misuse is visible and a later charge reverses it.

use std::path::{Path, PathBuf};

use rmcp::schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::session_usage::charge::Charge;
use crate::session_usage::record::SessionRecord;
use crate::session_usage::UsageStore;

/// How far ahead of this Mac's clock a charge may start.
pub(crate) const FUTURE_SLACK_MS: i64 = 60_000;
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
    /// Its handle, from the launch registry or the remote authority.
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
    if story.is_empty() {
        return Err("invalid: story must be a story id".into());
    }
    let named = params
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(caller.session.as_str());
    let target = store.read_session_record(named)?.ok_or_else(|| {
        format!("invalid: session {named} has no session record here; only a session CodeSense launched can be charged")
    })?;
    let caller_record = store.read_session_record(&caller.session)?;
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
    authorize(store, caller, caller_record.as_ref(), &target, normalize)?;
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
/// runs through it. Each hop is the session that held the recorded launcher's handle when the
/// session it launched was recorded, so a handle reused later never counts.
fn authorize(
    store: &UsageStore,
    caller: &Caller,
    caller_record: Option<&SessionRecord>,
    target: &SessionRecord,
    normalize: &dyn Fn(&str) -> String,
) -> Result<(), String> {
    let caller_tab = caller_record.map_or(caller.session.as_str(), |r| r.session_id.as_str());
    if target.session_id == caller_tab {
        return Ok(());
    }
    let mut current = target.clone();
    for _ in 0..MAX_HOPS {
        let Some(launcher) = current.launched_by.as_deref().map(str::trim).filter(|l| !l.is_empty()) else {
            break;
        };
        // A launcher recorded by its tab is that tab; one recorded by its handle is the session
        // that held the handle then.
        let by_tab = store
            .read_session_record(launcher)?
            .filter(|r| r.session_id == launcher && r.recorded_at_ms <= current.recorded_at_ms);
        let handle = normalize(launcher);
        let holder = match by_tab {
            Some(record) => Some(record),
            None => store.handle_holder(&handle, current.recorded_at_ms)?,
        };
        match holder {
            Some(holder) if holder.session_id == caller_tab => return Ok(()),
            Some(holder) => current = holder,
            None => {
                // No session here held the handle then (a remote tab's launches): the verified
                // handle names the launcher, for a caller whose own record is not here either.
                if caller_record.is_none() && caller.handle.as_deref() == Some(handle.as_str()) {
                    return Ok(());
                }
                break;
            }
        }
    }
    Err(format!(
        "invalid: you may charge only your own session or a session your launch chain started (at most {MAX_HOPS} launches back); {} is neither",
        target.session_id
    ))
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

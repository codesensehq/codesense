// SPDX-License-Identifier: MIT
//! One agent's session record for a page (`sessionRecord({handle})`): its model, tokens, cost,
//! duration, the files its commits changed and its story. Every figure comes from the reads the
//! `session_usage` and `story_changes` tools already answer (the same store, filter and story
//! read), so a page and those tools agree to the cent and the file.
use super::{
    event::Tokens, record::SessionRecord, session_read, story_changes, Filter, StoryResolver,
    UsageReport, UsageStore,
};
use crate::context_repo::caller_scope::CallerScope;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

/// The most commit pages one record reads (500 commits each).
const COMMIT_PAGES: usize = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    /// The agent's launch handle, as `sessions()` names it.
    pub handle: String,
}

/// A commit as the record needs it: its sha, its files and the sessions that made it.
pub(crate) type CommitFacts = (String, Vec<String>, Vec<String>);

/// What the usage store holds for one handle.
pub(crate) struct UsageHalf {
    pub session_id: String,
    /// Every id the session's usage and commits are filed under.
    pub ids: Vec<String>,
    pub record: Option<SessionRecord>,
    pub report: UsageReport,
    /// The handoff chain before this session: the earlier sessions of the same saved agent and
    /// story, oldest first. Their usage and commits count toward the record.
    pub earlier: Vec<UsageHalf>,
}

/// The session a launch handle names: the latest durable record, else the latest attribution.
fn session_for_handle(store: &UsageStore, handle: &str) -> Result<Option<String>, String> {
    for sql in [
        "SELECT session_id FROM session_record WHERE handle = ?1 ORDER BY recorded_at_ms DESC LIMIT 1",
        "SELECT session_id FROM session_attribution WHERE handle = ?1 ORDER BY attributed_at_ms DESC LIMIT 1",
    ] {
        let found: Option<String> = store
            .conn
            .query_row(sql, [handle], |row| row.get(0))
            .optional()
            .map_err(super::db_err)?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// The earlier sessions of the same saved agent and story as `record`, oldest first. A session
/// with no agent or no story has no chain.
fn earlier_sessions(store: &UsageStore, record: &SessionRecord) -> Result<Vec<String>, String> {
    let (Some(agent), Some(story)) = (record.agent.as_ref(), record.story_id.as_ref()) else {
        return Ok(vec![]);
    };
    let key = agent.split('@').next().unwrap_or(agent);
    let mut stmt = rusqlite::Connection::prepare(
        &store.conn,
        "SELECT session_id FROM session_record
         WHERE story_id = ?1 AND (agent = ?2 OR substr(agent, 1, length(?2) + 1) = ?2 || '@')
           AND recorded_at_ms < ?3 AND session_id != ?4
         ORDER BY recorded_at_ms, session_id",
    )
    .map_err(super::db_err)?;
    let rows = stmt
        .query_map(
            rusqlite::params![story, key, record.recorded_at_ms, record.session_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(super::db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(super::db_err)
}

/// One session's usage half, without its chain.
fn half_of(
    home: &Path,
    store: &UsageStore,
    session_id: String,
    launch_stories: &HashMap<String, String>,
    scope: &CallerScope,
) -> Result<UsageHalf, String> {
    let ids = UsageStore::event_session_ids(store, &session_id)?;
    let record = UsageStore::read_session_record(store, &session_id)?;
    let mut stories = StoryResolver::for_home(home, launch_stories.clone()).with_scope(scope.clone());
    let filter = Filter {
        session_id: Some(session_id.clone()),
        ..Default::default()
    };
    let report = UsageStore::report_with(store, &filter, &mut stories)?;
    Ok(UsageHalf {
        session_id,
        ids,
        record,
        report,
        earlier: vec![],
    })
}

/// The usage half: the session, its record, the report `session_usage` gives for it and the
/// halves of the sessions before it in its handoff chain.
pub(crate) fn usage_half(
    home: &Path,
    handle: &str,
    launch_stories: HashMap<String, String>,
    scope: &CallerScope,
) -> Result<UsageHalf, String> {
    let handle = handle.trim();
    if str::is_empty(handle) {
        return Err("invalid: handle must not be empty".into());
    }
    let store = UsageStore::open(&home.join("usage.sqlite"))?;
    let input = Option::ok_or_else(session_for_handle(&store, handle)?, || {
        format!("unknown session: no record for handle {handle}")
    })?;
    let session_id = session_read::resolve_session(&store, None, &input)?.session_id;
    let mut half = half_of(home, &store, session_id, &launch_stories, scope)?;
    if let Some(record) = half.record.as_ref() {
        for earlier in earlier_sessions(&store, record)? {
            half.earlier.push(half_of(home, &store, earlier, &launch_stories, scope)?);
        }
    }
    Ok(half)
}

/// The commits of a story, as many pages as it takes, with why they could not be read.
async fn story_commits(
    home: &Path,
    story: &str,
    scope: &CallerScope,
) -> Result<(Vec<CommitFacts>, Option<String>), String> {
    let mut commits = Vec::new();
    let mut cursor = None;
    for _ in 0..COMMIT_PAGES {
        let params = story_changes::Params {
            include: Vec::new(),
            story_id: story.to_owned(),
            limit: Some(500),
            cursor: Option::take(&mut cursor),
            only: Some(vec![story_changes::Only::Commits]),
        };
        let page = story_changes::read(home, &params, scope).await?;
        if let Some(reason) = BTreeMap::get(&page.unavailable, "commits") {
            return Ok((commits, Some(reason.clone())));
        }
        for commit in page.commits {
            commits.push((commit.sha, commit.files, commit.session_ids));
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok((commits, None)),
        }
    }
    Ok((commits, Some("more commits than one record reads".into())))
}

/// The span of one session's usage, or its recorded wall time when there is one.
fn duration_of(half: &UsageHalf) -> Option<i64> {
    if let Some(timing) = half.record.as_ref().and_then(|r| r.timing.as_ref()) {
        return Some(timing.wall_ms);
    }
    let first = half.report.sessions.iter().map(|s| s.first_at_ms).min();
    let last = half.report.sessions.iter().map(|s| s.last_at_ms).max();
    first.zip(last).map(|(first, last)| last - first)
}

/// The record: usage figures summed over `half` and the sessions before it in its handoff chain,
/// files from the story's `commits` made by any of them. `commits` is `None` with its reason when
/// the story has none to read.
pub(crate) fn assemble(
    handle: &str,
    half: &UsageHalf,
    commits: Option<&[CommitFacts]>,
    files_reason: Option<&str>,
) -> Value {
    let report = &half.report;
    let record = half.record.as_ref();
    let chain: Vec<&UsageHalf> = half.earlier.iter().chain(std::iter::once(half)).collect();
    let sessions: Vec<&crate::session_usage::SessionUsage> =
        chain.iter().flat_map(|h| h.report.sessions.iter()).collect();
    let story = report.sessions.iter().find_map(|s| s.story.clone());
    let mut models = BTreeSet::new();
    for session in &sessions {
        models.extend(session.models.iter().cloned());
    }
    let first = sessions.iter().map(|s| s.first_at_ms).min();
    let last = sessions.iter().map(|s| s.last_at_ms).max();
    let mut tokens = report.totals.tokens;
    let mut cost_usd = report.totals.cost_usd;
    let mut unpriced = report.totals.unpriced_sessions;
    let mut duration = duration_of(half);
    for earlier in &half.earlier {
        Tokens::add(&mut tokens, &earlier.report.totals.tokens);
        cost_usd += earlier.report.totals.cost_usd;
        unpriced += earlier.report.totals.unpriced_sessions;
        duration = match (duration, duration_of(earlier)) {
            (Some(a), Some(b)) => Some(a + b),
            (a, b) => a.or(b),
        };
    }
    let cost = if unpriced > 0 || sessions.first().is_none() {
        None
    } else {
        Some(cost_usd)
    };
    let mut unavailable = BTreeMap::new();
    if sessions.first().is_none() {
        unavailable.insert("usage", "no usage has been reported for this session yet".to_owned());
    } else if cost.is_none() {
        unavailable.insert("cost", "a model of this session has no rate".to_owned());
    }
    if story.is_none() {
        unavailable.insert("story", "no story is linked to this session".to_owned());
    }
    let files: Vec<Value> = match commits {
        Some(commits) => {
            let mut by_path: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
            for (sha, paths, commit_sessions) in commits {
                if !commit_sessions.iter().any(|id| chain.iter().any(|h| h.ids.contains(id))) {
                    continue;
                }
                for path in paths {
                    let path: &str = path;
                    let sha: &str = sha;
                    by_path.entry(path).or_default().push(sha);
                }
            }
            by_path
                .into_iter()
                .map(|(path, shas)| json!({"path": path, "commits": shas}))
                .collect()
        }
        None => {
            let why = files_reason.unwrap_or("no story is linked to this session");
            unavailable.insert("files", why.to_owned());
            Vec::new()
        }
    };
    // Commits that were only partly read still say so.
    if let (Some(_), Some(why)) = (commits, files_reason) {
        unavailable.insert("files", why.to_owned());
    }
    json!({
        "handle": handle,
        "sessionId": half.session_id,
        "chain": chain.iter().map(|h| &h.session_id).collect::<Vec<_>>(),
        "cli": record.and_then(|r| r.cli.clone()).map(Value::from).or_else(|| report.sessions.first().map(|s| json!(s.cli))),
        "model": record.and_then(|r| r.model.clone()).or_else(|| models.iter().next().cloned()),
        "models": models,
        "tokens": tokens,
        "costUsd": cost,
        "durationMs": duration,
        "firstAtMs": first,
        "lastAtMs": last,
        "story": story,
        "runId": record.and_then(|r| r.run_id.clone()).or_else(|| report.sessions.iter().find_map(|s| s.run_id.clone())),
        "branch": record.and_then(|r| r.branch.clone()),
        "worktree": record.and_then(|r| r.worktree.clone()),
        "files": files,
        "unavailable": unavailable,
    })
}

/// The record for the agent launched under `handle`.
pub async fn read(
    home: &Path,
    params: &Params,
    launch_stories: HashMap<String, String>,
    scope: &CallerScope,
) -> Result<Value, String> {
    let (owned_home, handle, owned_scope) = (home.to_owned(), params.handle.clone(), scope.clone());
    let half = crate::commands::await_blocking("session_record", move || {
        usage_half(&owned_home, &handle, launch_stories, &owned_scope)
    })
    .await?;
    let story = half.report.sessions.iter().find_map(|s| s.story.as_ref().map(|s| s.id.clone()));
    let (commits, reason) = match story {
        Some(story) => {
            let (commits, reason) = story_commits(home, &story, scope).await?;
            (Some(commits), reason)
        }
        None => (None, None),
    };
    Ok(assemble(params.handle.trim(), &half, commits.as_deref(), reason.as_deref()))
}

/// The current store and context: the page's and the MCP tools' shared paths.
pub async fn current(
    params: &Params,
    launch_stories: HashMap<String, String>,
    scope: &CallerScope,
) -> Result<Value, String> {
    let home = crate::commands::paths::codesense_home_dir().ok_or("no CodeSense home directory")?;
    read(&home, params, launch_stories, scope).await
}

#[cfg(test)]
mod tests;

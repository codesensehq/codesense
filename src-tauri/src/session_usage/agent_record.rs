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
    /// What the session's rows that have a price add up to.
    pub priced_usd: f64,
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
    let priced_usd = super::cost_rollup::CostRollup::priced(&UsageStore::session_cost(store, &session_id)?);
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
        priced_usd,
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

/// One page of a story's commits, as the record reads it.
struct CommitPage {
    commits: Vec<CommitFacts>,
    /// Why the story's commits could not be read, when they could not.
    unavailable: Option<String>,
    next: Option<String>,
}

/// One page of the story's commits from `story_changes`, from `cursor`.
async fn read_page(
    home: &Path,
    story: &str,
    cursor: Option<String>,
    scope: &CallerScope,
) -> Result<CommitPage, String> {
    let params = story_changes::Params {
        include: Vec::new(),
        story_id: story.to_owned(),
        limit: Some(500),
        cursor,
        only: Some(vec![story_changes::Only::Commits]),
    };
    let page = story_changes::read(home, &params, scope).await?;
    let unavailable = BTreeMap::get(&page.unavailable, "commits").map(Clone::clone);
    let mut commits = Vec::new();
    for commit in page.commits {
        commits.push((commit.sha, commit.files, commit.session_ids));
    }
    Ok(CommitPage {
        unavailable,
        commits,
        next: page.next_cursor,
    })
}

/// The commits of a story, as many pages as `read_page` gives (up to [`COMMIT_PAGES`]), with why
/// they could not all be read.
async fn collect_commits<F, Fut>(
    mut read_page: F,
) -> Result<(Vec<CommitFacts>, Option<String>), String>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<CommitPage, String>>,
{
    let mut commits = Vec::new();
    let mut cursor = None;
    for _ in 0..COMMIT_PAGES {
        let page = read_page(Option::take(&mut cursor)).await?;
        if let Some(reason) = page.unavailable {
            return Ok((commits, Some(reason)));
        }
        commits.extend(page.commits);
        match page.next {
            Some(next) => cursor = Some(next),
            None => return Ok((commits, None)),
        }
    }
    Ok((commits, Some("more commits than one record reads".into())))
}

/// The commits of a story, with why they could not all be read.
async fn story_commits(
    home: &Path,
    story: &str,
    scope: &CallerScope,
) -> Result<(Vec<CommitFacts>, Option<String>), String> {
    collect_commits(|cursor| read_page(home, story, cursor, scope)).await
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
    let mut unpriced_models = BTreeSet::new();
    for session in &sessions {
        models.extend(session.models.iter().cloned());
        for model in &session.unpriced_models {
            BTreeSet::insert(&mut unpriced_models, model.clone());
        }
    }
    let first = sessions.iter().map(|s| s.first_at_ms).min();
    let last = sessions.iter().map(|s| s.last_at_ms).max();
    let mut tokens = report.totals.tokens;
    let mut priced_usd = half.priced_usd;
    let mut duration = duration_of(half);
    for earlier in &half.earlier {
        Tokens::add(&mut tokens, &earlier.report.totals.tokens);
        priced_usd += earlier.priced_usd;
        duration = match (duration, duration_of(earlier)) {
            (Some(a), Some(b)) => Some(a + b),
            (a, b) => a.or(b),
        };
    }
    // The priced sum, with `unpricedModels` naming what it leaves out (as `session_usage` does);
    // null only when nothing has a price.
    let cost = if sessions.first().is_none() || (!BTreeSet::is_empty(&unpriced_models) && unpriced_models.len() >= models.len()) {
        None
    } else {
        Some(priced_usd)
    };
    let mut unavailable = BTreeMap::new();
    if sessions.first().is_none() {
        unavailable.insert("usage", "no usage has been reported for this session yet".to_owned());
    } else if !BTreeSet::is_empty(&unpriced_models) {
        let why = if Option::is_some(&cost) {
            "costUsd is the priced part only: a model of this session has no rate"
        } else {
            "a model of this session has no rate"
        };
        unavailable.insert("cost", why.to_owned());
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
        "sessionIds": chain.iter().flat_map(|h| h.ids.iter()).collect::<BTreeSet<_>>(),
        "chain": chain.iter().map(|h| &h.session_id).collect::<Vec<_>>(),
        "cli": record.and_then(|r| r.cli.clone()).map(Value::from).or_else(|| report.sessions.first().map(|s| json!(s.cli))),
        "model": record.and_then(|r| r.model.clone()).or_else(|| models.iter().next().cloned()),
        "models": models,
        "tokens": tokens,
        "costUsd": cost,
        "unpricedModels": unpriced_models,
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

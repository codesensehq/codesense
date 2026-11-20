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

/// The other sessions the registry lists on one session's thread, by the thread read's seat
/// rule ([`crate::commands::agent_inbox::thread_peers`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadPeers {
    /// The listed ones its record sums, by launch handle: the ended ones, and every one once it
    /// has ended itself.
    pub counted: Vec<String>,
    /// The concurrent live seats, by tab session id (a relaunch can reuse an ended
    /// predecessor's handle), left out while it is a seat: each seat's record holds its own and
    /// the ended ones, so nothing is counted twice.
    pub seats: Vec<String>,
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
    /// The story the session works now: its latest segment's when it was charged to more than one.
    pub story: Option<crate::session_usage::UsageStory>,
    /// Its charges to stories, oldest first.
    pub charges: Vec<crate::session_usage::charge::Charge>,
    /// What the session's rows that have a price add up to.
    pub priced_usd: f64,
    /// The rest of its thread, oldest first, by the thread read's seat rule: on a story, the
    /// handoff chain before this session (the earlier sessions of the same saved agent and story)
    /// less any concurrent live seat; with no story, the other listed no-story sessions of its
    /// saved agent. Their usage and commits count toward the record.
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

/// A `session_record` row of the thread of saved agent `?2` ([`crate::weft::pins::saved_agent`])
/// and story `?1`: any revision of the agent continues its threads.
const THREAD_MATCH: &str =
    "story_id = ?1 AND (agent = ?2 OR substr(agent, 1, length(?2) + 1) = ?2 || '@')";

/// One recorded session of a thread: its tab session and the handle it was launched under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThreadSession {
    pub session_id: String,
    pub handle: Option<String>,
}

/// Every recorded session of saved agent `agent` (any revision) on `story`, oldest first,
/// ended ones included: the sessions whose mail makes the thread. No story, none: a saved
/// agent's no-story sessions have nothing that bounds them (every one it ever launched), so
/// a no-story thread is its listed sessions only.
pub(crate) fn thread_sessions(
    store: &UsageStore,
    agent: &str,
    story: &str,
) -> Result<Vec<ThreadSession>, String> {
    let key = crate::weft::pins::saved_agent(agent);
    let story = story.trim();
    if str::is_empty(key) || str::is_empty(story) {
        return Ok(vec![]);
    }
    let mut stmt = rusqlite::Connection::prepare(
        &store.conn,
        &format!(
            "SELECT session_id, handle FROM session_record
             WHERE {THREAD_MATCH} ORDER BY recorded_at_ms, session_id"
        ),
    )
    .map_err(super::db_err)?;
    let rows = stmt
        .query_map(rusqlite::params![story, key], |row| {
            Ok(ThreadSession {
                session_id: row.get(0)?,
                handle: row.get(1)?,
            })
        })
        .map_err(super::db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(super::db_err)
}

/// [`thread_sessions`] from the usage store under `home`; a home with no store has none.
pub(crate) fn thread_sessions_in(
    home: &Path,
    agent: &str,
    story: &str,
) -> Result<Vec<ThreadSession>, String> {
    let path = home.join("usage.sqlite");
    if !Path::exists(&path) {
        return Ok(vec![]);
    }
    thread_sessions(&UsageStore::open(&path)?, agent, story)
}

/// The earlier sessions of the same saved agent and story as `record`, oldest first, less the
/// concurrent live `seats` (by tab session id). A session with no agent or no story (none, or
/// blank) has no handoff chain.
fn earlier_sessions(
    store: &UsageStore,
    record: &SessionRecord,
    seats: &[String],
) -> Result<Vec<String>, String> {
    let (Some(agent), Some(story)) = (record.agent.as_ref(), record.story_id.as_deref()) else {
        return Ok(vec![]);
    };
    let story = str::trim(story);
    if str::is_empty(story) {
        return Ok(vec![]);
    }
    let key = crate::weft::pins::saved_agent(agent);
    let mut stmt = rusqlite::Connection::prepare(
        &store.conn,
        &format!(
            "SELECT session_id FROM session_record
             WHERE {THREAD_MATCH} AND recorded_at_ms < ?3 AND session_id != ?4
             ORDER BY recorded_at_ms, session_id"
        ),
    )
    .map_err(super::db_err)?;
    let rows = stmt
        .query_map(
            rusqlite::params![story, key, record.recorded_at_ms, record.session_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(super::db_err)?;
    let mut earlier = vec![];
    for row in rows {
        let session_id: String = row.map_err(super::db_err)?;
        if !Iterator::any(&mut seats.iter(), |s| *s == session_id) {
            Vec::push(&mut earlier, session_id);
        }
    }
    Ok(earlier)
}

/// A no-story session's thread, by the thread read's rule: the other sessions of its saved agent
/// with no story that the roster lists and that count (`peers`, by handle), oldest first. Nothing else bounds a
/// saved agent's no-story sessions (every one it ever launched), so only the listed ones count.
fn listed_no_story(
    store: &UsageStore,
    record: &SessionRecord,
    peers: &[String],
) -> Result<Vec<String>, String> {
    let story = Option::map(record.story_id.as_deref(), str::trim);
    let (Some(agent), None | Some("")) = (record.agent.as_deref(), story) else {
        return Ok(vec![]);
    };
    let key = crate::weft::pins::saved_agent(agent);
    let mut found = std::collections::BTreeSet::new();
    for peer in peers {
        let Some(session_id) = session_for_handle(store, peer)? else {
            continue;
        };
        if session_id == record.session_id {
            continue;
        }
        let Some(other) = UsageStore::read_session_record(store, &session_id)? else {
            continue;
        };
        let same = Option::is_some_and(other.agent.as_deref(), |a| {
            crate::weft::pins::saved_agent(a) == key
        });
        let unstoried =
            Option::is_none_or(other.story_id.as_deref(), |s| str::is_empty(str::trim(s)));
        if same && unstoried {
            std::collections::BTreeSet::insert(&mut found, (other.recorded_at_ms, session_id));
        }
    }
    Ok(Iterator::collect(Iterator::map(IntoIterator::into_iter(found), |(_, id)| id)))
}

/// The rest of `record`'s thread whose usage its record sums, oldest first, by the thread
/// read's seat rule: on a story, its handoff chain less the concurrent live seats; with no
/// story, the listed sessions that count.
fn thread_members(
    store: &UsageStore,
    record: &SessionRecord,
    peers: &ThreadPeers,
) -> Result<Vec<String>, String> {
    let earlier = earlier_sessions(store, record, &peers.seats)?;
    if !std::vec::Vec::is_empty(&earlier) {
        return Ok(earlier);
    }
    listed_no_story(store, record, &peers.counted)
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
    let charges = UsageStore::charges_for(store, &session_id)?;
    let story = crate::session_usage::charge::current_story(&report, &charges, &mut stories);
    Ok(UsageHalf {
        session_id,
        ids,
        record,
        report,
        story,
        charges,
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
    peers: &ThreadPeers,
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
        for earlier in thread_members(&store, record, peers)? {
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

/// The record: usage figures summed over `half` and the rest of its thread (`half.earlier`),
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
    let story = half.story.clone();
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
        "charges": half.charges.iter().map(|c| json!({"story": c.story_id, "fromMs": c.from_ms, "chargedBy": c.charged_by})).collect::<Vec<_>>(),
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
    peers: &ThreadPeers,
    scope: &CallerScope,
) -> Result<Value, String> {
    crate::shared::invoke_stats::metric_count("session_record.read");
    let (owned_home, handle, owned_scope) = (home.to_owned(), params.handle.clone(), scope.clone());
    let owned_peers = Clone::clone(peers);
    let half = crate::commands::await_blocking("session_record", move || {
        usage_half(
            &owned_home,
            &handle,
            launch_stories,
            &owned_peers,
            &owned_scope,
        )
    })
    .await?;
    let story = half.story.as_ref().map(|s| s.id.clone());
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
    peers: &ThreadPeers,
    scope: &CallerScope,
) -> Result<Value, String> {
    let home = crate::commands::paths::codesense_home_dir().ok_or("no CodeSense home directory")?;
    read(&home, params, launch_stories, peers, scope).await
}

#[cfg(test)]
mod tests;

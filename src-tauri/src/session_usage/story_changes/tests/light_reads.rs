// SPDX-License-Identifier: MIT
//! SV-CDE-91: `only` narrows a read to the arrays asked for and reads git only for a git array;
//! `reviews` is the story's review rounds from the records; the facets carry activity times.
use super::*;

fn only(arrays: Value) -> Params {
    serde_json::from_value(json!({"storyId":"SV-29","only":arrays})).unwrap()
}

/// The dimensions of a story's history for the timing regressions.
#[derive(Clone, Copy)]
struct SyntheticStoryScale {
    commits: usize,
    files: usize,
    notes_per_commit: usize,
    sessions: usize,
}

/// A large real story's size (its `story_totals` when the budgets were set): 88 commits over 43
/// files, 90 sessions. Synthetic content, so no user repository is checked in.
const LARGE_STORY_SCALE: SyntheticStoryScale =
    SyntheticStoryScale { commits: 88, files: 43, notes_per_commit: 1, sessions: 90 };

/// A story branch of `scale.commits` commits touching `scale.files` files in all, each commit with
/// its notes, and `scale.sessions` sessions working on the branch. The checkout is attached, so a
/// cold read counts every commit's lines.
fn synthetic_story_at_scale(
    scale: SyntheticStoryScale,
) -> (tempfile::TempDir, UsageStore, GitStory) {
    assert!(scale.commits >= 2);
    assert!(scale.files >= 2, "the story's first commit touches one file, the rest at least one more");
    assert!(scale.sessions >= 1);
    assert!(scale.notes_per_commit <= crate::attribution::git_ai::NOTES_REFS.len());

    let (home, mut store, fixture) = git_story();
    let branch = "refs/heads/feat/SV-29-work";
    let mut commit_ids = vec![fixture.repo.refname_to_id(branch).unwrap()];
    // `git_story`'s commit touched a.txt; the others cycle through the rest of the files.
    for index in 1..scale.commits {
        let parent = *commit_ids.last().unwrap();
        let file = format!("synthetic-{}.txt", (index - 1) % (scale.files - 1));
        let subject = format!("SV-29 synthetic change {index}");
        commit_ids.push(fixture.commit(branch, &subject, &file, 2000 + index as i64, &[parent]));
    }

    let signature = git2::Signature::new("fixture", "fixture@example.com", &git2::Time::new(2000, 0)).unwrap();
    for (index, oid) in commit_ids.iter().enumerate() {
        for notes_ref in crate::attribution::git_ai::NOTES_REFS.iter().take(scale.notes_per_commit) {
            fixture
                .repo
                .note(
                    &signature,
                    &signature,
                    Some(&format!("refs/notes/{notes_ref}")),
                    *oid,
                    "---\n{\"schema_version\":\"authorship/3.0.0\",\"sessions\":{}}",
                    true,
                )
                .unwrap_or_else(|error| panic!("note {index}: {error}"));
        }
    }

    for index in 1..scale.sessions {
        let session = format!("synthetic-session-{index}");
        seed(&mut store, home.path(), &session, true, false);
        let mut record = store.read_session_record(&session).unwrap().unwrap();
        record.branch = Some("feat/SV-29-work".into());
        record.worktree = Some(fixture.dir.path().to_string_lossy().into_owned());
        record.workspace = record.worktree.clone();
        store.write_session_record(&record).unwrap();
    }
    // Attached under the remote the why_line fixture org configures.
    fixture.repo.remote_set_url("origin", "https://github.com/acme/api.git").unwrap();
    crate::attribution::why_line::tests::org(home.path());
    crate::attribution::why_line::tests::bind(home.path(), fixture.dir.path());
    (home, store, fixture)
}

/// Unoptimized test builds run several times slower than the app, so the wall-clock bounds are a
/// backstop scaled for them; the counters (walks, reads, git children, git-ai awaits) are the
/// gate. The absolute budgets, 1 s cold and 200 ms warm, are measured on a release build and kept
/// in the sandbox's `budget.json`.
const SLOW_BUILD: u32 = if cfg!(debug_assertions) { 5 } else { 1 };

/// The answer the bridge gives for `params` (the read, then its pruning).
async fn answer(home: &Path, params: &Params) -> Value {
    let mut value =
        serde_json::to_value(read(home, params, &CallerScope::Human).await.unwrap()).unwrap();
    prune(&mut value, params);
    value
}

fn signal(s: &UsageStore, id: &str, at: i64, event: Event) {
    TimingState::default()
        .apply(
            s,
            &Stamped {
                session_id: id.into(),
                at_ms: at,
                signal: Signal::Activity(event, "fixture"),
            },
        )
        .unwrap();
}

/// A story whose history walk is real (a branch with a commit): every array has something.
fn git_story() -> (tempfile::TempDir, UsageStore, GitStory) {
    let (home, mut s) = store();
    let f = GitStory::new();
    let tip = f.commit("refs/heads/feat/SV-29-work", "SV-29 work", "a.txt", 2000, &[f.root]);
    f.repo
        .reference("refs/heads/feat/SV-29-work", tip, true, "fixture")
        .unwrap();
    f.seed(home.path(), &mut s, "feat/SV-29-work", false);
    let mut task = TaskRecord::new("dev", "build");
    task.story_id = Some("SV-29".into());
    s.insert_task_if_absent(&task).unwrap();
    (home, s, f)
}

/// A story with the team's review-rounds markers of `from`, re-stamped as SV-29.
fn reviewed_story(from: &str) -> (tempfile::TempDir, UsageStore) {
    let (dir, mut s) = store();
    std::fs::write(dir.path().join("story.md"), "---\nstatus: in-progress\n---\n").unwrap();
    seed(&mut s, dir.path(), "dev", true, false);
    team_markers(dir.path(), from);
    let mut dev = TaskRecord::new("dev", "build");
    dev.story_id = Some("SV-29".into());
    dev.org = Some("acme".into());
    dev.team = Some("riverside".into());
    s.insert_task_if_absent(&dev).unwrap();
    (dir, s)
}

/// AC1: without a git array, `only` answers no git array and leaves out what was not asked
/// for. Sessions and reviews read no git (before `only`, `read` always called `git_facts`);
/// tasks read the story's commits for their outcomes (`task_evidence`), walking once: a later
/// tasks read at the same refs reuses the kept walk.
#[tokio::test]
async fn only_without_a_git_array_answers_no_git_and_only_tasks_read_git_for_outcomes() {
    let (home, _s, _f) = git_story();
    for (arrays, reads_git) in [
        (json!(["tasks"]), true),
        (json!(["sessions"]), false),
        (json!(["reviews"]), false),
        (json!(["tasks", "sessions"]), false),
    ] {
        let before = git_reads(home.path());
        let value = answer(home.path(), &only(arrays.clone())).await;
        assert_eq!(git_reads(home.path()) > before, reads_git, "{arrays}: read git");
        for field in [
            "commits", "prs", "branches", "worktrees", "actual", "planned", "plannedUntouched",
            "total", "nextCursor", "scanLimit", "historyAsOf",
        ] {
            assert!(value.get(field).is_none(), "{arrays}: {field} answered");
        }
        for field in ["commits", "files", "lines"] {
            assert!(
                value["totals"].get(field).is_some_and(Value::is_null),
                "{arrays}: totals.{field} must be null, not absent or a number"
            );
            assert!(value["unavailable"][field].is_string(), "{arrays}: no reason for {field}");
        }
        assert_eq!(value["totals"]["sessions"], 1, "the session half of the totals stays complete");
        assert_eq!(value["totals"]["costUsd"], 2.0);
    }
    let tasks = answer(home.path(), &only(json!(["tasks"]))).await;
    assert_eq!(tasks["tasks"][0]["taskId"], "dev");
    assert!(tasks.get("sessions").is_none() && tasks.get("reviews").is_none());
    let sessions = answer(home.path(), &only(json!(["sessions"]))).await;
    assert_eq!(sessions["sessions"][0]["session"]["sessionId"], "git-session");
    assert!(sessions.get("tasks").is_none());
}

#[tokio::test]
async fn a_git_array_in_only_reads_git_and_keeps_the_totals() {
    let (home, _s, _f) = git_story();
    let value = answer(home.path(), &only(json!(["commits"]))).await;
    assert!(git_reads(home.path()) > 0, "commits must read git");
    assert_eq!(value["commits"].as_array().unwrap().len(), 1);
    assert_eq!(value["totals"]["commits"], 1);
    assert!(value.get("tasks").is_none() && value.get("sessions").is_none());
    assert!(value.get("prs").is_none());
    let full = get(home.path()).await;
    assert_eq!(value["commits"], full["commits"]);
    assert_eq!(value["totals"], full["totals"]);
    assert!(full.get("reviews").is_none(), "a read without only has no reviews");
}

/// A git-free read has no commit set to page: a cursor is stale on every entry path (the page
/// bridge, hosted and MCP all go through `read`); a git array still validates it as before.
#[tokio::test]
async fn a_cursor_on_a_git_free_only_is_stale() {
    let (home, _s, _f) = git_story();
    let with_cursor: Params =
        serde_json::from_value(json!({"storyId":"SV-29","only":["tasks"],"cursor":"sc:abc:def"})).unwrap();
    let error = read(home.path(), &with_cursor, &CallerScope::Human).await.unwrap_err();
    assert_eq!(error, git::STALE_CURSOR);
    // MCP: a commit cursor reaches the read and is refused; an array cursor is the projection's.
    let agent: AgentParams =
        serde_json::from_value(json!({"storyId":"SV-29","only":["tasks"],"cursor":"sc:abc:def"})).unwrap();
    let error = read(home.path(), &agent_read_params(&agent), &CallerScope::Human)
        .await
        .unwrap_err();
    assert_eq!(error, git::STALE_CURSOR);
    // A git array other than commits has no commit set to page either.
    let prs: Params =
        serde_json::from_value(json!({"storyId":"SV-29","only":["prs"],"cursor":"sc:abc:def"})).unwrap();
    assert_eq!(read(home.path(), &prs, &CallerScope::Human).await.unwrap_err(), git::STALE_CURSOR);
    // Commits validate the cursor against their own set, as without `only`.
    let commits: Params =
        serde_json::from_value(json!({"storyId":"SV-29","only":["commits"],"cursor":"sc:abc:def"})).unwrap();
    assert!(read(home.path(), &commits, &CallerScope::Human).await.is_err());
}

#[tokio::test]
async fn an_empty_or_unknown_only_is_invalid() {
    let (home, _s, _f) = git_story();
    let error = read(home.path(), &only(json!([])), &CallerScope::Human)
        .await
        .unwrap_err();
    assert!(error.starts_with("invalid:"), "{error}");
    let unknown: Result<Params, _> =
        serde_json::from_value(json!({"storyId":"SV-29","only":["nope"]}));
    assert!(unknown.is_err());
}

/// AC4: the rounds of a seeded story as the records hold them: rounds 1 to 4 with their
/// severities and `converged` as recorded, no git, and nothing that names a reviewer.
#[tokio::test]
async fn only_reviews_matches_the_records() {
    let (dir, _s) = reviewed_story("DEMO-1");
    let value = answer(dir.path(), &only(json!(["reviews"]))).await;
    assert_eq!(git_reads(dir.path()), 0);
    let rows = value["reviews"].as_array().unwrap();
    assert_eq!(rows.len(), 6, "the six complete markers; the in-flight one never counts");
    let shape = |row: &Value| {
        (
            row["round"].as_i64().unwrap(),
            row["scope"].as_str().unwrap().to_owned(),
            [&row["high"], &row["medium"], &row["low"], &row["dismissed"]]
                .map(|n| n.as_i64().unwrap()),
            row["converged"].as_bool().unwrap(),
        )
    };
    let first_four: Vec<_> = rows[..4].iter().map(shape).collect();
    assert_eq!(
        first_four,
        vec![
            (1, "full".to_owned(), [0, 3, 0, 0], false),
            (2, "full".to_owned(), [0, 1, 0, 0], false),
            (3, "delta".to_owned(), [0, 2, 2, 0], false),
            (4, "delta".to_owned(), [0, 0, 5, 0], true),
        ]
    );
    assert_eq!(rows[0]["phase"], "review");
    assert_eq!(rows[0]["skill"], "bmad-code-review");
    assert_eq!(rows[0]["subjectRev"], "abcdef0000000000000000000000000000000001");
    assert_eq!(rows[0]["reportedAt"], 179325);
    assert_eq!(rows[0]["id"], "demo1-101-r1", "the private read keeps the record id");
    for row in rows {
        for private in ["reviewer", "session", "task", "findingIds", "reviewerModel"] {
            assert!(row.get(private).is_none(), "{private} answered");
        }
    }
    assert_eq!(value["totals"]["reviewRounds"], 6, "the rows and the count are the same markers");
    assert!(value.get("tasks").is_none() && value.get("commits").is_none());
}

#[tokio::test]
async fn unreadable_review_markers_say_why_and_a_story_without_rounds_has_none() {
    // No team of the story is on this Mac: unavailable, never an empty list.
    let (dir, _s) = store();
    let value = answer(dir.path(), &only(json!(["reviews"]))).await;
    assert!(value.get("reviews").is_none());
    assert!(value["unavailable"]["reviews"].is_string());
    // A team that declares the collection and holds no round of the story: an empty list.
    let (dir, _s) = reviewed_story("SV-NO-SUCH-STORY");
    let value = answer(dir.path(), &only(json!(["reviews"]))).await;
    assert_eq!(value["reviews"], json!([]));
    assert!(value["unavailable"].get("reviews").is_none());
}

/// The agent's answer pages the arrays returned, answers no `commits` for an `only` without
/// them, and refuses a cursor into an array it does not return.
#[tokio::test]
async fn the_agent_answer_follows_only() {
    let (home, _s, _f) = git_story();
    let agent = |value: Value| -> AgentParams { serde_json::from_value(value).unwrap() };
    let params = agent(json!({"storyId":"SV-29","only":["tasks"]}));
    let value = answer(home.path(), &agent_read_params(&params)).await;
    let projected = agent_projection(value, &params).unwrap();
    assert!(projected.get("commits").is_none() && projected["pages"].get("commits").is_none());
    assert_eq!(projected["pages"]["tasks"]["total"], 1);
    assert!(projected["pages"].get("sessions").is_none());
    let stale = agent(json!({"storyId":"SV-29","only":["tasks"],"cursor":"sca:sessions:abc:x"}));
    let value = answer(home.path(), &agent_read_params(&stale)).await;
    assert_eq!(agent_projection(value, &stale).unwrap_err(), git::STALE_CURSOR);
}

/// E2: the session activity is the usage the report rolls up (the seeded events are at
/// `USAGE_AT`); a task's creation and close count; nothing recorded is null with a reason.
const USAGE_AT: i64 = 1_790_000_000_000;

fn facets_of(dir: &Path) -> impl std::future::Future<Output = Value> {
    let dir = dir.to_owned();
    async move {
        totals(&dir, "SV-29", &CallerScope::Human, None, None, None)
            .await
            .unwrap()
            .2
    }
}

#[tokio::test]
async fn the_facets_carry_activity_times_from_usage_and_tasks() {
    let (dir, mut s) = store();
    let empty = facets_of(dir.path()).await;
    assert!(empty["firstActivityAt"].is_null() && empty["lastActivityAt"].is_null());
    assert_eq!(empty["openSessions"], 0);
    assert!(empty["activityReason"].is_string());
    // Tasks alone: the creation and the close are the first and the last time.
    let mut task = TaskRecord::new("dev", "build");
    task.story_id = Some("SV-29".into());
    task.created_at_ms = 50;
    task.closed_at_ms = Some(60);
    s.insert_task_if_absent(&task).unwrap();
    let tasks = facets_of(dir.path()).await;
    assert_eq!((&tasks["firstActivityAt"], &tasks["lastActivityAt"]), (&json!(50), &json!(60)));
    assert!(tasks.get("activityReason").is_none());
    // Sessions: their usage is the activity, whatever their timing says.
    for (id, first, stop, end) in [("a", 100, 200, 300), ("b", 150, 250, 350)] {
        seed(&mut s, dir.path(), id, true, false);
        for (at, event) in [(first, Event::Submitted), (stop, Event::Stopped), (end, Event::Ended)] {
            signal(&s, id, at, event);
        }
    }
    let ended = facets_of(dir.path()).await;
    assert_eq!((&ended["firstActivityAt"], &ended["lastActivityAt"]), (&json!(50), &json!(USAGE_AT)));
    assert_eq!(ended["openSessions"], 0);
}

/// Commits and merges add to the story's activity, whatever the sessions say.
#[test]
fn commits_and_merges_count_as_activity() {
    let sessions = Activity { first: Some(5_000), last: Some(6_000) };
    let git = GitTotals {
        first_commit_at: Some(2_000),
        last_commit_at: Some(7_000),
        merged_at: Some(9_000),
        ..Default::default()
    };
    let both = sessions.with_git(&git);
    assert_eq!((both.first, both.last), (Some(2_000), Some(9_000)));
    let none = Activity { first: None, last: None }.with_git(&GitTotals::default());
    assert_eq!((none.first, none.last), (None, None));
    let merged_only = Activity { first: None, last: None }.with_git(&GitTotals { merged_at: Some(4), ..Default::default() });
    assert_eq!((merged_only.first, merged_only.last), (Some(4), Some(4)));
}

/// A session with no end is open only while it is active: a killed one (no end, old activity)
/// is not, a live one (recent turn) is, and an ended one never is.
#[tokio::test]
async fn open_sessions_are_the_unended_ones_active_in_the_last_fifteen_minutes() {
    let (dir, mut s) = store();
    let now = chrono::Utc::now().timestamp_millis();
    // Killed: its last turn finished an hour ago and it never ended.
    seed(&mut s, dir.path(), "killed", true, false);
    signal(&s, "killed", now - 3_600_000, Event::Submitted);
    signal(&s, "killed", now - 3_590_000, Event::Stopped);
    // Ended recently.
    seed(&mut s, dir.path(), "ended", true, false);
    for (at, event) in [(now - 120_000, Event::Submitted), (now - 90_000, Event::Stopped), (now - 60_000, Event::Ended)] {
        signal(&s, "ended", at, event);
    }
    assert_eq!(facets_of(dir.path()).await["openSessions"], 0);
    // Live: a turn finished a minute ago.
    seed(&mut s, dir.path(), "live", true, false);
    signal(&s, "live", now - 90_000, Event::Submitted);
    signal(&s, "live", now - 60_000, Event::Stopped);
    assert_eq!(facets_of(dir.path()).await["openSessions"], 1);
}

/// E2: a review round's report time counts as activity.
#[tokio::test]
async fn review_rounds_count_as_activity() {
    let (dir, _s) = reviewed_story("DEMO-1");
    let facets = facets_of(dir.path()).await;
    // The fixture's six rounds are reported at 179325, before the session's own usage.
    assert_eq!(facets["firstActivityAt"], 179_325);
}

/// E2: the commits of the git half are counted, through the facets the index keeps.
#[tokio::test]
async fn commits_count_as_activity_through_the_git_half() {
    let (home, _s, _f) = git_story();
    let facets = facets_of(home.path()).await;
    // The fixture's one commit is authored at 2000 s, before every other event.
    assert_eq!(facets["firstActivityAt"], 2_000_000);
}

/// The rounds the agent pages by `limit` (cursor and all) like every other array.
#[tokio::test]
async fn the_agent_pages_reviews() {
    let (dir, _s) = reviewed_story("DEMO-1");
    let agent = |value: Value| -> AgentParams { serde_json::from_value(value).unwrap() };
    let first = agent(json!({"storyId":"SV-29","only":["reviews"],"limit":2}));
    let value = answer(dir.path(), &agent_read_params(&first)).await;
    let page = agent_projection(value, &first).unwrap();
    assert_eq!(page["reviews"].as_array().unwrap().len(), 2);
    assert_eq!(page["pages"]["reviews"]["total"], 6);
    assert_eq!(page["pages"]["reviews"]["truncated"], true);
    let cursor = page["pages"]["reviews"]["cursor"].as_str().unwrap().to_owned();
    let second = agent(json!({"storyId":"SV-29","only":["reviews"],"limit":2,"cursor":cursor}));
    let value = answer(dir.path(), &agent_read_params(&second)).await;
    let next = agent_projection(value, &second).unwrap();
    assert_eq!(next["reviews"][0]["id"], "demo1-101-r3");
    assert_eq!(next["pages"]["reviews"]["total"], 6);
}

/// A round the record does not date or sort-name is answered without those fields, and sorts last.
/// (`subjectRev` stays: it is a stamp, and a round missing a stamp is not a complete round.)
#[tokio::test]
async fn review_rows_omit_missing_fields_and_undated_rounds_sort_last() {
    let (dir, _s) = reviewed_story("DEMO-1");
    let rounds = dir.path().join("users/1/orgs/acme/riverside/content/reviews/rounds");
    let first = rounds.join("demo1-101-r1.md");
    let raw = std::fs::read_to_string(&first).unwrap();
    std::fs::write(&first, raw.replace("\nreportedAt: 179325\n", "\n").replace("\nsubjectKind: pr\n", "\n")).unwrap();
    let value = answer(dir.path(), &only(json!(["reviews"]))).await;
    let rows = value["reviews"].as_array().unwrap();
    let undated = rows.last().unwrap();
    assert_eq!(undated["id"], "demo1-101-r1");
    assert!(undated.get("reportedAt").is_none() && undated.get("subjectKind").is_none());
    assert!(undated.get("subjectRev").is_some(), "a stamped field the record holds is answered");
    for row in rows {
        for (key, value) in row.as_object().unwrap() {
            assert!(!value.is_null() && value != "", "{key} answered empty");
        }
    }
}

/// A second read of the same story at the same refs does no git walk; a branch tip that moves
/// invalidates the kept facts and walks again.
#[tokio::test]
async fn story_reads_reuse_the_kept_git_half_until_a_branch_tip_moves() {
    let (home, _s, f) = git_story();
    let asked = only(json!(["commits", "prs", "branches"]));
    let first = serde_json::to_value(
        read_with(home.path(), &asked, &CallerScope::Human, None)
            .await
            .unwrap(),
    )
    .unwrap();
    let walked = git_reads(home.path());
    assert!(walked > 0, "the first read walks git");
    assert_eq!(first["commits"].as_array().unwrap().len(), 1);

    let second = serde_json::to_value(read(home.path(), &asked, &CallerScope::Human).await.unwrap()).unwrap();
    assert_eq!(git_reads(home.path()), walked, "the second read walked git");
    assert_eq!(second["commits"], first["commits"]);
    assert_eq!(second["prs"], first["prs"]);
    assert_eq!(second["branches"], first["branches"]);

    let tip = f.repo.refname_to_id("refs/heads/feat/SV-29-work").unwrap();
    f.commit(
        "refs/heads/feat/SV-29-work",
        "SV-29 more",
        "b.txt",
        3000,
        &[tip],
    );
    let walked = git_reads(home.path());
    let moved = serde_json::to_value(read(home.path(), &asked, &CallerScope::Human).await.unwrap()).unwrap();
    assert!(
        git_reads(home.path()) > walked,
        "a moved tip walks git again"
    );
    assert_eq!(moved["commits"].as_array().unwrap().len(), 2);
}

/// At a large real story's size, the cold read counts every commit's lines, a warm read walks and
/// spawns nothing, an unrelated note does not invalidate the kept facts, and with the managed
/// git-ai installed no read awaits it. Both reads stay within the budgets ([`SLOW_BUILD`]).
#[tokio::test]
async fn story_read_warm_cache_survives_an_unrelated_note() {
    use crate::attribution::git_ai::tests::{awaits, stub_git_ai};
    let scale = LARGE_STORY_SCALE;
    let (home, _s, f) = synthetic_story_at_scale(scale);
    let log = stub_git_ai(home.path());
    let asked = only(json!(["commits", "prs", "branches"]));
    let cold_at = std::time::Instant::now();
    let first = read(home.path(), &asked, &CallerScope::Human).await.unwrap();
    let cold = cold_at.elapsed();
    assert!(cold < std::time::Duration::from_secs(1) * SLOW_BUILD, "cold read took {cold:?}");
    assert_eq!(first.commits.len(), scale.commits);
    assert!(first.unavailable.get("lines").is_none(), "lines not counted: {:?}", first.unavailable);
    assert!(first.totals.lines.is_some(), "the cold read counted no lines");
    let files: BTreeSet<&String> = first.commits.iter().flat_map(|c| c.files.iter()).collect();
    assert_eq!(files.len(), scale.files);
    assert_eq!(awaits(&log), 0, "a cold read awaited git-ai");
    let (children, walked) = (crate::attribution::git_ai::child_processes(f.dir.path()), git_reads(home.path()));

    let signature = git2::Signature::new("fixture", "fixture@example.com", &git2::Time::new(9000, 0)).unwrap();
    f.repo
        .note(&signature, &signature, Some("refs/notes/sense"), f.root, "unrelated note", true)
        .unwrap();

    let warm_at = std::time::Instant::now();
    let second = read(home.path(), &asked, &CallerScope::Human).await.unwrap();
    let warm = warm_at.elapsed();
    assert!(warm < std::time::Duration::from_millis(200) * SLOW_BUILD, "warm read took {warm:?}");
    assert_eq!(serde_json::to_value(&second.commits).unwrap(), serde_json::to_value(&first.commits).unwrap());
    assert_eq!(git_reads(home.path()), walked, "the warm read walked git");
    assert_eq!(
        crate::attribution::git_ai::child_processes(f.dir.path()),
        children,
        "a warm story read spawned a git child"
    );
    assert_eq!(awaits(&log), 0, "a warm read awaited git-ai");
}

/// Record reads revisit the story after every usage notice; once it is warm they reuse its
/// kept git facts (no walk, no git child) and never await git-ai, though each notice's usage is new.
#[tokio::test]
async fn repeated_session_record_reads_do_not_spawn_more_git_children() {
    use crate::attribution::git_ai::tests::{awaits, stub_git_ai};
    let (home, mut store, f) = git_story();
    let log = stub_git_ai(home.path());
    let mut record = store.read_session_record("git-session").unwrap().unwrap();
    record.handle = Some("record-reader".into());
    store.write_session_record(&record).unwrap();

    let asked = only(json!(["commits"]));
    read(home.path(), &asked, &CallerScope::Human).await.unwrap();
    let (children, walked) = (crate::attribution::git_ai::child_processes(f.dir.path()), git_reads(home.path()));
    for notice in 0..10 {
        let usage = event(
            &format!("record-usage-{notice}"),
            "git-session",
            "gpt-6-sol",
            1_790_000_001_000 + notice,
            Tokens { input: 1, ..Default::default() },
        );
        store.ingest(&[usage]).unwrap();
        let result = crate::session_usage::agent_record::read(
            home.path(),
            &crate::session_usage::agent_record::Params {
                handle: "record-reader".into(),
            },
            std::collections::HashMap::new(),
            &Default::default(),
            &CallerScope::Human,
        )
        .await
        .unwrap();
        assert!(!result["story"].is_null());
    }
    assert_eq!(git_reads(home.path()), walked, "a record read walked git");
    assert_eq!(
        crate::attribution::git_ai::child_processes(f.dir.path()),
        children,
        "record reads spawned git after warming the story cache"
    );
    assert_eq!(awaits(&log), 0, "a record read awaited git-ai");
}

/// `task_read` (`task_view`) collects its story's git evidence through the kept walk: a second
/// read at the same refs walks nothing, and a moved branch tip walks again.
#[tokio::test]
async fn task_view_reuses_the_kept_story_walk() {
    let (home, store, f) = git_story();
    let task_id: String = store
        .conn
        .query_row("SELECT task_id FROM task WHERE story_id = 'SV-29' LIMIT 1", [], |row| row.get(0))
        .unwrap();
    let walks = git_walks(home.path());
    assert!(store.task_view(&task_id).unwrap().is_some());
    let walked = git_walks(home.path());
    assert!(walked > walks, "the first task read walks the story");
    let children = crate::attribution::git_ai::child_processes(f.dir.path());
    store.task_view(&task_id).unwrap();
    assert_eq!(git_walks(home.path()), walked, "the second task read walked git");
    assert_eq!(crate::attribution::git_ai::child_processes(f.dir.path()), children);

    let tip = f.repo.refname_to_id("refs/heads/feat/SV-29-work").unwrap();
    f.commit("refs/heads/feat/SV-29-work", "SV-29 more", "b.txt", 3000, &[tip]);
    store.task_view(&task_id).unwrap();
    assert!(git_walks(home.path()) > walked, "a moved tip walks git again");
}

/// Only a kept read or task walk stamps refs (the totals sweep pays no ref scan), and the stamp covers origin's head and the story's own branches, not every ref in the repo.
#[tokio::test]
async fn only_a_kept_read_stamps_and_the_stamp_follows_the_story_branches() {
    let (home, _s, f) = git_story();
    let refs = vec![git::SessionRef {
        branch: Some("feat/SV-29-work".into()),
        worktree: Some(f.dir.path().to_string_lossy().into_owned()),
        workspace: None,
        associated: false,
    }];
    let (sweep, _) = git_facts(
        home.path(),
        "SV-29",
        &CallerScope::Human,
        &refs,
        false,
        None,
    )
    .await
    .unwrap();
    assert!(sweep.refs_stamp.is_empty() && sweep.stamp_spec.repos.is_empty());

    let (kept, _) = git_facts(home.path(), "SV-29", &CallerScope::Human, &refs, true, None)
        .await
        .unwrap();
    assert!(
        kept.refs_stamp.contains("refs/heads/feat/SV-29-work"),
        "{}",
        kept.refs_stamp
    );
    assert_eq!(cache::stamp_of(&kept.stamp_spec), kept.refs_stamp);

    f.commit("refs/heads/unrelated", "other", "o.txt", 3000, &[f.root]);
    assert_eq!(
        cache::stamp_of(&kept.stamp_spec),
        kept.refs_stamp,
        "a branch the walk does not read moved the stamp"
    );
    let tip = f.repo.refname_to_id("refs/heads/feat/SV-29-work").unwrap();
    f.commit(
        "refs/heads/feat/SV-29-work",
        "SV-29 more",
        "b.txt",
        3100,
        &[tip],
    );
    assert_ne!(
        cache::stamp_of(&kept.stamp_spec),
        kept.refs_stamp,
        "the story branch moved and the stamp did not"
    );
}

/// SV-CDE-91 B2a: a story's lines are a fold of its commit rows. The compute that walks git writes
/// the rows and answers "counting in the background" (flagged refreshing); once the sweep has
/// counted them, the next compute folds them with the git half kept, so it reads no git.
#[tokio::test]
async fn lines_are_pending_until_the_commit_sweep_counts_then_fold_without_a_walk() {
    let (home, _s, _f) = git_story();
    let first = totals(home.path(), "SV-29", &CallerScope::Human, None, None, None).await.unwrap();
    let (facets, git) = (first.2, first.3);
    assert!(git.lines.is_none() && git.lines_pending);
    assert_eq!(git.unavailable["lines"], COUNTING);
    assert_eq!(facets["linesRefreshing"], true);
    assert!(facets["linesInProgress"].is_null());
    assert_eq!(facets["linesInProgressReason"], COUNTING);

    let store = std::sync::Mutex::new(UsageStore::open(&home.path().join("usage.sqlite")).unwrap());
    let marked = std::cell::Cell::new(0);
    let swept = sweep_commits(
        &store,
        home.path(),
        chrono::Utc::now().timestamp_millis(),
        (std::time::Duration::from_secs(60), std::time::Duration::from_secs(60)),
        &|_, filled| {
            marked.set(marked.get() + filled.len());
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(swept.counted, 1);
    assert_eq!(marked.get(), 1, "the story whose row was filled is marked");

    let walks = git_walks(home.path());
    let second = totals(home.path(), "SV-29", &CallerScope::Human, Some(git), None, None).await.unwrap();
    assert_eq!(git_walks(home.path()), walks, "the kept git half is folded, not walked");
    let (facets, git) = (second.2, second.3);
    assert!(!git.lines_pending && facets.get("linesRefreshing").is_none());
    let reason = git.unavailable.get("lines").expect("an unattached repository cannot be read");
    assert_ne!(reason, COUNTING);
    assert_eq!(facets["linesInProgressReason"], json!(reason));
}

/// A story whose git half is invalidated keeps its earlier lines (refreshing) while its commits are
/// counted, instead of publishing none.
#[tokio::test]
async fn an_invalidated_git_half_keeps_the_earlier_lines_while_counting() {
    let (home, _s, _f) = git_story();
    let first = totals(home.path(), "SV-29", &CallerScope::Human, None, None, None).await.unwrap();
    let mut earlier = first.3;
    earlier.lines = Some(json!({"total": 7}));
    let again = totals(home.path(), "SV-29", &CallerScope::Human, None, Some(earlier), None).await.unwrap();
    let (facets, git) = (again.2, again.3);
    assert!(git.lines_pending);
    assert_eq!(git.lines, Some(json!({"total": 7})), "the earlier lines stand");
    assert_eq!(facets["linesRefreshing"], true);
}

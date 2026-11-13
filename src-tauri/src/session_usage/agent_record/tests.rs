// SPDX-License-Identifier: MIT
use super::*;
use crate::session_usage::{
    event::Tokens,
    record::SessionRecord,
    tests::{event, store},
};
use codesense_pty_core::agent_cli::AgentCli;
use serde_json::json;

const AT: i64 = 1_790_000_000_000;

/// One launched session of `cli` under `handle`: a record and one priced call of 100 input tokens.
fn launched(dir: &Path, cli: AgentCli, handle: &str, model: &str, run: Option<&str>) {
    let mut store = UsageStore::open(&dir.join("usage.sqlite")).unwrap();
    let mut record = SessionRecord::new(format!("tab-{handle}"));
    record.handle = Some(handle.into());
    record.cli = Some(cli.to_string());
    record.model = Some(model.into());
    record.run_id = run.map(str::to_owned);
    record.worktree = Some(format!("/work/{handle}"));
    store.write_session_record(&record).unwrap();
    let mut call = event(
        &format!("e-{handle}"),
        &format!("tab-{handle}"),
        model,
        AT,
        Tokens {
            input: 100,
            output: 20,
            ..Default::default()
        },
    );
    call.cli = cli;
    store.ingest(&[call]).unwrap();
}

fn half(dir: &Path, handle: &str) -> UsageHalf {
    usage_half(dir, handle, HashMap::new(), &CallerScope::Human).unwrap()
}

/// What `session_usage` answers for the same session.
fn usage_row(dir: &Path, session: &str) -> crate::session_usage::SessionUsage {
    let store = UsageStore::open(&dir.join("usage.sqlite")).unwrap();
    let filter = Filter {
        session_id: Some(session.into()),
        ..Default::default()
    };
    let mut report = store.report(&filter).unwrap();
    report.sessions.remove(0)
}

#[test]
fn claude_codex_and_opencode_records_equal_session_usage() {
    for (cli, model) in [
        (AgentCli::Claude, "claude-sonnet-5-5"),
        (AgentCli::Codex, "gpt-6-sol"),
        (AgentCli::OpenCode, "deepseek-v4-1-flash"),
    ] {
        let (dir, _store) = store();
        let handle = format!("agent-{cli}");
        launched(dir.path(), cli, &handle, model, None);
        let half = half(dir.path(), &handle);
        let record = assemble(&handle, &half, None, None);
        let row = usage_row(dir.path(), &half.session_id);
        assert_eq!(record["handle"], handle);
        assert_eq!(record["sessionId"], half.session_id);
        assert_eq!(record["cli"], cli.to_string());
        assert_eq!(record["model"], model);
        assert_eq!(record["models"], json!([model]));
        assert_eq!(record["tokens"], json!(row.tokens));
        assert_eq!(record["costUsd"], json!(row.cost_usd));
        assert_eq!(record["firstAtMs"], row.first_at_ms);
        assert_eq!(record["lastAtMs"], row.last_at_ms);
        assert_eq!(record["worktree"], format!("/work/{handle}"));
        // No story: no story link and an honest reason, not an empty panel.
        assert_eq!(record["story"], Value::Null);
        assert_eq!(record["files"], json!([]));
        assert!(record["unavailable"]["story"].is_string());
        assert!(record["unavailable"]["files"].is_string());
    }
}

#[test]
fn a_headless_run_has_a_record_with_its_run_and_no_chat_fields() {
    let (dir, _store) = store();
    launched(
        dir.path(),
        AgentCli::Claude,
        "routine:nightly@acme",
        "claude-sonnet-5-5",
        Some("run-7"),
    );
    let half = half(dir.path(), "routine:nightly@acme");
    let record = assemble("routine:nightly@acme", &half, None, None);
    assert_eq!(record["runId"], "run-7");
    assert_eq!(record["tokens"]["input"], 100);
    assert_eq!(record["story"], Value::Null);
}

#[test]
fn files_are_the_story_commits_made_by_the_session() {
    let (dir, _store) = store();
    launched(dir.path(), AgentCli::Claude, "dev", "claude-sonnet-5-5", None);
    let half = half(dir.path(), "dev");
    let mine = vec![half.session_id.clone()];
    let commits: Vec<CommitFacts> = vec![
        ("c1".into(), vec!["a.rs".into(), "b.rs".into()], mine.clone()),
        ("c2".into(), vec!["a.rs".into()], mine),
        ("c3".into(), vec!["other.rs".into()], vec!["someone-else".into()]),
    ];
    let record = assemble("dev", &half, Some(&commits), None);
    assert_eq!(
        record["files"],
        json!([
            {"path": "a.rs", "commits": ["c1", "c2"]},
            {"path": "b.rs", "commits": ["c1"]},
        ])
    );
    assert!(record["unavailable"].get("files").is_none());
}

#[test]
fn an_unpriced_model_gives_no_cost_and_says_why() {
    let (dir, _store) = store();
    launched(dir.path(), AgentCli::Codex, "dev", "no-price", None);
    let half = half(dir.path(), "dev");
    let record = assemble("dev", &half, None, None);
    assert_eq!(record["costUsd"], Value::Null);
    assert!(record["unavailable"]["cost"].is_string());
}

#[test]
fn an_unknown_or_empty_handle_is_refused() {
    let (dir, _store) = store();
    let scope = CallerScope::Human;
    let unknown = usage_half(dir.path(), "nobody", HashMap::new(), &scope);
    assert!(unknown.err().unwrap().contains("unknown session"));
    let empty = usage_half(dir.path(), "  ", HashMap::new(), &scope);
    assert!(empty.err().unwrap().contains("handle must not be empty"));
}

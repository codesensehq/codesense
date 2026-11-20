// SPDX-License-Identifier: MIT
use super::*;
use crate::session_usage::event::Tokens;
use crate::session_usage::tests::{event, store};
use serde_json::json;

const NOW: i64 = 1_790_000_100_000;

/// A launched seat of org `acme`: its tab, team, handle, who launched it and when it was recorded.
fn seat(store: &UsageStore, tab: &str, team: &str, handle: &str, launched_by: Option<&str>, at: i64) {
    let mut r = SessionRecord::new(tab);
    r.org = Some("acme".into());
    r.team = Some(team.into());
    r.handle = Some(handle.into());
    r.launched_by = launched_by.map(str::to_owned);
    r.recorded_at_ms = at;
    store.write_session_record(&r).unwrap();
}

fn caller(session: &str, handle: &str) -> Caller {
    Caller { session: session.into(), handle: Some(handle.into()), team: None }
}

fn params(story: &str, session: Option<&str>, from_ms: Option<i64>) -> ChargeSessionStoryParams {
    ChargeSessionStoryParams { story: story.into(), session_id: session.map(str::to_owned), from_ms }
}

fn known(_org: &str, _team: &str, id: &str) -> Option<PathBuf> {
    ["DEMO-1", "DEMO-2"].contains(&id).then(|| PathBuf::from(format!("{id}.md")))
}

fn as_recorded(raw: &str) -> String {
    raw.to_owned()
}

fn run(store: &UsageStore, by: &Caller, p: ChargeSessionStoryParams) -> Result<Value, String> {
    charge(store, by, &p, NOW, &known, &as_recorded)
}

/// lead (handle `lead-h`, launched by `grand-h`) launched dev; grand launched lead.
fn chain(store: &UsageStore) {
    seat(store, "grand", "dev", "grand-h", None, 100);
    seat(store, "lead", "dev", "lead-h", Some("grand-h"), 200);
    seat(store, "dev", "dev", "dev-h", Some("lead-h"), 300);
}

#[test]
fn a_seat_charges_itself_from_now_and_the_charge_keeps_who_charged() {
    let (_d, store) = store();
    chain(&store);
    let got = run(&store, &caller("dev", "dev-h"), params("DEMO-2", None, None)).unwrap();
    assert_eq!(got["sessionId"], "dev");
    assert_eq!(got["fromMs"], NOW);
    let charges = store.charges_for("dev").unwrap();
    assert_eq!(charges.len(), 1);
    let c = &charges[0];
    assert_eq!((c.story_id.as_str(), c.from_ms, c.charged_at_ms), ("DEMO-2", NOW, NOW));
    assert_eq!((c.charged_by.as_deref(), c.charged_by_session.as_str()), (Some("dev-h"), "dev"));
    assert_eq!((c.org.as_deref(), c.team.as_deref()), (Some("acme"), Some("dev")));
}

#[test]
fn the_launcher_and_the_launchers_launcher_may_charge_a_seat() {
    let (_d, store) = store();
    chain(&store);
    run(&store, &caller("lead", "lead-h"), params("DEMO-2", Some("dev"), Some(1_000))).unwrap();
    run(&store, &caller("grand", "grand-h"), params("DEMO-1", Some("dev"), Some(2_000))).unwrap();
    let stories: Vec<_> = store.charges_for("dev").unwrap().into_iter().map(|c| c.story_id).collect();
    assert_eq!(stories, ["DEMO-2", "DEMO-1"]);
}

#[test]
fn a_stranger_of_the_same_team_and_another_teams_seat_are_refused() {
    let (_d, store) = store();
    chain(&store);
    seat(&store, "stranger", "dev", "stranger-h", None, 50);
    let err = run(&store, &caller("stranger", "stranger-h"), params("DEMO-2", Some("dev"), None)).unwrap_err();
    assert!(err.starts_with("invalid:") && err.contains("launch chain"), "{err}");
    seat(&store, "other", "ops", "other-h", Some("lead-h"), 400);
    let err = run(&store, &caller("lead", "lead-h"), params("DEMO-2", Some("other"), None)).unwrap_err();
    assert!(err.contains("another team's"), "{err}");
    assert!(store.charges_for("dev").unwrap().is_empty() && store.charges_for("other").unwrap().is_empty());
}

/// The handler takes the caller from the verified connection; an unbound one has none and is
/// refused before anything is charged.
#[test]
fn an_unbound_caller_has_no_session_to_charge_as() {
    assert!(crate::mcp::local_identity::session(None, None).is_err());
}

#[test]
fn a_handle_reused_after_the_seat_launched_does_not_count() {
    let (_d, store) = store();
    chain(&store);
    // A later seat took the lead's handle after dev launched.
    seat(&store, "lead-again", "dev", "lead-h", None, 500);
    let err = run(&store, &caller("lead-again", "lead-h"), params("DEMO-2", Some("dev"), None)).unwrap_err();
    assert!(err.contains("launch chain"), "{err}");
}

#[test]
fn a_chain_through_a_reused_handle_follows_only_its_earlier_holder() {
    let (_d, store) = store();
    chain(&store);
    seat(&store, "stranger", "dev", "stranger-h", None, 50);
    // A later holder of `lead-h`, launched by the stranger.
    seat(&store, "lead-again", "dev", "lead-h", Some("stranger-h"), 500);
    assert!(run(&store, &caller("stranger", "stranger-h"), params("DEMO-2", Some("dev"), None)).is_err());
    assert!(run(&store, &caller("grand", "grand-h"), params("DEMO-2", Some("dev"), None)).is_ok());
}

#[test]
fn a_remote_caller_charges_its_own_launch_but_not_a_strangers_tab() {
    let (_d, store) = store();
    // The remote tab has no record here; its authority verified its handle and team.
    seat(&store, "launched", "dev", "launched-h", Some("remote-h"), 300);
    seat(&store, "strangers", "dev", "strangers-h", Some("someone-h"), 300);
    let remote = Caller {
        session: "remote-tab".into(),
        handle: Some("remote-h".into()),
        team: Some(("acme".into(), "dev".into())),
    };
    run(&store, &remote, params("DEMO-2", Some("launched"), None)).unwrap();
    let err = run(&store, &remote, params("DEMO-2", Some("strangers"), None)).unwrap_err();
    assert!(err.contains("launch chain"), "{err}");
}

#[test]
fn an_unknown_story_a_tab_with_no_record_and_bad_moments_are_refused() {
    let (_d, mut store) = store();
    chain(&store);
    let me = caller("dev", "dev-h");
    let err = run(&store, &me, params("DEMO-404", None, None)).unwrap_err();
    assert!(err.contains("is not a story of acme/dev"), "{err}");
    let err = run(&store, &me, params("DEMO-2", Some("no-record"), None)).unwrap_err();
    assert!(err.contains("has no session record"), "{err}");
    let err = run(&store, &me, params("DEMO-2", None, Some(NOW + FUTURE_SLACK_MS + 1))).unwrap_err();
    assert!(err.contains("ahead"), "{err}");
    assert!(run(&store, &me, params("DEMO-2", None, Some(NOW + FUTURE_SLACK_MS))).is_ok());
    // dev's record is from 300; its first usage is later, so 299 is before it started.
    store.ingest(&[event("e1", "dev", "gpt-6-sol", 400, Tokens { input: 1, ..Default::default() })]).unwrap();
    let err = run(&store, &me, params("DEMO-2", None, Some(299))).unwrap_err();
    assert!(err.contains("before session dev started"), "{err}");
    assert!(run(&store, &me, params("DEMO-2", None, Some(300))).is_ok());
}

#[test]
fn a_second_charge_at_the_same_moment_replaces_the_story() {
    let (_d, store) = store();
    chain(&store);
    let me = caller("dev", "dev-h");
    run(&store, &me, params("DEMO-1", None, Some(1_000))).unwrap();
    let got = run(&store, &me, params("DEMO-2", None, Some(1_000))).unwrap();
    assert_eq!(got["charges"], json!([{"story": "DEMO-2", "fromMs": 1_000, "chargedBy": "dev-h"}]));
}

#[test]
fn a_story_is_found_only_in_its_own_org_and_team() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("users/1/orgs/acme");
    std::fs::create_dir_all(root.join("dev/content")).unwrap();
    std::fs::create_dir_all(root.join("ops/content")).unwrap();
    std::fs::write(root.join("org.yml"), "").unwrap();
    std::fs::write(
        root.join("dev/content/DEMO-7.md"),
        "---\ntype: story\nstatus: todo\nstory_id: DEMO-7\nsource_repo: acme/app\n---\n\n# Seven\n",
    )
    .unwrap();
    assert!(story_in_team(home.path(), "acme", "dev", "DEMO-7").is_some());
    assert!(story_in_team(home.path(), "acme", "ops", "DEMO-7").is_none());
    assert!(story_in_team(home.path(), "globex", "dev", "DEMO-7").is_none());
    assert!(story_in_team(home.path(), "acme", "dev", "DEMO-8").is_none());
}

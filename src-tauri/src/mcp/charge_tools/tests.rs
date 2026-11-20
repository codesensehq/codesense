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

/// A seat whose record keeps the tab that launched it, as a launch now records.
fn seat_launched_by_tab(store: &UsageStore, tab: &str, handle: &str, launcher: &str, at: i64) {
    let mut r = SessionRecord::new(tab);
    r.org = Some("acme".into());
    r.team = Some("dev".into());
    r.handle = Some(handle.into());
    r.launched_by = Some(format!("{launcher}-handle"));
    r.launched_by_session = Some(launcher.into());
    r.recorded_at_ms = at;
    store.write_session_record(&r).unwrap();
}

fn remote(session: &str, handle: &str) -> Caller {
    Caller { session: session.into(), handle: Some(handle.into()), team: Some(("acme".into(), "dev".into())) }
}

#[test]
fn a_recorded_launcher_tab_is_followed_and_its_handle_is_never_consulted() {
    let (_d, store) = store();
    seat(&store, "grand", "dev", "grand-h", None, 100);
    seat_launched_by_tab(&store, "lead", "lead-h", "grand", 200);
    seat_launched_by_tab(&store, "dev", "dev-h", "lead", 300);
    assert!(run(&store, &caller("lead", "lead-h"), params("DEMO-2", Some("dev"), None)).is_ok());
    assert!(run(&store, &caller("grand", "grand-h"), params("DEMO-2", Some("dev"), Some(1_000))).is_ok());
    // A seat holding the launcher's recorded handle is not the launcher tab.
    seat(&store, "imposter", "dev", "lead-handle", None, 50);
    let err = run(&store, &caller("imposter", "lead-handle"), params("DEMO-2", Some("dev"), None)).unwrap_err();
    assert!(err.contains("launch chain"), "{err}");
}

#[test]
fn a_remote_caller_charges_a_seat_whose_record_names_its_tab_and_a_reused_remote_handle_is_refused() {
    let (_d, store) = store();
    // The remote tab has no record here; its authority verified its tab, handle and team.
    seat_launched_by_tab(&store, "launched", "launched-h", "remote-tab", 300);
    run(&store, &remote("remote-tab", "remote-h"), params("DEMO-2", Some("launched"), None)).unwrap();
    // An earlier remote tab held the same handle and launched this seat: a later holder of the
    // handle may not charge it, whether the seat recorded the earlier tab or only the handle.
    seat_launched_by_tab(&store, "earlier-launch", "e-h", "old-remote-tab", 300);
    seat(&store, "handle-only", "dev", "h-h", Some("remote-h"), 300);
    for target in ["earlier-launch", "handle-only"] {
        let err = run(&store, &remote("remote-tab", "remote-h"), params("DEMO-2", Some(target), None)).unwrap_err();
        assert!(err.contains("launch chain"), "{target}: {err}");
    }
}

#[test]
fn a_launcher_recorded_by_its_tab_counts_only_when_recorded_before_the_seat() {
    let (_d, store) = store();
    // Older records name their launcher's tab in launched_by.
    seat(&store, "grand", "dev", "grand-h", None, 100);
    seat(&store, "lead", "dev", "lead-h", Some("grand"), 200);
    seat(&store, "dev", "dev", "dev-h", Some("lead"), 300);
    assert!(run(&store, &caller("lead", "lead-h"), params("DEMO-2", Some("dev"), None)).is_ok());
    assert!(run(&store, &caller("grand", "grand-h"), params("DEMO-2", Some("dev"), Some(1_000))).is_ok());
    // A tab recorded after the seat did not launch it, and its handle is not tried instead.
    seat(&store, "late", "dev", "late-h", None, 400);
    seat(&store, "early-late-h", "dev", "late-h", None, 50);
    seat(&store, "orphan", "dev", "orphan-h", Some("late"), 300);
    for by in [caller("late", "late-h"), caller("early-late-h", "late-h")] {
        assert!(run(&store, &by, params("DEMO-2", Some("orphan"), None)).is_err(), "{}", by.session);
    }
}

#[test]
fn a_live_launcher_tab_is_read_as_its_handle() {
    let (_d, store) = store();
    seat(&store, "lead", "dev", "lead-h", None, 200);
    // The recorded launcher is a live tab id with no record of its own; the registry knows its handle.
    seat(&store, "dev", "dev", "dev-h", Some("live-tab"), 300);
    let live = |raw: &str| if raw == "live-tab" { "lead-h".to_owned() } else { raw.to_owned() };
    let p = params("DEMO-2", Some("dev"), None);
    assert!(charge(&store, &caller("lead", "lead-h"), &p, NOW, &known, &live).is_ok());
    assert!(charge(&store, &caller("lead", "lead-h"), &p, NOW, &known, &as_recorded).is_err());
}

#[test]
fn a_record_that_took_a_handle_after_the_seat_launched_is_not_its_holder() {
    let (_d, store) = store();
    seat(&store, "lead", "dev", "lead-h", None, 200);
    seat(&store, "dev", "dev", "dev-h", Some("lead-h"), 300);
    // A seat recorded before dev under another handle took `lead-h` only later (now).
    seat(&store, "taker", "dev", "other-h", None, 100);
    seat(&store, "taker", "dev", "lead-h", None, 100);
    let err = run(&store, &caller("taker", "lead-h"), params("DEMO-2", Some("dev"), None)).unwrap_err();
    assert!(err.contains("launch chain"), "{err}");
    assert!(run(&store, &caller("lead", "lead-h"), params("DEMO-2", Some("dev"), None)).is_ok());
}

#[test]
fn a_caller_is_only_its_own_record_never_one_whose_native_id_matches_its_tab() {
    let (_d, store) = store();
    chain(&store);
    // Another team's record whose native id is the caller's tab id.
    let mut other = SessionRecord::new("someone");
    other.native_session_id = Some("caller-tab".into());
    other.org = Some("acme".into());
    other.team = Some("dev".into());
    other.handle = Some("lead-h".into());
    other.recorded_at_ms = 10;
    store.write_session_record(&other).unwrap();
    let err = run(&store, &caller("caller-tab", "x"), params("DEMO-2", Some("dev"), None)).unwrap_err();
    assert!(err.contains("another team's"), "{err}");
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

#[test]
fn a_charge_may_start_at_the_sessions_first_usage_when_it_precedes_its_record() {
    let (_d, mut store) = store();
    chain(&store);
    // dev's record is from 300 and its first usage from 200.
    store.ingest(&[event("e0", "dev", "gpt-6-sol", 200, Tokens { input: 1, ..Default::default() })]).unwrap();
    let me = caller("dev", "dev-h");
    assert!(run(&store, &me, params("DEMO-2", None, Some(250))).is_ok());
    let err = run(&store, &me, params("DEMO-2", None, Some(199))).unwrap_err();
    assert!(err.contains("before session dev started (200"), "{err}");
}

#[test]
fn another_seats_charge_at_the_same_moment_is_not_replaced() {
    let (_d, store) = store();
    chain(&store);
    run(&store, &caller("lead", "lead-h"), params("DEMO-1", Some("dev"), Some(1_000))).unwrap();
    let err = run(&store, &caller("dev", "dev-h"), params("DEMO-2", None, Some(1_000))).unwrap_err();
    assert!(err.contains("was made by lead-h"), "{err}");
    let kept = store.charges_for("dev").unwrap();
    assert_eq!((kept[0].story_id.as_str(), kept[0].charged_by_session.as_str()), ("DEMO-1", "lead"));
    // The seat that made it may replace it; another moment is open to anyone allowed.
    run(&store, &caller("lead", "lead-h"), params("DEMO-2", Some("dev"), Some(1_000))).unwrap();
    run(&store, &caller("dev", "dev-h"), params("DEMO-1", None, Some(1_001))).unwrap();
    assert_eq!(store.charges_for("dev").unwrap().len(), 2);
}

#[test]
fn a_session_has_at_most_the_charge_cap_but_may_still_replace_one() {
    let (_d, store) = store();
    chain(&store);
    let me = caller("dev", "dev-h");
    for n in 0..MAX_CHARGES as i64 {
        run(&store, &me, params("DEMO-1", None, Some(1_000 + n))).unwrap();
    }
    let err = run(&store, &me, params("DEMO-2", None, Some(5_000))).unwrap_err();
    assert!(err.contains("already has 100 charges"), "{err}");
    run(&store, &me, params("DEMO-2", None, Some(1_000))).unwrap();
    assert_eq!(store.charges_for("dev").unwrap().len(), MAX_CHARGES);
}

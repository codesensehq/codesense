// SPDX-License-Identifier: MIT
//! A session's rows name their launch's tab, and a charged session splits into one row per segment.
use super::*;
use crate::session_usage::charge::Charge;
use crate::session_usage::tests::{event, local_noon, store};

fn call(id: &str, session: &str, at_ms: i64, cost: f64) -> UsageEvent {
    let mut e = event(id, session, "gpt-6-sol", at_ms, Tokens { input: 10, output: 1, ..Default::default() });
    e.reported_cost_usd = Some(cost);
    e
}

fn charge_to(store: &UsageStore, tab: &str, story: &str, from_ms: i64) {
    let charge = Charge {
        story_id: story.into(),
        from_ms,
        org: Some("acme".into()),
        team: Some("dev".into()),
        charged_by: Some("lead".into()),
        charged_by_session: "tab-lead".into(),
        charged_at_ms: from_ms,
    };
    store.charge_story(tab, &charge).unwrap();
}

/// A launched tab whose record names `story`, so its uncharged usage resolves to it.
fn launched(store: &UsageStore, tab: &str, story: &str) {
    let mut record = record::SessionRecord::new(tab);
    record.story_id = Some(story.into());
    record.org = Some("acme".into());
    record.team = Some("dev".into());
    store.write_session_record(&record).unwrap();
}

fn report(store: &UsageStore, filter: Filter) -> UsageReport {
    store.report_with(&filter, &mut StoryResolver::default()).unwrap()
}

fn rows_of<'a>(r: &'a UsageReport, session: &str) -> Vec<&'a SessionUsage> {
    r.sessions.iter().filter(|s| s.session_id == session).collect()
}

fn story_of(row: &SessionUsage) -> (Option<&str>, Option<&'static str>) {
    (row.story.as_ref().map(|s| s.id.as_str()), row.story.as_ref().and_then(|s| s.basis))
}

fn segment(from_ms: Option<i64>, to_ms: Option<i64>) -> Option<Segment> {
    Some(Segment { from_ms, to_ms })
}

#[test]
fn a_launched_row_names_its_tab_and_a_native_only_row_names_none() {
    let (_d, mut store) = store();
    let mut record = record::SessionRecord::new("tab-1");
    record.native_session_id = Some("native-1".into());
    store.write_session_record(&record).unwrap();
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "native-1", at, 1.0), call("b", "loose", at, 1.0)]).unwrap();
    let r = report(&store, Filter::default());
    assert_eq!(rows_of(&r, "native-1")[0].tab_session_id.as_deref(), Some("tab-1"));
    assert_eq!(rows_of(&r, "loose")[0].tab_session_id, None, "no launch record, no tab");
    let json = serde_json::to_value(&r).unwrap();
    let loose = json["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == "loose").unwrap();
    assert!(loose["tabSessionId"].is_null() && loose.get("segment").is_none(), "{loose}");
}

#[test]
fn two_native_sessions_of_one_launch_are_two_rows_with_one_tab() {
    let (_d, mut store) = store();
    for native in ["first", "after-clear"] {
        store
            .conn
            .execute(
                "INSERT INTO session_attribution (session_id, org, team, agent, handle, cwd, attributed_at_ms, launch_id)
                 VALUES (?1, 'acme', 'dev', 'builtin/claude', 'h', NULL, 1, 'tab-2')",
                params![native],
            )
            .unwrap();
    }
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "first", at, 1.0), call("b", "after-clear", at + 1, 1.0)]).unwrap();
    let r = report(&store, Filter::default());
    assert_eq!(r.sessions.len(), 2);
    assert!(r.sessions.iter().all(|s| s.tab_session_id.as_deref() == Some("tab-2")), "{:?}", r.sessions);
}

#[test]
fn an_uncharged_session_is_unchanged_when_another_is_charged() {
    let (_d, mut store) = store();
    launched(&store, "plain", "DEMO-1");
    launched(&store, "seat", "DEMO-1");
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "plain", at, 1.0), call("b", "seat", at, 2.0), call("c", "seat", at + 10, 3.0)]).unwrap();
    let plain = |store: &UsageStore| {
        serde_json::to_string(&report(store, Filter { session_id: Some("plain".into()), ..Filter::default() })).unwrap()
    };
    let before = plain(&store);
    charge_to(&store, "seat", "DEMO-2", at + 5);
    assert_eq!(plain(&store), before, "byte for byte");
    let r = report(&store, Filter::default());
    assert_eq!(rows_of(&r, "plain").len(), 1);
    assert_eq!(rows_of(&r, "plain")[0].segment, None);
    assert!(!before.contains("segment"), "{before}");
}

#[test]
fn a_back_dated_charge_splits_a_session_at_its_moment_and_the_segments_add_up_to_the_whole() {
    let (_d, mut store) = store();
    launched(&store, "seat", "DEMO-1");
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "seat", at, 1.0), call("b", "seat", at + 10, 2.0), call("c", "seat", at + 20, 4.0)]).unwrap();
    let whole = report(&store, Filter::default());
    assert_eq!(whole.sessions.len(), 1);
    // Charged after the usage happened, from a moment inside it.
    charge_to(&store, "seat", "DEMO-2", at + 15);
    let split = report(&store, Filter::default());
    let rows = rows_of(&split, "seat");
    assert_eq!(rows.len(), 2);
    let (after, before) = (rows[0], rows[1]);
    assert_eq!(after.segment, segment(Some(at + 15), None));
    assert_eq!(before.segment, segment(None, Some(at + 15)));
    assert_eq!(story_of(after), (Some("DEMO-2"), Some("charged")));
    assert_eq!(story_of(before), (Some("DEMO-1"), None));
    assert_eq!((before.cost_usd, after.cost_usd), (Some(3.0), Some(4.0)));
    assert_eq!((before.messages, after.messages), (2, 1));
    assert_eq!((before.first_at_ms, before.last_at_ms, after.first_at_ms), (at, at + 10, at + 20));
    let mut tokens = before.tokens;
    tokens.add(&after.tokens);
    assert_eq!(tokens, whole.sessions[0].tokens);
    assert_eq!(split.totals.cost_usd, whole.totals.cost_usd);
    assert_eq!((split.totals.priced_sessions, split.session_count), (2, 2), "totals and total count rows");
    assert_eq!(split.days.len(), 1);
    assert_eq!(split.days[0].cost_usd, 7.0);
}

#[test]
fn two_charges_make_three_segments() {
    let (_d, mut store) = store();
    launched(&store, "seat", "DEMO-1");
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "seat", at, 1.0), call("b", "seat", at + 10, 2.0), call("c", "seat", at + 20, 4.0)]).unwrap();
    charge_to(&store, "seat", "DEMO-2", at + 5);
    charge_to(&store, "seat", "DEMO-3", at + 15);
    let r = report(&store, Filter::default());
    let spans: Vec<_> = rows_of(&r, "seat").iter().map(|s| (s.segment, story_of(s).0)).collect();
    assert_eq!(
        spans,
        [
            (segment(Some(at + 15), None), Some("DEMO-3")),
            (segment(Some(at + 5), Some(at + 15)), Some("DEMO-2")),
            (segment(None, Some(at + 5)), Some("DEMO-1")),
        ]
    );
}

#[test]
fn a_charge_back_to_the_first_story_gives_three_rows_and_the_story_filter_sums_both() {
    let (_d, mut store) = store();
    launched(&store, "seat", "DEMO-1");
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "seat", at, 1.0), call("b", "seat", at + 10, 2.0), call("c", "seat", at + 20, 4.0)]).unwrap();
    charge_to(&store, "seat", "DEMO-2", at + 5);
    charge_to(&store, "seat", "DEMO-1", at + 15);
    let all = report(&store, Filter::default());
    assert_eq!(rows_of(&all, "seat").len(), 3);
    let first = report(&store, Filter { story: Some("demo-1".into()), ..Filter::default() });
    assert_eq!(first.sessions.len(), 2);
    assert_eq!((first.totals.cost_usd, first.session_count), (5.0, 2));
    assert_eq!(first.totals.tokens.input, 20);
    let second = report(&store, Filter { story: Some("DEMO-2".into()), ..Filter::default() });
    assert_eq!((second.totals.cost_usd, second.session_count), (2.0, 1));
}

#[test]
fn a_paged_walk_returns_each_segment_once_across_ties_and_a_null_start() {
    let (_d, mut store) = store();
    let at = local_noon(2026, 11, 2);
    // seat: usage at +0 and +10, charged at +15, usage at +20. pair: usage at +5, charged at +8,
    // usage at +10. pair's charged segment and seat's first segment both end at +10.
    store
        .ingest(&[
            call("s1", "seat", at, 1.0),
            call("s2", "seat", at + 10, 1.0),
            call("s3", "seat", at + 20, 1.0),
            call("p1", "pair", at + 5, 1.0),
            call("p2", "pair", at + 10, 1.0),
        ])
        .unwrap();
    charge_to(&store, "seat", "DEMO-2", at + 15);
    charge_to(&store, "pair", "DEMO-2", at + 8);
    let key = |s: &SessionUsage| (s.session_id.clone(), s.segment.and_then(|g| g.from_ms));
    let expected = vec![
        ("seat".to_string(), Some(at + 15)),
        ("pair".to_string(), Some(at + 8)),
        ("seat".to_string(), None),
        ("pair".to_string(), None),
    ];
    assert_eq!(report(&store, Filter::default()).sessions.iter().map(key).collect::<Vec<_>>(), expected);
    for limit in [1, 2, 3] {
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = report(&store, Filter { limit: Some(limit), cursor: cursor.clone(), ..Filter::default() });
            assert_eq!(page.session_count, 4, "total counts every row on every page");
            seen.extend(page.sessions.iter().map(key));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen, expected, "limit {limit}");
    }
}

#[test]
fn a_cursor_from_before_segments_is_refused() {
    let (_d, mut store) = store();
    let at = local_noon(2026, 11, 2);
    store.ingest(&[call("a", "s1", at, 1.0), call("b", "s2", at + 1, 1.0)]).unwrap();
    let page = report(&store, Filter { limit: Some(1), ..Filter::default() });
    let cursor = page.next_cursor.unwrap();
    assert!(cursor.starts_with("v:") && cursor.ends_with(":-:s2"), "{cursor}");
    let old = format!("u:{:x}:{}:s2", cursor_key(&Filter { limit: Some(1), ..Filter::default() }), at + 1);
    let refused = store.report(&Filter { limit: Some(1), cursor: Some(old), ..Filter::default() });
    assert!(refused.unwrap_err().starts_with("invalid:"));
}

#[test]
fn the_charge_table_is_added_without_changing_the_schema_version() {
    let (_d, store) = store();
    let version: i64 = store.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    assert!(has_column(&store.conn, "session_story_charge", "charged_by_session").unwrap());
}

#[test]
fn the_session_statement_finds_charges_by_their_key() {
    let (_d, store) = store();
    let mut stmt = store.conn.prepare(&format!("EXPLAIN QUERY PLAN {}", usage_report_sql(true))).unwrap();
    let plan = stmt
        .query_map(params![None::<String>, None::<String>, Some("[\"s0\"]"), None::<String>], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
        .join("\n");
    assert!(!plan.lines().any(|l| l.contains("SCAN c")), "the charge lookup scans:\n{plan}");
}

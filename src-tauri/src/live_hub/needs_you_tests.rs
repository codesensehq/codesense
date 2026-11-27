// SPDX-License-Identifier: MIT
// The needs-you set on the shared 14:02 fixture, and the merge-card rule on its case table.

use super::*;
use serde_json::Value;

const SAMPLE_DAY: &str = include_str!("../../../tests/fixtures/sample-day-1402.json");
const MERGE_CARD_CASES: &str = include_str!("../../../tests/fixtures/merge-card-cases.json");

fn text(value: &Value, key: &str) -> Option<String> {
    value[key].as_str().map(str::to_string)
}

/// The fixture's live agents and its Inbox, as the hub would hand them over: only cards
/// to the person that still wait on them (needs-you, unread) are inputs.
fn sample_day() -> (Value, NeedsYouInputs) {
    let day: Value = serde_json::from_str(SAMPLE_DAY).unwrap();
    let sessions = day["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["state"] != "ended")
        .map(|a| SessionInput {
            session: text(a, "session").unwrap(),
            org: text(a, "org"),
            team: text(a, "team"),
            work_item: text(a, "workItem"),
            needs_you_kind: text(&a["signals"], "needsYouKind"),
            question: text(&a["signals"], "question"),
            capped: a["capped"] == true,
        })
        .collect();
    let cards = day["inbox"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["to"] == "human" && m["kind"] == "needs-you" && m["read"] == false)
        .map(|m| CardInput {
            message_id: m["messageId"].as_i64().unwrap(),
            from: text(m, "from").unwrap(),
            org: text(m, "org"),
            team: text(m, "team"),
            summary: text(m, "summary"),
            text: text(m, "text").unwrap_or_default(),
        })
        .collect();
    (day, NeedsYouInputs { sessions, cards })
}

fn ids(items: &[NeedsYouItem]) -> Vec<&str> {
    items.iter().map(|i| i.id.as_str()).collect()
}

#[test]
fn the_sample_day_needs_you_four_times_and_never_for_an_fyi() {
    let (day, inputs) = sample_day();
    let set = needs_you(&inputs);
    let expected: Vec<Value> = day["expect"]["needsYou"].as_array().unwrap().clone();
    assert_eq!(set.len(), 4, "{:?}", ids(&set));
    for want in &expected {
        let item = set
            .iter()
            .find(|i| want["id"] == i.id.as_str())
            .unwrap_or_else(|| panic!("missing {}", want["id"]));
        let row = serde_json::to_value(item).unwrap();
        assert_eq!(row["kind"], want["kind"], "{}", item.id);
        assert_eq!(row["session"], want["session"], "{}", item.id);
        if let Some(question) = want.get("question") {
            assert_eq!(&row["question"], question, "{}", item.id);
        }
    }
    let steward = set.iter().find(|i| i.session == "tab-steward-lead");
    assert_eq!(steward, None, "the weekly FYI never counts");
    let question = set.iter().find(|i| i.id == "inbox:9102").unwrap();
    assert_eq!(
        question.question.as_deref(),
        Some("pins per window or per group?")
    );
    assert_eq!(question.work_item.as_deref(), Some("wi_00000000000000a1"));
    assert_eq!(question.team.as_deref(), Some("delivery"));
}

#[test]
fn a_failed_agent_counts_and_an_fyi_about_a_failed_run_does_not() {
    let (_, mut inputs) = sample_day();
    // Overlaid here, never written into the shared fixture.
    let quick_fix = inputs
        .sessions
        .iter_mut()
        .find(|s| s.session == "tab-quick-fix-lead")
        .unwrap();
    quick_fix.needs_you_kind = Some("failed".into());
    let set = needs_you(&inputs);
    assert_eq!(set.len(), 5, "{:?}", ids(&set));
    let failed = set.iter().find(|i| i.kind == NeedsYouKind::Failed).unwrap();
    assert_eq!(failed.id, "agent:tab-quick-fix-lead:failed");

    // A run that failed and only said so in an FYI card: the card is never an input, and
    // its agent is not in a failed state, so the set stays at 4.
    let (_, inputs) = sample_day();
    assert_eq!(needs_you(&inputs).len(), 4);
}

#[test]
fn only_asks_map_in_and_an_agents_own_states_stay_out() {
    let session = |kind: &str| SessionInput {
        session: format!("tab-{kind}"),
        needs_you_kind: Some(kind.into()),
        question: Some("which one?".into()),
        ..Default::default()
    };
    let inputs = NeedsYouInputs {
        sessions: [
            "question",
            "permission",
            "failed",
            "crashed",
            "blocked",
            "attention",
            "startup",
        ]
        .into_iter()
        .map(session)
        .collect(),
        cards: Vec::new(),
    };
    let set = needs_you(&inputs);
    let kinds: Vec<_> = set.iter().map(|i| (i.session.as_str(), i.kind)).collect();
    assert_eq!(
        kinds,
        [
            ("tab-crashed", NeedsYouKind::Failed),
            ("tab-failed", NeedsYouKind::Failed),
            ("tab-permission", NeedsYouKind::Permission),
            ("tab-question", NeedsYouKind::Question),
        ]
    );
    let question = set
        .iter()
        .find(|i| i.kind == NeedsYouKind::Question)
        .unwrap();
    assert_eq!(question.question.as_deref(), Some("which one?"));
}

#[test]
fn a_capped_agent_that_also_asks_is_two_items() {
    let inputs = NeedsYouInputs {
        sessions: vec![SessionInput {
            session: "tab-a".into(),
            needs_you_kind: Some("permission".into()),
            capped: true,
            ..Default::default()
        }],
        cards: Vec::new(),
    };
    assert_eq!(
        ids(&needs_you(&inputs)),
        ["agent:tab-a:capped", "agent:tab-a:permission"]
    );
}

/// The same table the Foreman story view's `kindOf` is tested on.
#[test]
fn card_kind_follows_the_shared_case_table() {
    let table: Value = serde_json::from_str(MERGE_CARD_CASES).unwrap();
    for case in table["cases"].as_array().unwrap() {
        let summary = case["summary"].as_str().filter(|s| !s.is_empty());
        let kind = card_kind(summary, case["text"].as_str().unwrap());
        let want = match case["kind"].as_str().unwrap() {
            "merge" => NeedsYouKind::Merge,
            _ => NeedsYouKind::Question,
        };
        assert_eq!(kind, want, "{}", case["name"]);
    }
}

#[test]
fn a_question_reads_its_summary_else_its_first_line() {
    assert_eq!(question_text(Some("  pick one  "), "body"), "pick one");
    assert_eq!(
        question_text(Some(" "), "\n\n  **Which**   one?\nmore"),
        "Which one?"
    );
    let long = "a".repeat(250);
    let cut = question_text(None, &long);
    assert_eq!(cut.chars().count(), 200);
    assert!(cut.ends_with('…'));
}

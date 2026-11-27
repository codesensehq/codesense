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
            work_item: None,
        })
        .collect();
    (day, NeedsYouInputs { sessions, cards })
}

fn ids(items: &[NeedsYouItem]) -> Vec<&str> {
    items.iter().map(|i| i.id.as_str()).collect()
}

/// An Inbox holding mail to the person, `(team, from, text, kind)`, as the hub loads it. Each
/// team's store numbers its own messages from 1.
fn inbox_with(
    mail: &[(&str, &str, &str, crate::weft::inbox::MessageKind)],
) -> crate::live_hub::inbox::InboxProjection {
    let mut inbox = crate::live_hub::inbox::InboxProjection::default();
    let mut stores = BTreeMap::new();
    for (team, from, text, kind) in mail {
        let (_dir, store) = stores.entry(*team).or_insert_with(|| {
            let dir = tempfile::tempdir().unwrap();
            let store = crate::weft::WeftStore::open(dir.path().join("inbox.sqlite3")).unwrap();
            (dir, store)
        });
        let id = crate::weft::inbox::inbox_insert(
            store, from, "human", text, None, None, None, None, None,
        )
        .unwrap();
        let row = crate::weft::inbox::inbox_get(store, id).unwrap().unwrap();
        let team = crate::commands::dashboard_launch::LaunchTeam {
            org: "acme".into(),
            team: team.to_string(),
        };
        inbox.put(&team, row, *kind);
    }
    inbox
}

/// A reached spend row for `agent`, as `agent_list::spend::rows` writes it.
fn reached(agent: &str) -> Value {
    serde_json::json!({"id": format!("spend:agent:{agent}"), "scopeKind": "agent", "key": agent, "spend": {"state": "reached"}})
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
    let question = set
        .iter()
        .find(|i| i.id == "inbox:acme/delivery/9102")
        .unwrap();
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

    // A run that failed and only said so in an FYI card: its agent is not in a failed state,
    // and the card is no input, so the set stays at 4. Sent as needs-you, the same words count.
    use crate::weft::inbox::MessageKind;
    let said = "The nightly run failed: exit 1. Nothing to do; it retries at 02:00.";
    for (kind, size) in [(MessageKind::Update, 4), (MessageKind::NeedsYou, 5)] {
        let (_, mut inputs) = sample_day();
        let inbox = inbox_with(&[("quick-fix", "tab-quick-fix-lead", said, kind)]);
        inputs.cards.extend(inbox.needs_you_cards());
        let set = needs_you(&inputs);
        assert_eq!(set.len(), size, "{kind:?}: {:?}", ids(&set));
        assert!(
            !set.iter().any(|i| i.kind == NeedsYouKind::Failed),
            "{kind:?}"
        );
    }
}

/// Each team's Inbox numbers its own messages, so two teams' first cards are two items, each
/// in its own team's view.
#[test]
fn two_teams_cards_with_the_same_message_id_stay_two_items() {
    use crate::weft::inbox::MessageKind;
    let inbox = inbox_with(&[
        (
            "delivery",
            "tab-story-431",
            "Which branch?",
            MessageKind::NeedsYou,
        ),
        (
            "steward",
            "tab-steward-lead",
            "Rerun the judge?",
            MessageKind::NeedsYou,
        ),
    ]);
    let inputs = hub_inputs(&[], &[], inbox.needs_you_cards(), &[], &BTreeMap::new());
    let set = needs_you(&inputs);
    assert_eq!(ids(&set), ["inbox:acme/delivery/1", "inbox:acme/steward/1"]);
    // Each team's counts row says the same: its senders' cards in the set.
    for (team, sender) in [
        ("delivery", "tab-story-431"),
        ("steward", "tab-steward-lead"),
    ] {
        let launch = crate::commands::dashboard_launch::LaunchTeam {
            org: "acme".into(),
            team: team.into(),
        };
        let own: Vec<_> = set
            .iter()
            .filter(|i| i.team.as_deref() == Some(team))
            .cloned()
            .collect();
        assert_eq!(
            inbox.counts(&launch)["needsYouBySender"],
            serde_json::to_value(cards_by_sender(&own)).unwrap(),
            "{team}"
        );
        assert_eq!(
            inbox.counts(&launch)["needsYouBySender"][sender],
            1,
            "{team}"
        );
    }
    let mut hub = crate::live_hub::projection::TopicRegistry::default();
    publish(&mut hub, &inputs);
    for (view, question) in [
        ("team:acme/delivery", "Which branch?"),
        ("team:acme/steward", "Rerun the judge?"),
    ] {
        let rows = hub.snapshot(TOPIC, view).unwrap().snapshot;
        let questions: Vec<_> = rows.iter().map(|r| r["question"].clone()).collect();
        assert_eq!(questions, [question], "{view}");
    }
}

/// An agent that ended failed or crashed stays until its mark is dismissed: `dismiss_agent_mark`
/// clears the session's `needsYouKind`, and the item goes. An ended agent asks nothing else, and
/// a card from it keeps its work item.
#[test]
fn an_ended_agent_stays_while_it_is_marked_failed() {
    use crate::live_hub::inbox_gate_tests::row;
    use crate::mcp::session_list::SessionState;
    let rows: Vec<_> = ["failed", "crashed", "dismissed", "asked"]
        .into_iter()
        .map(|handle| {
            let mut row = row(handle, handle, SessionState::Exited);
            row.agent = Some(format!("{handle}-agent"));
            row
        })
        .collect();
    let wire = |needs: Option<&str>| {
        rows.iter()
            .map(|row| {
                let kind = match row.handle.as_str() {
                    "failed" | "crashed" => needs.map(|_| row.handle.clone()),
                    "asked" => Some("question".into()),
                    _ => None,
                };
                serde_json::json!({"id": row.session, "alive": false, "needsYouKind": kind, "pendingAsk": "which one?"})
            })
            .collect::<Vec<_>>()
    };
    let spend: Vec<_> = rows
        .iter()
        .map(|row| reached(row.agent.as_deref().unwrap()))
        .collect();
    let work_items = BTreeMap::from([("dismissed".to_string(), "wi_00000000000000d1".to_string())]);
    let card = CardInput {
        message_id: 3,
        from: "dismissed".into(),
        org: Some("acme".into()),
        team: Some("default".into()),
        summary: Some("ship it?".into()),
        text: "Ship it?".into(),
        work_item: None,
    };
    let marked = needs_you(&hub_inputs(
        &rows,
        &wire(Some("marked")),
        vec![card.clone()],
        &spend,
        &work_items,
    ));
    assert_eq!(
        ids(&marked),
        [
            "agent:tab-crashed:failed",
            "agent:tab-failed:failed",
            "inbox:acme/default/3"
        ]
    );
    assert_eq!(marked[2].session, "tab-dismissed");
    assert_eq!(marked[2].work_item.as_deref(), Some("wi_00000000000000d1"));
    let dismissed = needs_you(&hub_inputs(
        &rows,
        &wire(None),
        vec![card],
        &spend,
        &work_items,
    ));
    assert_eq!(ids(&dismissed), ["inbox:acme/default/3"]);
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

/// What one recompute publishes: per view, the ids it upserts and removes.
fn publish(
    hub: &mut crate::live_hub::projection::TopicRegistry,
    inputs: &NeedsYouInputs,
) -> Vec<(String, Vec<String>, Vec<String>)> {
    hub.replace(TOPIC, rows(&needs_you(inputs)), None)
        .unwrap()
        .into_iter()
        .filter(|d| !d.upserts.is_empty() || !d.removes.is_empty())
        .map(|d| {
            let upserts = d
                .upserts
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_string());
            (d.view_key, upserts.collect(), d.removes)
        })
        .collect()
}

/// Each kind shows in the next recompute and clears in the one after, in the `all` view
/// and its own team's view only; a launch that changes nobody's needs-you state, or a
/// recompute with nothing changed, publishes nothing.
#[test]
fn the_topic_patches_each_change_in_its_own_place_and_nothing_else() {
    let mut hub = crate::live_hub::projection::TopicRegistry::default();
    let (_, mut inputs) = sample_day();
    publish(&mut hub, &inputs);
    let views = ["all", "team:acme/delivery", "team:acme/steward"];
    let sizes: Vec<_> = views
        .iter()
        .map(|key| hub.snapshot(TOPIC, key).unwrap().snapshot.len())
        .collect();
    assert_eq!(sizes, [4, 4, 0]);
    assert!(publish(&mut hub, &inputs).is_empty(), "nothing changed");

    let at = |id: &str| {
        vec![
            ("all".to_string(), vec![id.to_string()], vec![]),
            (
                "team:acme/steward".to_string(),
                vec![id.to_string()],
                vec![],
            ),
        ]
    };
    let gone = |id: &str| {
        vec![
            ("all".to_string(), vec![], vec![id.to_string()]),
            (
                "team:acme/steward".to_string(),
                vec![],
                vec![id.to_string()],
            ),
        ]
    };
    type Change = fn(&mut NeedsYouInputs, bool);
    let cases: [(&str, Change); 4] = [
        ("inbox:acme/steward/9201", |inputs, on| {
            inputs.cards.retain(|c| c.message_id != 9201);
            if on {
                inputs.cards.push(CardInput {
                    message_id: 9201,
                    from: "tab-steward-lead".into(),
                    org: Some("acme".into()),
                    team: Some("steward".into()),
                    summary: Some("rerun the judge?".into()),
                    text: "Rerun the weekly judge?".into(),
                    work_item: None,
                });
            }
        }),
        ("agent:tab-steward-lead:permission", |inputs, on| {
            let s = inputs
                .sessions
                .iter_mut()
                .find(|s| s.session == "tab-steward-lead");
            s.unwrap().needs_you_kind = on.then(|| "permission".into());
        }),
        ("agent:tab-steward-lead:capped", |inputs, on| {
            let s = inputs
                .sessions
                .iter_mut()
                .find(|s| s.session == "tab-steward-lead");
            s.unwrap().capped = on;
        }),
        ("agent:tab-steward-lead:failed", |inputs, on| {
            let s = inputs
                .sessions
                .iter_mut()
                .find(|s| s.session == "tab-steward-lead");
            s.unwrap().needs_you_kind = on.then(|| "failed".into());
        }),
    ];
    for (id, change) in cases {
        change(&mut inputs, true);
        assert_eq!(publish(&mut hub, &inputs), at(id), "{id} added");
        change(&mut inputs, false);
        assert_eq!(publish(&mut hub, &inputs), gone(id), "{id} cleared");
    }

    // Another team's agent launched (minting its work item) with no ask of its own.
    inputs.sessions.push(SessionInput {
        session: "tab-new".into(),
        org: Some("acme".into()),
        team: Some("quick-fix".into()),
        work_item: Some("wi_00000000000000e5".into()),
        ..Default::default()
    });
    assert!(
        publish(&mut hub, &inputs).is_empty(),
        "a quiet launch is no delta"
    );
}

/// On the 14:02 fixture, the published rows and `codesense_overview` hold the same 4 ids.
#[test]
fn the_overview_and_the_topic_hold_the_same_set() {
    let (day, inputs) = sample_day();
    let published: Vec<Value> = rows(&needs_you(&inputs))
        .into_iter()
        .map(|(_, r)| r)
        .collect();
    let mut expected: Vec<&str> = day["expect"]["needsYou"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    expected.sort_unstable();
    let ids: Vec<&str> = published
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, expected);

    let sessions = day["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| serde_json::json!({"handle": a["handle"], "sessionId": a["session"], "displayName": a["name"], "state": a["state"]}))
        .collect();
    let overview = crate::mcp::overview::compose(&crate::mcp::overview::OverviewInputs {
        generated_at: "2026-11-15T14:02:00Z".into(),
        active: None,
        sessions: Ok(sessions),
        needs_you: Ok(published),
        machines: Ok(vec![]),
        agents: Ok(vec![]),
        routines: Ok(vec![]),
        human_unread: Ok(0),
        roles: Ok(vec![]),
        layouts: Ok(vec![]),
        docs_root: None,
        docs_version: Err("not read here".into()),
    });
    assert_eq!(overview["needsYou"]["total"], 4);
    assert_eq!(
        overview["needsYou"]["byKind"],
        serde_json::json!({"capped":1,"merge":1,"permission":1,"question":1})
    );
    let waiting: Vec<&str> = overview["sessions"]["needsYou"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["handle"].as_str().unwrap())
        .collect();
    assert_eq!(
        waiting,
        ["story-431", "design-431", "architect-431", "story-418"]
    );
}

/// What one hub recompute after a session or viewer event publishes, as `rebuild` runs it:
/// the roster resolved against the viewer, `sessions` replaced, then the agent views and the
/// set. One entry per delta that says anything: topic, view, upserted ids, removed ids.
fn recompute(
    hub: &crate::live_hub::LiveHub,
    viewer: &Value,
    roster: &[Value],
) -> Vec<(String, String, Vec<String>, Vec<String>)> {
    use crate::live_hub::{agent_list, projection::TopicRegistry};
    let live = crate::mcp::terminal_tabs::LiveTabs {
        tabs: vec![],
        offline: vec![],
        live: vec![],
        labels: Default::default(),
        activity: vec![],
    };
    let mut resolved = agent_list::resolve(
        viewer,
        roster.to_vec(),
        &live,
        serde_json::json!({}),
        &serde_json::json!({}),
        &Default::default(),
        &Default::default(),
        agent_list::home_team(viewer, "acme:delivery".into()),
        None,
        &|_| None,
    );
    let wire =
        agent_list::sessions::project(&resolved.sessions, &[], &mut resolved.rows, &hub.providers);
    let mut model = hub.model.lock().unwrap();
    model.agent_home_team = resolved.home_team;
    model.agent_team_order = resolved.team_order;
    model.agent_pane = resolved.pane;
    model.agent_rows = resolved.rows;
    let mut deltas =
        TopicRegistry::replace(&mut model.projections, "sessions", wire, None).unwrap();
    deltas.extend(crate::live_hub::project_agent_views(&mut model).unwrap());
    deltas
        .into_iter()
        .filter(|d| !d.upserts.is_empty() || !d.removes.is_empty())
        .map(|d| {
            let upserts = d
                .upserts
                .iter()
                .map(|r| r["id"].as_str().unwrap().to_string());
            (d.topic, d.view_key, upserts.collect(), d.removes)
        })
        .collect()
}

/// With the lead capped, so the set holds an item: opening another team's workspace patches
/// only the agent list's state row, a doc tab opened there patches nothing, and launching one
/// agent there (minting its work item) patches only that agent's `sessions` and `agentList`
/// rows: `needsYou` emits nothing, in `all` or in the lead's team's view.
#[test]
fn another_teams_workspace_doc_and_quiet_launch_patch_only_their_own_rows() {
    use crate::live_hub::inbox_gate_tests::row;
    use crate::mcp::session_list::SessionState;
    let hub = crate::live_hub::LiveHub::default();
    {
        let mut model = hub.model.lock().unwrap();
        model.agent_views.insert("all".into());
        model.agent_views.insert("team:acme/delivery".into());
        let mut lead = row("lead", "Lead", SessionState::Running);
        lead.agent = Some("lead-agent".into());
        model.rows = vec![lead];
        model.spend_rows = vec![reached("lead-agent")];
    }
    let mut viewer = serde_json::json!({
        "openedTeams": ["acme:delivery"],
        "workspaces": {
            "acme:delivery": [{"id": "d", "kind": "generic", "status": "ready", "cwd": "/d"}]
        }
    });
    let mut roster = vec![serde_json::json!({
        "handle": "lead", "sessionId": "tab-lead", "kind": "dashboard-launched",
        "alive": true, "workspace": "/d"
    })];
    recompute(&hub, &viewer, &roster);
    // A subscriber holds the lead's team's view of the set, which holds the cap.
    for view in ["all", "team:acme/default"] {
        let held = hub.needs_you_rows(view).unwrap();
        let held: Vec<_> = held.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(held, ["agent:tab-lead:capped"], "{view}");
    }
    assert!(
        recompute(&hub, &viewer, &roster).is_empty(),
        "nothing changed"
    );

    // Another team's workspace opens beside this one.
    viewer["openedTeams"] = serde_json::json!(["acme:delivery", "acme:quick-fix"]);
    viewer["workspaces"]["acme:quick-fix"] =
        serde_json::json!([{"id": "q", "kind": "generic", "status": "ready", "cwd": "/q"}]);
    let opened = recompute(&hub, &viewer, &roster);
    assert!(
        opened
            .iter()
            .all(|(topic, _, upserts, removes)| topic == "agentList"
                && upserts.iter().all(|id| id == "agentList:state")
                && removes.is_empty()),
        "only the agent list's state row moves: {opened:?}"
    );

    // A doc tab opened in that team's workspace reaches no hub row.
    viewer["openTabs"] = serde_json::json!({
        "acme:quick-fix": [{"path": "content/plan.md", "name": "plan.md"}]
    });
    viewer["activeTab"] = serde_json::json!({"acme:quick-fix": "content/plan.md"});
    let doc = recompute(&hub, &viewer, &roster);
    assert!(
        doc.is_empty(),
        "sessions, agentList and needsYou stay silent: {doc:?}"
    );

    // One agent launched there, minting its work item, with no ask of its own.
    roster.push(serde_json::json!({
        "handle": "fixer", "sessionId": "tab-fixer", "kind": "dashboard-launched",
        "alive": true, "workspace": "/q"
    }));
    {
        let mut model = hub.model.lock().unwrap();
        model
            .rows
            .push(row("fixer", "Fixer", SessionState::Running));
        model
            .work_items
            .insert("fixer".into(), "wi_00000000000000e6".into());
    }
    let launched = recompute(&hub, &viewer, &roster);
    assert!(
        !launched.iter().any(|(topic, ..)| topic == TOPIC),
        "needsYou emits nothing: {launched:?}"
    );
    let sessions: Vec<_> = launched
        .iter()
        .filter(|(topic, ..)| topic == "sessions")
        .collect();
    assert_eq!(
        sessions,
        [&(
            "sessions".to_string(),
            "all".to_string(),
            vec!["tab-fixer".to_string()],
            vec![]
        )]
    );
    let model = hub.model.lock().unwrap();
    let fixer = Iterator::find(&mut model.agent_rows.iter(), |r| {
        r.session_ref == "tab-fixer"
    })
    .unwrap()
    .id
    .clone();
    let agent_list: Vec<_> = launched
        .iter()
        .filter(|(topic, ..)| topic == "agentList")
        .map(|(_, view, upserts, removes)| {
            let rows: Vec<_> = upserts
                .iter()
                .filter(|id| *id != "agentList:state")
                .cloned()
                .collect();
            (view.as_str(), rows, removes.len())
        })
        .collect();
    assert_eq!(agent_list, [("all", vec![fixer], 0)], "{launched:?}");
}

/// Spend and Inbox events reach the topic through the hub. A reached cap and then a card from
/// the agent each upsert one item, placed by the agent's team and work item. Another team's card
/// stays out of this team's view, which is all a team's agent reads of the set.
#[test]
fn spend_and_inbox_events_upsert_the_set_through_the_hub() {
    use crate::live_hub::inbox_gate_tests::row;
    use crate::mcp::session_list::SessionState;
    use crate::weft::inbox::MessageKind;
    let hub = crate::live_hub::LiveHub::default();
    assert!(
        hub.needs_you_rows("all").is_err(),
        "unprojected is not empty"
    );
    {
        let mut model = hub.model.lock().unwrap();
        let mut lead = row("lead", "Lead", SessionState::Running);
        lead.agent = Some("lead-agent".into());
        model.rows = vec![lead];
        model
            .work_items
            .insert("lead".into(), "wi_00000000000000a1".into());
    }
    let viewer = serde_json::json!({"openedTeams": ["acme:default"]});
    let roster = [serde_json::json!({
        "handle": "lead", "sessionId": "tab-lead", "kind": "dashboard-launched", "alive": true
    })];
    recompute(&hub, &viewer, &roster);
    assert_eq!(hub.needs_you_rows("all").unwrap(), Vec::<Value>::new());
    hub.needs_you_rows("team:acme/default").unwrap();

    let needs = |deltas: Vec<crate::live_hub::projection::Delta>| {
        deltas
            .into_iter()
            .filter(|d| d.topic == TOPIC && !d.upserts.is_empty())
            .map(|d| {
                let mut ids: Vec<_> = d
                    .upserts
                    .iter()
                    .map(|r| r["id"].as_str().unwrap().to_string())
                    .collect();
                ids.sort();
                (d.view_key, ids)
            })
            .collect::<Vec<_>>()
    };
    let both = |ids: &[&str], own: &[&str]| {
        vec![
            (
                "all".to_string(),
                ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ),
            (
                "team:acme/default".to_string(),
                own.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            ),
        ]
    };
    let mut model = hub.model.lock().unwrap();
    let capped = crate::live_hub::apply_spend(&mut model, vec![reached("lead-agent")]);
    let capped = capped.unwrap().expect("new spend rows recompute");
    let cap = ["agent:tab-lead:capped"];
    assert_eq!(needs(capped), both(&cap, &cap));
    let again = crate::live_hub::apply_spend(&mut model, vec![reached("lead-agent")]);
    assert!(
        again.unwrap().is_none(),
        "unchanged spend recomputes nothing"
    );

    model.inbox = std::sync::Arc::new(inbox_with(&[
        ("default", "lead", "Which branch?", MessageKind::NeedsYou),
        (
            "steward",
            "tab-steward-lead",
            "Rerun the judge?",
            MessageKind::NeedsYou,
        ),
    ]));
    let carded = crate::live_hub::project_agent_views(&mut model).unwrap();
    assert_eq!(
        needs(carded),
        both(
            &["inbox:acme/default/1", "inbox:acme/steward/1"],
            &["inbox:acme/default/1"]
        )
    );
    drop(model);
    let own = hub.needs_you_rows("team:acme/default").unwrap();
    let card = own
        .iter()
        .find(|r| r["id"] == "inbox:acme/default/1")
        .unwrap();
    assert_eq!(card["session"], "tab-lead");
    assert_eq!(card["workItem"], "wi_00000000000000a1");
    assert_eq!(card["question"], "Which branch?");
    assert!(
        !own.iter().any(|r| r["team"] == "steward"),
        "another team's question stays out: {own:?}"
    );
    assert_eq!(hub.needs_you_rows("all").unwrap().len(), 3);
}

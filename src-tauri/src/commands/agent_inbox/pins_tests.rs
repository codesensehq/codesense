// SPDX-License-Identifier: MIT
use std::sync::Arc;

use super::super::tests::{launch_team, port, sent_id, FakeHost};
use super::*;
use crate::weft::pins::{PinStatus, ThreadKey};

const AGENT: &str = "acme/default/claude-dev";

fn thread(story: Option<&str>) -> ThreadKey {
    ThreadKey::new(AGENT, story).unwrap()
}

async fn mail(fake: &Arc<FakeHost>, from: &str, to: &str, text: &str) -> i64 {
    sent_id(
        super::super::send_message(
            &port(fake),
            Some(from),
            to,
            text,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap(),
    )
}

fn listed(result: &PinResult) -> Vec<i64> {
    match result {
        PinResult::Pins { list, .. } => list.pins.iter().map(|p| p.message_id).collect(),
        other => panic!("expected pins, got {other:?}"),
    }
}

fn outcome(result: &PinResult) -> Option<PinOutcome> {
    match result {
        PinResult::Pins { outcome, .. } => *outcome,
        other => panic!("expected pins, got {other:?}"),
    }
}

async fn human(fake: &Arc<FakeHost>, story: Option<&str>, op: PinOp) -> PinResult {
    pins_from_human(&**fake, &launch_team("default"), AGENT, story, op)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_person_pins_unpins_and_reorders_and_each_change_fires_once() {
    let fake = FakeHost::new();
    let a = mail(&fake, "S1", "human", "view a").await;
    let b = mail(&fake, "S1", "human", "view b").await;
    let story = Some("DEMO-1");
    let pinned = human(
        &fake,
        story,
        PinOp::Pin {
            message_id: a,
            position: None,
            preview: None,
        },
    )
    .await;
    assert_eq!(outcome(&pinned), Some(PinOutcome::Pinned));
    human(
        &fake,
        story,
        PinOp::Pin {
            message_id: b,
            position: Some(0),
            preview: None,
        },
    )
    .await;
    let reordered = human(
        &fake,
        story,
        PinOp::Reorder {
            message_ids: vec![a, b],
        },
    )
    .await;
    assert_eq!(listed(&reordered), vec![a, b]);
    assert_eq!(outcome(&reordered), None);
    let again = human(
        &fake,
        story,
        PinOp::Pin {
            message_id: a,
            position: None,
            preview: None,
        },
    )
    .await;
    assert_eq!(outcome(&again), Some(PinOutcome::Unchanged));
    let read = human(&fake, story, PinOp::Read).await;
    assert_eq!(listed(&read), vec![a, b]);
    let unpinned = human(&fake, story, PinOp::Unpin { message_id: a }).await;
    assert_eq!(outcome(&unpinned), Some(PinOutcome::Unpinned));
    assert_eq!(listed(&unpinned), vec![b]);
    // pin, pin, reorder, unpin: an unchanged pin and the read fire nothing.
    let events = fake.pin_events();
    assert_eq!(events.len(), 4, "{events:?}");
    assert!(events
        .iter()
        .all(|(team, t)| team == "default" && *t == thread(story)));
    match &read {
        PinResult::Pins { list, .. } => {
            assert_eq!((list.org.as_str(), list.team.as_str()), ("acme", "default"));
            assert_eq!(
                (list.agent_id.as_str(), list.story_id.as_str()),
                (AGENT, "DEMO-1")
            );
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_refused_write_reports_invalid_and_fires_nothing() {
    let fake = FakeHost::new();
    let a = mail(&fake, "S1", "human", "view").await;
    let refused = human(
        &fake,
        None,
        PinOp::Pin {
            message_id: 999,
            position: None,
            preview: None,
        },
    )
    .await;
    assert!(matches!(&refused, PinResult::Invalid { message } if message.contains("no message")));
    human(
        &fake,
        None,
        PinOp::Pin {
            message_id: a,
            position: None,
            preview: None,
        },
    )
    .await;
    let bad = human(
        &fake,
        None,
        PinOp::Reorder {
            message_ids: vec![a, a],
        },
    )
    .await;
    assert!(matches!(bad, PinResult::Invalid { .. }), "{bad:?}");
    let blank = pins_from_human(&*fake, &launch_team("default"), " ", None, PinOp::Read)
        .await
        .unwrap();
    assert!(matches!(blank, PinResult::Invalid { .. }));
    assert_eq!(fake.pin_events().len(), 1);
}

#[tokio::test]
async fn an_agent_pins_into_its_own_thread_and_a_page_reads_the_same_list() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    let view = mail(&fake, "S1", "human", "a live view").await;
    let pinned = pin_request(&*fake, Some("S1"), view, None, None, false)
        .await
        .unwrap();
    assert_eq!(outcome(&pinned), Some(PinOutcome::Pinned));
    assert_eq!(
        listed(&human(&fake, Some("DEMO-1"), PinOp::Read).await),
        vec![view]
    );
    // Its other threads (another story) stay empty.
    assert!(listed(&human(&fake, Some("DEMO-2"), PinOp::Read).await).is_empty());
    assert_eq!(
        fake.pin_events(),
        vec![("default".to_string(), thread(Some("DEMO-1")))]
    );
    let removed = pin_request(&*fake, Some("S1"), view, None, None, true)
        .await
        .unwrap();
    assert_eq!(outcome(&removed), Some(PinOutcome::Unpinned));
    assert!(listed(&human(&fake, Some("DEMO-1"), PinOp::Read).await).is_empty());
}

#[tokio::test]
async fn every_session_of_the_same_agent_and_story_shares_one_thread() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    fake.launched_from("H2", AGENT, Some("DEMO-1"));
    let first = mail(&fake, "S1", "human", "first").await;
    let second = mail(&fake, "S2", "human", "second").await;
    pin_request(&*fake, Some("S1"), first, None, None, false)
        .await
        .unwrap();
    let both = pin_request(&*fake, Some("S2"), second, Some(0), None, false)
        .await
        .unwrap();
    assert_eq!(listed(&both), vec![second, first]);
}

#[tokio::test]
async fn a_successor_on_a_new_revision_continues_the_thread_and_other_stories_do_not() {
    let fake = FakeHost::new();
    fake.launched_from("H1", "acme/default/claude-dev@3", Some("DEMO-1"));
    fake.launched_from("H2", "acme/default/claude-dev@4", Some("DEMO-1"));
    fake.launched_from("H3", "acme/default/claude-dev@4", Some("DEMO-2"));
    fake.launched_from("H4", "acme/default/claude-dev@4", None);
    let first = mail(&fake, "S1", "human", "first").await;
    let second = mail(&fake, "S2", "human", "second").await;
    let other_story = mail(&fake, "S3", "human", "other story").await;
    let ad_hoc = mail(&fake, "S4", "human", "ad hoc").await;
    for (session, id) in [
        ("S1", first),
        ("S2", second),
        ("S3", other_story),
        ("S4", ad_hoc),
    ] {
        pin_request(&*fake, Some(session), id, None, None, false)
            .await
            .unwrap();
    }
    // The page opens the thread by the agent as saved, with or without a revision.
    for agent in [AGENT, "acme/default/claude-dev@4"] {
        let read =
            |story| pins_from_human(&*fake, &launch_team("default"), agent, story, PinOp::Read);
        assert_eq!(
            listed(&read(Some("DEMO-1")).await.unwrap()),
            vec![first, second]
        );
        assert_eq!(
            listed(&read(Some("DEMO-2")).await.unwrap()),
            vec![other_story]
        );
        assert_eq!(listed(&read(None).await.unwrap()), vec![ad_hoc]);
    }
}

#[tokio::test]
async fn an_unbound_caller_one_with_no_saved_agent_or_mail_it_is_not_party_to_is_refused() {
    let fake = FakeHost::new();
    fake.tab("H3", "S3", "Third", true);
    fake.launched_from("H3", AGENT, Some("DEMO-1"));
    let view = mail(&fake, "S1", "human", "view").await;
    let unbound = pin_request(&*fake, None, view, None, None, false)
        .await
        .unwrap();
    assert!(
        matches!(&unbound, PinResult::Invalid { message } if message.contains("running session"))
    );
    let stranger = pin_request(&*fake, Some("S9"), view, None, None, false)
        .await
        .unwrap();
    assert!(
        matches!(stranger, PinResult::Invalid { .. }),
        "{stranger:?}"
    );
    let no_agent = pin_request(&*fake, Some("S2"), view, None, None, false)
        .await
        .unwrap();
    assert!(matches!(&no_agent, PinResult::Invalid { message } if message.contains("saved Agent")));
    let not_party = pin_request(&*fake, Some("S3"), view, None, None, false)
        .await
        .unwrap();
    assert!(matches!(&not_party, PinResult::Invalid { message } if message.contains("no message")));
    assert!(fake.pin_events().is_empty());
    assert!(listed(&human(&fake, Some("DEMO-1"), PinOp::Read).await).is_empty());
}

#[tokio::test]
async fn an_agent_sends_a_preview_with_its_pin_and_a_fourth_pin_is_refused() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    let views = [
        mail(&fake, "S1", "human", "qa").await,
        mail(&fake, "S1", "human", "rounds").await,
        mail(&fake, "S1", "human", "checks").await,
        mail(&fake, "S1", "human", "spend").await,
    ];
    let preview = |value: &str| PinPreview {
        short_name: Some("QA".into()),
        value: Some(value.into()),
        status: Some(PinStatus::Running),
        ..PinPreview::default()
    };
    pin_request(
        &*fake,
        Some("S1"),
        views[0],
        None,
        Some(preview("4 of 5")),
        false,
    )
    .await
    .unwrap();
    let updated = pin_request(
        &*fake,
        Some("S1"),
        views[0],
        None,
        Some(preview("5 of 5")),
        false,
    )
    .await
    .unwrap();
    assert_eq!(outcome(&updated), Some(PinOutcome::Updated));
    match human(&fake, Some("DEMO-1"), PinOp::Read).await {
        PinResult::Pins { list, .. } => {
            assert_eq!(list.pins[0].preview, Some(preview("5 of 5")));
        }
        other => panic!("{other:?}"),
    }
    // The preview update tells pages too.
    assert_eq!(fake.pin_events().len(), 2);

    for view in &views[1..3] {
        pin_request(&*fake, Some("S1"), *view, None, None, false)
            .await
            .unwrap();
    }
    let fourth = pin_request(&*fake, Some("S1"), views[3], None, None, false)
        .await
        .unwrap();
    // The refusal says which pins the thread holds, so the agent can pick one to unpin.
    let held = format!("Pinned now: {} (QA), {}, {}", views[0], views[1], views[2]);
    assert!(
        matches!(&fourth, PinResult::Invalid { message }
            if message.contains("at most 3") && message.contains(&held)),
        "{fourth:?}"
    );
    let bad = pin_request(
        &*fake,
        Some("S1"),
        views[0],
        None,
        Some(PinPreview {
            lines: vec!["1".into(), "2".into(), "3".into(), "4".into()],
            ..PinPreview::default()
        }),
        false,
    )
    .await
    .unwrap();
    assert!(matches!(bad, PinResult::Invalid { .. }), "{bad:?}");
    assert_eq!(fake.pin_events().len(), 4);
}

#[test]
fn the_change_event_payload_names_the_team_and_thread() {
    let payload =
        serde_json::to_value(PinsChanged::new(&launch_team("default"), &thread(None))).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"org":"acme","team":"default","agentId":AGENT,"storyId":""})
    );
}

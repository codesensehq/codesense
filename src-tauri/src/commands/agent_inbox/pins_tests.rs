// SPDX-License-Identifier: MIT
use std::sync::Arc;

use super::super::tests::{launch_team, port, sent_id, FakeHost};
use super::*;
use crate::weft::pins::ThreadKey;

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
    let pinned = pin_request(&*fake, Some("S1"), view, None, false)
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
    let removed = pin_request(&*fake, Some("S1"), view, None, true)
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
    pin_request(&*fake, Some("S1"), first, None, false)
        .await
        .unwrap();
    let both = pin_request(&*fake, Some("S2"), second, Some(0), false)
        .await
        .unwrap();
    assert_eq!(listed(&both), vec![second, first]);
}

#[tokio::test]
async fn an_unbound_caller_one_with_no_saved_agent_or_mail_it_is_not_party_to_is_refused() {
    let fake = FakeHost::new();
    fake.tab("H3", "S3", "Third", true);
    fake.launched_from("H3", AGENT, Some("DEMO-1"));
    let view = mail(&fake, "S1", "human", "view").await;
    let unbound = pin_request(&*fake, None, view, None, false).await.unwrap();
    assert!(
        matches!(&unbound, PinResult::Invalid { message } if message.contains("running session"))
    );
    let stranger = pin_request(&*fake, Some("S9"), view, None, false)
        .await
        .unwrap();
    assert!(
        matches!(stranger, PinResult::Invalid { .. }),
        "{stranger:?}"
    );
    let no_agent = pin_request(&*fake, Some("S2"), view, None, false)
        .await
        .unwrap();
    assert!(matches!(&no_agent, PinResult::Invalid { message } if message.contains("saved Agent")));
    let not_party = pin_request(&*fake, Some("S3"), view, None, false)
        .await
        .unwrap();
    assert!(matches!(&not_party, PinResult::Invalid { message } if message.contains("no message")));
    assert!(fake.pin_events().is_empty());
    assert!(listed(&human(&fake, Some("DEMO-1"), PinOp::Read).await).is_empty());
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

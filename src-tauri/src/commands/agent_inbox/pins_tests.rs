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
    // The agent's Undo: its unpinned pin comes back.
    let restored = pin_request(&*fake, Some("S1"), view, None, None, PinChange::Restore)
        .await
        .unwrap();
    assert_eq!(outcome(&restored), Some(PinOutcome::Restored));
    assert_eq!(
        listed(&human(&fake, Some("DEMO-1"), PinOp::Read).await),
        vec![view]
    );
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
async fn a_successor_pins_its_predecessors_mail_and_a_concurrent_seat_pins_only_its_own() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    fake.launched_from("H2", "acme/default/claude-dev@4", Some("DEMO-1"));
    let first = mail(&fake, "S1", "human", "from the first session").await;
    let second = mail(&fake, "S2", "human", "from the second session").await;
    // Two seats run at once: neither pins the other's mail.
    let other_seat = pin_request(&*fake, Some("S2"), first, None, None, false)
        .await
        .unwrap();
    assert!(matches!(&other_seat, PinResult::Invalid { message } if message.contains("no message")));
    // Once the first has ended, its successor's thread holds its mail: the successor pins it.
    fake.end("H1");
    let pinned = pin_request(&*fake, Some("S2"), first, None, None, false)
        .await
        .unwrap();
    assert_eq!(listed(&pinned), vec![first]);
    let both = pin_request(&*fake, Some("S2"), second, None, None, false)
        .await
        .unwrap();
    assert_eq!(listed(&both), vec![first, second]);
}

#[tokio::test]
async fn every_seat_reads_what_each_pin_of_its_thread_says_its_own_mail_or_not() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    fake.launched_from("H2", "acme/default/claude-dev@4", Some("DEMO-1"));
    let first = mail(&fake, "S1", "human", "Tests pass. The rest is cleanup.").await;
    let second = mail(&fake, "S2", "human", "from the second seat").await;
    pin_request(&*fake, Some("S1"), first, None, None, false)
        .await
        .unwrap();
    // Two seats run at once: the second's mail leaves the first's out, but its pins read
    // names the first's pin by its message.
    let read = pin_request(&*fake, Some("S2"), second, None, None, false)
        .await
        .unwrap();
    let person = human(&fake, Some("DEMO-1"), PinOp::Read).await;
    for result in [&read, &person] {
        let json = serde_json::to_value(result).unwrap();
        let pins = json["pins"].as_array().unwrap();
        assert_eq!(pins[0]["messageId"], first);
        let message = &pins[0]["message"];
        assert_eq!(message["from"], "H1", "{json}");
        assert_eq!(message["text"], "Tests pass. The rest is cleanup.");
        assert!(message["createdAtMs"].as_i64().unwrap() > 0);
        assert_eq!(pins[1]["message"]["from"], "H2");
    }
}

#[tokio::test]
async fn a_successor_restores_and_updates_the_preview_of_its_predecessors_pin() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    fake.launched_from("H2", "acme/default/claude-dev@4", Some("DEMO-1"));
    let first = mail(&fake, "S1", "human", "the first session's view").await;
    pin_request(&*fake, Some("S1"), first, None, None, false)
        .await
        .unwrap();
    pin_request(&*fake, Some("S1"), first, None, None, true)
        .await
        .unwrap();
    fake.end("H1");
    // The successor undoes its predecessor's unpin, then gives the pin a preview.
    let restored = pin_request(&*fake, Some("S2"), first, None, None, PinChange::Restore)
        .await
        .unwrap();
    assert_eq!(listed(&restored), vec![first]);
    let preview = PinPreview {
        short_name: Some("View".into()),
        value: Some("3 of 5".into()),
        status: Some(PinStatus::Running),
        ..PinPreview::default()
    };
    let updated = pin_request(&*fake, Some("S2"), first, None, Some(preview.clone()), false)
        .await
        .unwrap();
    match &updated {
        PinResult::Pins { list, .. } => assert_eq!(list.pins[0].preview, Some(preview)),
        other => panic!("expected pins, got {other:?}"),
    }
}

#[tokio::test]
async fn a_successor_on_a_new_revision_continues_the_thread_and_other_stories_do_not() {
    let fake = FakeHost::new();
    fake.launched_from("H1", "acme/default/claude-dev@3", Some("DEMO-1"));
    fake.launched_from("H2", "acme/default/claude-dev@4", Some("DEMO-1"));
    fake.launched_from("H3", "acme/default/claude-dev@4", Some("DEMO-2"));
    fake.launched_from("H4", "acme/default/claude-dev@4", None);
    // The fake runs S1 and S2; the other story's session and the ad hoc one run too.
    fake.tab("H3", "S3", "Third", true);
    fake.tab("H4", "S4", "Fourth", true);
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
    let team = launch_team("default");
    for agent in [AGENT, "acme/default/claude-dev@4"] {
        let read = |story| pins_from_human(&*fake, &team, agent, story, PinOp::Read);
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

#[tokio::test]
async fn the_person_restores_an_unpinned_pin_as_it_was_and_the_restore_fires_once() {
    let fake = FakeHost::new();
    let a = mail(&fake, "S1", "human", "view a").await;
    let b = mail(&fake, "S1", "human", "view b").await;
    let story = Some("DEMO-1");
    for id in [a, b] {
        human(
            &fake,
            story,
            PinOp::Pin {
                message_id: id,
                position: None,
                preview: None,
            },
        )
        .await;
    }
    human(&fake, story, PinOp::Unpin { message_id: a }).await;
    let restored = human(&fake, story, PinOp::Restore { message_id: a }).await;
    assert_eq!(outcome(&restored), Some(PinOutcome::Restored));
    assert_eq!(listed(&restored), vec![a, b], "back in its place");
    let again = human(&fake, story, PinOp::Restore { message_id: a }).await;
    assert_eq!(outcome(&again), Some(PinOutcome::Unchanged));
    // pin, pin, unpin, restore: the second restore changed nothing.
    assert_eq!(fake.pin_events().len(), 4);
    let never = mail(&fake, "S1", "human", "view c").await;
    match human(&fake, story, PinOp::Restore { message_id: never }).await {
        PinResult::Invalid { message } => {
            assert!(message.contains("no pin to restore"), "{message}")
        }
        other => panic!("expected invalid, got {other:?}"),
    }
}

#[tokio::test]
async fn the_person_replaces_a_pin_at_the_cap_and_one_undo_puts_both_back_each_firing_once() {
    let fake = FakeHost::new();
    let story = Some("DEMO-1");
    let mut held = vec![];
    for text in ["view a", "view b", "view c"] {
        let id = mail(&fake, "S1", "human", text).await;
        human(
            &fake,
            story,
            PinOp::Pin {
                message_id: id,
                position: None,
                preview: None,
            },
        )
        .await;
        held.push(id);
    }
    let (a, b, c) = (held[0], held[1], held[2]);
    let d = mail(&fake, "S1", "human", "view d").await;
    let before = fake.pin_events().len();
    let replaced = human(
        &fake,
        story,
        PinOp::Replace {
            message_id: d,
            replaces: b,
        },
    )
    .await;
    assert_eq!(outcome(&replaced), Some(PinOutcome::Replaced));
    assert_eq!(
        listed(&replaced),
        vec![a, d, c],
        "in the replaced pin's place"
    );
    assert_eq!(fake.pin_events().len(), before + 1, "one change");
    let undone = human(
        &fake,
        story,
        PinOp::RestoreReplacing {
            message_id: b,
            replacing: d,
        },
    )
    .await;
    assert_eq!(outcome(&undone), Some(PinOutcome::Restored));
    assert_eq!(listed(&undone), vec![a, b, c]);
    assert_eq!(fake.pin_events().len(), before + 2, "one change");
}

#[tokio::test]
async fn a_replace_of_a_pin_that_left_is_refused_names_the_list_and_fires_nothing() {
    let fake = FakeHost::new();
    let story = Some("DEMO-1");
    let a = mail(&fake, "S1", "human", "view a").await;
    let b = mail(&fake, "S1", "human", "view b").await;
    for id in [a, b] {
        human(
            &fake,
            story,
            PinOp::Pin {
                message_id: id,
                position: None,
                preview: None,
            },
        )
        .await;
    }
    human(&fake, story, PinOp::Unpin { message_id: b }).await;
    let d = mail(&fake, "S1", "human", "view d").await;
    let before = fake.pin_events().len();
    match human(
        &fake,
        story,
        PinOp::Replace {
            message_id: d,
            replaces: b,
        },
    )
    .await
    {
        PinResult::Invalid { message } => {
            assert!(message.contains("the list changed"), "{message}");
            assert!(message.contains("Pinned now"), "{message}");
        }
        other => panic!("expected invalid, got {other:?}"),
    }
    assert_eq!(fake.pin_events().len(), before);
}

#[tokio::test]
async fn a_message_frame_pins_only_into_its_senders_thread() {
    let fake = FakeHost::new();
    fake.launched_from("H1", AGENT, Some("DEMO-1"));
    let view = mail(&fake, "S1", "human", "a view").await;
    let team = launch_team("default");
    let pin = PinOp::Pin {
        message_id: view,
        position: None,
        preview: None,
    };
    // Its sender's thread, on a new revision of the same saved agent: the pin lands.
    let revision = "acme/default/claude-dev@9";
    let own = pins_from_frame(&*fake, &team, revision, Some("DEMO-1"), pin.clone(), "H1")
        .await
        .unwrap();
    assert_eq!(listed(&own), vec![view]);
    // Another story, another agent: refused, and nothing changes there.
    for (agent, story) in [(AGENT, Some("DEMO-2")), ("acme/default/other", Some("DEMO-1"))] {
        let other = pins_from_frame(&*fake, &team, agent, story, pin.clone(), "H1")
            .await
            .unwrap();
        assert!(
            matches!(&other, PinResult::Invalid { message } if message.contains("its sender's thread")),
            "{other:?}"
        );
    }
    // A sender with no saved-agent thread pins nowhere.
    let loose = pins_from_frame(&*fake, &team, AGENT, Some("DEMO-1"), pin.clone(), "H2")
        .await
        .unwrap();
    assert!(matches!(&loose, PinResult::Invalid { message } if message.contains("saved Agent")));
    // A read is not a write: a frame reads any thread of its team.
    let read = pins_from_frame(&*fake, &team, AGENT, Some("DEMO-2"), PinOp::Read, "H1")
        .await
        .unwrap();
    assert!(matches!(read, PinResult::Pins { .. }));
    assert_eq!(listed(&human(&fake, Some("DEMO-2"), PinOp::Read).await), Vec::<i64>::new());
}

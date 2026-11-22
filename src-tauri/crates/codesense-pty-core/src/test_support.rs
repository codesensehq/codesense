// SPDX-License-Identifier: MIT
//! Crate tests that need no PTY, so they compile on every OS: the session
//! classifiers, output delivery, the exit wire shape, `caps_off`, and the
//! `expect_mode` assertion other modules' tests share.

use std::collections::HashMap;
use std::path::Path;

use crate::domain::{PortUnavailable, PtySessionId, TerminalDomainEvent, TerminalEventSink};
use crate::state::{is_persisting, SessionMeta};
use crate::term_state::{StreamId, SubscriberHandle};

/// The correlation triplet folded into [`SessionMeta`] must round-trip
/// through the destructure the spawn / warm-handoff paths do at their body tops.
/// Also pins the load-bearing invariant that `SessionMeta::default()` is
/// all-`None`: that is the warm-pool-member sentinel the persistence classifier
/// keys on (`is_persisting` gets `has_story_id = false` for it, so an unattached
/// pool shell is never persisted).
#[test]
fn session_meta_round_trips_and_default_is_pool_member_sentinel() {
    let meta = SessionMeta {
        story_id: Some("RF-15".into()),
        workspace_id: Some("ws-1".into()),
        epic_id: Some("09".into()),
    };
    // Clone (the warm-handoff path) then destructure (the body-top pattern).
    let SessionMeta {
        story_id,
        workspace_id,
        epic_id,
    } = meta.clone();
    assert_eq!(story_id.as_deref(), Some("RF-15"));
    assert_eq!(workspace_id.as_deref(), Some("ws-1"));
    assert_eq!(epic_id.as_deref(), Some("09"));

    // Sentinel: default is all-None → classifier sees a non-persisting pool
    // member.
    let default = SessionMeta::default();
    assert!(default.story_id.is_none());
    assert!(default.workspace_id.is_none());
    assert!(default.epic_id.is_none());
    assert!(!is_persisting(
        /* is_pool_member */ true,
        default.story_id.is_some(),
        /* has_subscribers */ false,
    ));
}

/// RF-perf-6: the dead-session cap decision. Tuple is
/// `(id, alive, has_subscribers, exit_seq)`. LIVE sessions and currently-VIEWED
/// dead sessions are never eviction candidates; among the remaining
/// (dead, unviewed, stamped) sessions the `cap` most-recently-dead (highest
/// `exit_seq`) are retained and the older tail is returned OLDEST-first; a
/// dead-but-unstamped session (`exit_seq == None`) is retained this pass. Pure,
/// so the whole rule is proven without a real PTY.
#[test]
fn dead_sessions_to_evict_bounds_dead_and_never_touches_live() {
    use crate::state::dead_sessions_to_evict;
    // Empty / at-or-below-cap → nothing evicted.
    assert!(dead_sessions_to_evict(&[], 2).is_empty());
    let live_only = vec![
        ("a".to_string(), true, false, None),
        ("b".to_string(), true, false, None),
    ];
    assert!(
        dead_sessions_to_evict(&live_only, 1).is_empty(),
        "live sessions are never eviction candidates"
    );
    let at_cap = vec![
        ("d1".to_string(), false, false, Some(1)),
        ("d2".to_string(), false, false, Some(2)),
    ];
    assert!(
        dead_sessions_to_evict(&at_cap, 2).is_empty(),
        "dead count == cap → nothing evicted"
    );

    // Over cap (input intentionally unsorted to exercise the ordering):
    // three dead+unviewed+stamped + one live + one dead-but-unstamped + one
    // dead-BUT-VIEWED (open scrollback tab), cap = 1.
    let over = vec![
        ("d_new".to_string(), false, false, Some(30)),
        ("live".to_string(), true, false, None),
        ("d_old".to_string(), false, false, Some(10)),
        ("fresh".to_string(), false, false, None),
        ("viewed_old".to_string(), false, true, Some(1)), // dead but on-screen
        ("d_mid".to_string(), false, false, Some(20)),
    ];
    let victims = dead_sessions_to_evict(&over, 1);
    // Keep the single most-recently-dead unviewed (`d_new`); evict the older
    // unviewed tail, oldest death first. `viewed_old` — oldest of all — is
    // NEVER evicted because a viewport is attached.
    assert_eq!(victims, vec!["d_old".to_string(), "d_mid".to_string()]);
    for retained in ["live", "fresh", "d_new", "viewed_old"] {
        assert!(
            !victims.contains(&retained.to_string()),
            "{retained} must be retained"
        );
    }
}

/// The persisting-classifier rule. Active-workspace terminal
/// (subscribers>0) and story-scoped terminal (story_id set) persist; a
/// 0-subscriber, no-story terminal (soft-closed / team-switch-continuity)
/// does not; a warm-pool member never persists regardless.
#[test]
fn is_persisting_matches_ac11_rule() {
    // active-workspace tab (live viewport, no story) → persists
    assert!(is_persisting(false, false, true));
    // story-scoped (story id, no live viewport) → persists
    assert!(is_persisting(false, true, false));
    // soft-closed / team-switch-continuity (no story, no viewport) → killed
    assert!(!is_persisting(false, false, false));
    // warm-pool member is never persisted, even if it somehow looked alive
    assert!(!is_persisting(true, true, true));
}

/// A viewport stream the host fails to deliver to is counted as a failed
/// emit in its telemetry, never as bytes sent; the session channel still gets
/// the batch.
#[test]
fn failed_stream_delivery_counts_as_an_emit_failure() {
    struct RejectStreams;
    impl TerminalEventSink for RejectStreams {
        fn emit(&self, event: TerminalDomainEvent) -> Result<(), PortUnavailable> {
            match event {
                TerminalDomainEvent::StreamOutput { .. } => {
                    Err(PortUnavailable("stream closed".into()))
                }
                _ => Ok(()),
            }
        }
    }
    let mut subscribers = HashMap::new();
    subscribers.insert(StreamId(1), SubscriberHandle::default());
    crate::state::deliver_output(&RejectStreams, &mut subscribers, "s", "bytes", 5);
    let handle = &subscribers[&StreamId(1)];
    assert_eq!(handle.emit_failures, 1);
    assert_eq!(handle.bytes_sent, 0);
}

/// An exit from a host that predates the `requested` flag reads as not
/// requested.
#[test]
fn an_exit_without_the_requested_flag_reads_as_not_requested() {
    let exit = TerminalDomainEvent::Exit {
        session: PtySessionId::new("s1"),
        status: None,
        pool_member: false,
        requested: true,
        incarnation: 0,
    };
    let mut json = serde_json::to_value(&exit).unwrap();
    let fields = json
        .as_object_mut()
        .and_then(|o| o.values_mut().next())
        .and_then(|v| v.as_object_mut())
        .expect("an externally tagged variant");
    assert!(fields.remove("requested").is_some());
    let older: TerminalDomainEvent = serde_json::from_value(json).unwrap();
    assert!(matches!(
        older,
        TerminalDomainEvent::Exit {
            requested: false,
            ..
        }
    ));
}

#[test]
fn caps_off_is_unsupported_and_names_the_capability() {
    let error = crate::caps_off("agent-cli-sockets");
    assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
    assert!(error.to_string().contains("agent-cli-sockets"), "{error}");
}

/// Unix: `path`'s permission bits are exactly `mode`. Windows has no mode,
/// so nothing is checked there.
pub(crate) fn expect_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let actual = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(actual, mode, "{}: {actual:o}", path.display());
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

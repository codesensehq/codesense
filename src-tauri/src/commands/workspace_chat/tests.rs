// SPDX-License-Identifier: MIT
//! Seam tests for the workspace chat engine. Unit tests live inside each
//! submodule (model.rs, resolve.rs, index.rs, store.rs, state.rs).
//!
//! The tests here cover compositions that span modules, exercised through
//! public API only.

use super::model::{ChatMediaState, MessageKind, HUMAN};
use super::store::{ChatAppend, WorkspaceChatStore};
use tempfile::TempDir;

fn setup() -> (WorkspaceChatStore, TempDir) {
    let tmp = TempDir::new().unwrap();
    let store = WorkspaceChatStore::default();
    store.install(tmp.path());
    (store, tmp)
}

fn user_post(workspace: &str, text: &str) -> ChatAppend {
    ChatAppend {
        workspace_id: workspace.into(),
        from: HUMAN.into(),
        from_name: "Sam".into(),
        text: text.into(),
        kind: MessageKind::Chat,
        content_type: None,
        on_click: None,
        primary_file: None,
        media: None,
    }
}

#[test]
fn system_message_can_be_the_first_line_in_the_log() {
    let (store, _tmp) = setup();
    let sys = ChatAppend {
        workspace_id: "story:a".into(),
        from: MessageKind::SYSTEM_FROM.into(),
        from_name: MessageKind::SYSTEM_FROM_NAME.into(),
        text: "Chat started.".into(),
        kind: MessageKind::System,
        content_type: Some(super::model::MessageContentType::Plain),
        on_click: None,
        primary_file: None,
        media: None,
    };
    let m = store.append(sys, 1).unwrap();
    assert_eq!(m.message_id, 1);
    assert_eq!(m.from, "system");
    assert!(matches!(m.kind, MessageKind::System));
}

#[test]
fn human_post_from_matches_inbox_sentinel() {
    let (store, _tmp) = setup();
    let m = store.append(user_post("story:a", "hi there"), 42).unwrap();
    assert_eq!(m.from, HUMAN);
    assert_eq!(m.from, crate::weft::inbox::HUMAN);
    assert_eq!(m.from_name, "Sam");
    assert!(m.in_reply_to.is_none(), "v1 stores inReplyTo: null always");
}

#[test]
fn head_id_tracks_latest_append() {
    let (store, _tmp) = setup();
    assert_eq!(store.head_id("story:a"), 0);
    store.append(user_post("story:a", "one"), 1).unwrap();
    assert_eq!(store.head_id("story:a"), 1);
    store.append(user_post("story:a", "two"), 2).unwrap();
    assert_eq!(store.head_id("story:a"), 2);
}

#[test]
fn read_result_carries_head_id_and_archive_stamp_visible_via_list() {
    // CR3-11: ChatReadResult no longer carries the chat-local stamp
    // (dead-code field; the Tauri + MCP read paths overlay the registry
    // flag). The stamp still lives on `ChatIndexEntry` and is surfaced
    // through `WorkspaceChatStore::list()` for the sidebar.
    let (store, _tmp) = setup();
    store.append(user_post("story:a", "one"), 1).unwrap();
    store.append(user_post("story:a", "two"), 2).unwrap();
    let out = store.read("story:a", None, None).unwrap();
    assert_eq!(out.head_id, 2);
    assert_eq!(out.messages.len(), 2);
    let listed = store.list();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].archived_at_ms.is_none());

    store.set_archive_stamp("story:a", Some(999)).unwrap();
    let listed = store.list();
    assert_eq!(listed[0].archived_at_ms, Some(999));
}

#[test]
fn human_posts_then_agent_reads_advances_watermark_past_head() {
    let (store, _tmp) = setup();
    store.append(user_post("story:a", "one"), 10).unwrap();
    store.append(user_post("story:a", "two"), 20).unwrap();
    let out = store
        .read_for_session("story:a", "h-ex-1", "h-ex-1", None, Some(50))
        .unwrap();
    assert_eq!(out.messages.len(), 2);
    assert_eq!(
        store.position("story:a", "h-ex-1", "h-ex-1").unwrap().read,
        2
    );
    store.append(user_post("story:a", "three"), 30).unwrap();
    assert_eq!(
        store.unread("story:a", "h-ex-1", "h-ex-1").unwrap().count,
        1
    );
}

#[test]
fn archive_stamp_blocks_non_system_append_but_allows_system_rows() {
    // CR3-7: once `set_archive_stamp` has committed, `store.append` MUST
    // refuse further user/agent chat rows. System rows (lifecycle anchors
    // like "Workspace archived.") bypass the gate so the engine can still
    // record the archive event itself.
    let (store, _tmp) = setup();
    store.append(user_post("story:a", "pre"), 1).unwrap();
    store.set_archive_stamp("story:a", Some(42)).unwrap();

    let err = store.append(user_post("story:a", "post"), 2).unwrap_err();
    assert!(
        matches!(err, super::store::ChatStoreError::Archived),
        "expected Archived, got {err:?}"
    );
    assert_eq!(store.head_id("story:a"), 1, "head must not advance");

    // System row still writes.
    let sys = ChatAppend {
        workspace_id: "story:a".into(),
        from: MessageKind::SYSTEM_FROM.into(),
        from_name: MessageKind::SYSTEM_FROM_NAME.into(),
        text: "Workspace archived.".into(),
        kind: MessageKind::System,
        content_type: Some(super::model::MessageContentType::Plain),
        on_click: None,
        primary_file: None,
        media: None,
    };
    let m = store.append(sys, 3).unwrap();
    assert_eq!(m.message_id, 2);

    // Clearing the stamp re-opens writes.
    store.set_archive_stamp("story:a", None).unwrap();
    let m = store.append(user_post("story:a", "resume"), 4).unwrap();
    assert_eq!(m.message_id, 3);
}

#[test]
fn tail_scan_recovers_head_for_a_large_last_message() {
    // CR3-1: an 8 KiB tail-scan window silently lost `head_id` for any
    // workspace whose last log line exceeded the window. With MAX_TEXT_BYTES
    // at 32 KiB a legal post can be ~32 KiB plus JSON envelope — a cold
    // restart's `install` would then fail to parse the tail and reset head
    // to 0, causing the next append to collide on message_id=1.
    let tmp = tempfile::TempDir::new().unwrap();
    // Build a message well above the old 8 KiB cap but comfortably under
    // the current 32 KiB text cap.
    let big = "x".repeat(20_000);
    {
        let store = WorkspaceChatStore::default();
        store.install(tmp.path());
        store.append(user_post("story:a", "first"), 1).unwrap();
        store.append(user_post("story:a", &big), 2).unwrap();
        assert_eq!(store.head_id("story:a"), 2);
    }
    // Fresh store on the same home must recover head=2 from the tail.
    let store2 = WorkspaceChatStore::default();
    store2.install(tmp.path());
    assert_eq!(
        store2.head_id("story:a"),
        2,
        "tail_scan must contain the full final line"
    );
    // Next append should mint message_id=3, not collide on 1 or 2.
    let m = store2.append(user_post("story:a", "third"), 3).unwrap();
    assert_eq!(m.message_id, 3);
}

#[test]
fn archive_stamp_persists_through_restart() {
    // The index is the archive stamp's authority (SW-WC-1 is the admission
    // check source, but the chat-local stamp lives here for the sidebar).
    // CR3-11: the stamp is read via `list()` (ChatIndexEntry) rather than
    // via `read()` (ChatReadResult no longer carries it).
    let tmp = tempfile::TempDir::new().unwrap();
    {
        let store = WorkspaceChatStore::default();
        store.install(tmp.path());
        store.append(user_post("story:a", "one"), 1).unwrap();
        store.set_archive_stamp("story:a", Some(42)).unwrap();
    }
    let store2 = WorkspaceChatStore::default();
    store2.install(tmp.path());
    let listed = store2.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].archived_at_ms, Some(42));
}

#[test]
fn retained_chat_is_paged_independently_and_persists_per_workspace() {
    let (store, tmp) = setup();
    for n in 0..75 {
        store
            .append(user_post("story:a", &format!("post {n}")), n)
            .unwrap();
    }
    store
        .append(user_post("story:b", "different room"), 1)
        .unwrap();
    let first = store
        .read_for_session("story:a", "one", "one", None, Some(50))
        .unwrap();
    assert_eq!(first.messages[0].message_id, 1);
    assert_eq!(first.messages.len(), 50);
    assert_eq!(first.unread_remaining, 25);
    assert_eq!(store.unread("story:a", "two", "two").unwrap().count, 75);
    // A tail inspection cannot acknowledge a gap.
    store
        .read_for_session("story:a", "two", "two", Some(70), Some(50))
        .unwrap();
    assert_eq!(store.unread("story:a", "two", "two").unwrap().count, 75);
    store.note_told("story:a", "one", "one", 75).unwrap();
    store.note_human_read("story:a", 75).unwrap();
    assert_eq!(store.unread("story:a", "two", "two").unwrap().count, 75);
    let restored = WorkspaceChatStore::default();
    restored.install(tmp.path());
    assert_eq!(restored.position("story:a", "one", "one").unwrap().read, 50);
    assert_eq!(restored.position("story:a", "one", "one").unwrap().told, 75);
    assert_eq!(restored.human_read_id("story:a").unwrap(), 75);
    assert_eq!(restored.human_unread("story:a").unwrap().count, 0);
    assert_eq!(restored.position("story:b", "one", "one").unwrap().read, 0);
    let next = restored
        .read_for_session("story:a", "one", "one", None, None)
        .unwrap();
    assert_eq!(next.messages[0].message_id, 51);
    assert_eq!(next.unread_remaining, 0);
    // A late join needs no new append.
    assert_eq!(
        restored.unread("story:a", "late", "late").unwrap().count,
        75
    );
}

#[test]
fn lifecycle_and_own_posts_do_not_count_or_need_notices() {
    let (store, _tmp) = setup();
    let mut system = user_post("story:a", "Chat started.");
    system.kind = MessageKind::System;
    store.append(system, 1).unwrap();
    let mut own = user_post("story:a", "from me");
    own.from = "one".into();
    store.append(own, 2).unwrap();
    assert_eq!(store.unread("story:a", "one", "one").unwrap().count, 0);
    assert_eq!(store.unread("story:a", "two", "two").unwrap().count, 1);
    store.note_told("story:a", "two", "two", 2).unwrap();
    assert_eq!(store.unread("story:a", "two", "two").unwrap().count, 1);
    assert_eq!(store.unannounced("story:a", "two", "two").unwrap().count, 0);
}

#[test]
fn scoped_positions_prune_only_after_two_missing_snapshots() {
    let (store, _tmp) = setup();
    store.append(user_post("story:a", "post"), 1).unwrap();
    store.position("story:a", "here", "here").unwrap();
    store.note_read("story:a", "here", "here", 1).unwrap();
    store.position("story:a", "gone", "gone").unwrap();
    store.note_read("story:a", "gone", "gone", 1).unwrap();
    let live = ["here".to_string()].into_iter().collect();
    store.prune_positions(&live).unwrap();
    assert_eq!(store.position("story:a", "gone", "gone").unwrap().read, 1);
    store.prune_positions(&live).unwrap();
    assert_eq!(store.position("story:a", "gone", "gone").unwrap().read, 0);
    assert_eq!(store.position("story:a", "here", "here").unwrap().read, 1);
}

#[test]
fn chat_positions_keep_a_reattached_session_but_reset_a_relaunched_handle() {
    let (store, tmp) = setup();
    store.append(user_post("story:a", "first"), 1).unwrap();
    store
        .read_for_session("story:a", "story-handle", "session-1", None, None)
        .unwrap();
    store.append(user_post("story:a", "second"), 2).unwrap();
    store
        .note_told("story:a", "story-handle", "session-1", 2)
        .unwrap();

    // Restarting the desktop and reattaching the same live agent keeps both cursors.
    let reattached = WorkspaceChatStore::default();
    reattached.install(tmp.path());
    let p = reattached
        .position("story:a", "story-handle", "session-1")
        .unwrap();
    assert_eq!((p.read, p.told), (1, 2));
    assert_eq!(
        reattached
            .unread("story:a", "story-handle", "session-1")
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        reattached
            .unannounced("story:a", "story-handle", "session-1")
            .unwrap()
            .count,
        0
    );

    // An immediate relaunch reuses the story handle but has a different live session.
    assert_eq!(
        reattached
            .unannounced("story:a", "story-handle", "session-2")
            .unwrap()
            .count,
        2
    );
    reattached
        .note_told("story:a", "story-handle", "session-1", 2)
        .unwrap();
    let p = reattached
        .position("story:a", "story-handle", "session-2")
        .unwrap();
    assert_eq!(
        (p.read, p.told),
        (0, 0),
        "late old-session confirmations stay isolated"
    );
}

fn media_post(workspace: &str, text: &str) -> ChatAppend {
    let attachment = crate::media::Attachment::remote(
        "https://media.giphy.com/media/g1/giphy.gif",
        "a cat",
        &crate::media::Config::default(),
        true,
    )
    .unwrap();
    ChatAppend {
        media: Some(super::store::ChatAppendMedia {
            team: crate::commands::dashboard_launch::LaunchTeam {
                org: "acme".into(),
                team: "default".into(),
            },
            attachment,
            state: ChatMediaState::Pending,
        }),
        ..user_post(workspace, text)
    }
}

fn fetched(mut a: crate::media::Attachment) -> crate::media::Attachment {
    a.state = "cached".into();
    a.sha256 = Some("ab".repeat(32));
    a.width = Some(2);
    a.height = Some(3);
    a
}

fn log_lines(tmp: &TempDir, workspace: &str) -> Vec<String> {
    let path = super::index::log_path(tmp.path(), &super::index::workspace_slug(workspace));
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(String::from)
        .collect()
}

fn sidecar(tmp: &TempDir, workspace: &str) -> std::path::PathBuf {
    super::index::chats_dir(tmp.path()).join(format!(
        "{}.media.json",
        super::index::workspace_slug(workspace)
    ))
}

#[test]
fn chat_media_old_log_row_loads() {
    let (store, tmp) = setup();
    // A row written before chat media: no attachments, media team or state, and no
    // sidecar beside the log.
    let path = super::index::log_path(tmp.path(), &super::index::workspace_slug("story:old"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        concat!(
            r#"{"messageId":1,"from":"human","fromName":"Sam","createdAtMs":5,"#,
            r#""text":"hello","workspaceId":"story:old","kind":"chat"}"#,
            "\n"
        ),
    )
    .unwrap();
    let page = store.read("story:old", None, None).unwrap();
    assert_eq!(page.messages.len(), 1);
    let row = &page.messages[0];
    assert_eq!(row.text, "hello");
    assert!(row.attachments.is_empty());
    assert_eq!(row.media_team, None);
    assert_eq!(row.media_state, None);
    assert!(!sidecar(&tmp, "story:old").exists());
    assert_eq!(
        store.media_message("story:old", 1).unwrap().as_ref(),
        Some(row)
    );
    assert!(store.media_messages("story:old").unwrap().is_empty());
}

#[test]
fn chat_media_text_is_optional_only_with_media() {
    let (store, _tmp) = setup();
    assert!(matches!(
        store.append(user_post("story:a", "  "), 1),
        Err(super::store::ChatStoreError::EmptyText)
    ));
    let bare = store.append(media_post("story:a", "  "), 2).unwrap();
    assert_eq!(bare.text, "");
    assert_eq!(bare.attachments.len(), 1);
    assert_eq!(bare.media_state, Some(ChatMediaState::Pending));
    assert_eq!(bare.media_team.unwrap().team, "default");
}

#[test]
fn chat_media_line_past_the_log_bound_is_refused() {
    let (store, tmp) = setup();
    store.append(user_post("story:a", "first"), 1).unwrap();
    let before = log_lines(&tmp, "story:a");
    // Inside the text cap, but escaped in JSON past what a read takes back.
    let wide = "\u{1}".repeat(12_000);
    for post in [user_post("story:a", &wide), media_post("story:a", &wide)] {
        assert!(matches!(
            store.check_line(&post),
            Err(super::store::ChatStoreError::LineTooLong)
        ));
        assert!(matches!(
            store.append(post, 2),
            Err(super::store::ChatStoreError::LineTooLong)
        ));
    }
    assert_eq!(log_lines(&tmp, "story:a"), before);
    store.check_line(&media_post("story:a", "look")).unwrap();
    assert_eq!(
        store
            .append(user_post("story:a", "next"), 3)
            .unwrap()
            .message_id,
        2
    );
}

#[test]
fn chat_media_pending_with_no_fetch_reads_as_interrupted() {
    let (store, _tmp) = setup();
    let sent = store.append(media_post("story:a", "look"), 1).unwrap();
    assert_eq!(
        store
            .media_message("story:a", 1)
            .unwrap()
            .unwrap()
            .media_state,
        Some(ChatMediaState::Pending)
    );
    // The fetch's task ended, by any path, without recording a result.
    let task = store.in_flight("story:a", sent.message_id);
    assert_eq!(
        store
            .media_message("story:a", 1)
            .unwrap()
            .unwrap()
            .media_state,
        Some(ChatMediaState::Pending),
        "a mark owned by a live task keeps the row pending"
    );
    drop(task);
    let row = store.media_message("story:a", 1).unwrap().unwrap();
    assert_eq!(row.media_state, Some(ChatMediaState::Failed));
    assert_eq!(row.attachments[0].state, "failed");
    assert_eq!(row.attachments[0].reason.as_deref(), Some("interrupted"));
    assert!(row.attachments[0].retryable);
    assert_eq!(
        store.read("story:a", None, None).unwrap().messages,
        vec![row]
    );
    // A result recorded for it stands.
    let done = fetched(sent.attachments[0].clone());
    store
        .set_media("story:a", 1, vec![done.clone()], ChatMediaState::Cached)
        .unwrap();
    let row = store.media_message("story:a", 1).unwrap().unwrap();
    assert_eq!(row.media_state, Some(ChatMediaState::Cached));
    assert_eq!(row.attachments, vec![done]);
}

#[test]
fn chat_media_sidecar_concurrent_writers() {
    let (store, tmp) = setup();
    let sent = store.append(media_post("story:a", "look"), 1).unwrap();
    let before = log_lines(&tmp, "story:a");
    // A fetch finishing while other posts land: neither waits on the other's file, and
    // the image's row stays as sent.
    let done = fetched(sent.attachments[0].clone());
    let writer = {
        let (store, done) = (store.clone(), done.clone());
        std::thread::spawn(move || {
            store
                .set_media("story:a", 1, vec![done], ChatMediaState::Cached)
                .unwrap()
        })
    };
    for n in 0..20 {
        store
            .append(user_post("story:a", &format!("post {n}")), 2 + n)
            .unwrap();
    }
    assert!(writer.join().unwrap());
    let after = log_lines(&tmp, "story:a");
    assert_eq!(after.len(), 21);
    assert_eq!(after[0], before[0], "the media row is never rewritten");
    let row = store.media_message("story:a", 1).unwrap().unwrap();
    assert_eq!(row.attachments, vec![done.clone()]);
    assert_eq!(row.media_state, Some(ChatMediaState::Cached));
    let page = store.read("story:a", Some(0), Some(1)).unwrap();
    assert_eq!(page.messages[0].attachments, vec![done]);
    let on_disk = std::fs::read_to_string(sidecar(&tmp, "story:a")).unwrap();
    assert!(on_disk.contains(&"ab".repeat(32)));
    // A message with no media has no entry to set.
    assert!(!store
        .set_media("story:a", 2, Vec::new(), ChatMediaState::Cached)
        .unwrap());
    assert!(!store
        .set_media("story:a", 99, Vec::new(), ChatMediaState::Cached)
        .unwrap());
}

#[test]
fn chat_media_sidecar_corrupt_reads_as_rows() {
    let (store, tmp) = setup();
    let sent = store.append(media_post("story:a", "look"), 1).unwrap();
    std::fs::write(sidecar(&tmp, "story:a"), b"{not json").unwrap();
    // Unreadable: the rows read as sent.
    let page = store.read("story:a", None, None).unwrap();
    assert_eq!(page.messages, vec![sent.clone()]);
    assert_eq!(
        store.media_message("story:a", 1).unwrap(),
        Some(sent.clone())
    );
    // The next write replaces it.
    let marked = store.mark_media_onload("story:a", 1, 0).unwrap().unwrap();
    assert!(marked[0].onload_sent);
    let row = store.media_message("story:a", 1).unwrap().unwrap();
    assert!(row.attachments[0].onload_sent);
    assert_eq!(row.media_state, Some(ChatMediaState::Pending));
    // Settled once: a second mark changes nothing.
    assert_eq!(store.mark_media_onload("story:a", 1, 0).unwrap(), None);
    assert_eq!(store.mark_media_onload("story:a", 1, 1).unwrap(), None);
    let on_disk: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(sidecar(&tmp, "story:a")).unwrap()).unwrap();
    assert_eq!(
        on_disk["messages"]["1"]["attachments"][0]["onloadSent"],
        true
    );
}

/// The person's compose through the shared send core, with the fake inbox host: the
/// checks before any write, the GIF row, its one registration and the fan-out.
mod human_send {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::super::commands::human_send_error;
    use super::super::media::{ChatSender, MediaRefusal, MAX_ALT_BYTES, MAX_URL_BYTES};
    use super::super::model::{ChatMediaState, MessageKind, WorkspaceChatMessage, HUMAN};
    use super::super::send::{send, ChatPost, SendRefusal};
    use super::super::store::{ChatAppend, ChatStoreError};
    use crate::commands::agent_inbox::tests::{launch_team, port, FakeHost};
    use crate::commands::agent_inbox::InboxHost;
    use crate::context_repo::caller_scope::CallerScope;
    use crate::media::{Config, FakeFetch, MediaInput, MediaProvider, Remote};

    const WS: &str = "story:human";
    const URL: &str = "https://media.giphy.com/media/g1/giphy.gif";
    const GIF: &[u8] = b"GIF89a\x02\x00\x03\x00";

    const NO_ALT: &str = "Add a description for the GIF, then send again.";
    const NO_TEAM: &str = "This chat has no team, so it can't send a GIF. Send text instead.";
    const TOO_LONG: &str =
        "This message is too long to send with a GIF. Shorten it and send again.";
    const CANT_SEND: &str = "This GIF can't be sent. Pick another one, or send text.";

    fn gif() -> MediaInput {
        MediaInput {
            url: Some(URL.into()),
            path: None,
            alt: "Typing cat".into(),
            provider: Some(MediaProvider::Giphy),
            provider_id: Some("g1".into()),
        }
    }

    fn human(team: Option<&str>) -> ChatSender {
        ChatSender::Human {
            team: team.map(launch_team),
        }
    }

    fn post(text: &str, media: Option<MediaInput>) -> ChatPost {
        ChatPost {
            workspace: WS.into(),
            from_name: "Sam".into(),
            text: text.into(),
            content_type: None,
            on_click: None,
            primary_file: None,
            media,
        }
    }

    /// Send as `sender` with the first-use anchor the app writes; the result and how
    /// many times the fan-out ran.
    async fn send_as(
        fake: &Arc<FakeHost>,
        sender: ChatSender,
        text: &str,
        media: Option<MediaInput>,
    ) -> (Result<WorkspaceChatMessage, SendRefusal>, usize) {
        let host = port(fake);
        let store = fake.chat().clone();
        let anchor = store.clone();
        let started = async move {
            anchor
                .append_if_first(
                    ChatAppend {
                        workspace_id: WS.into(),
                        from: MessageKind::SYSTEM_FROM.into(),
                        from_name: MessageKind::SYSTEM_FROM_NAME.into(),
                        text: "Chat started.".into(),
                        kind: MessageKind::System,
                        content_type: None,
                        on_click: None,
                        primary_file: None,
                        media: None,
                    },
                    0,
                )
                .unwrap();
        };
        let fanouts = AtomicUsize::new(0);
        let result = send(&host, &store, sender, post(text, media), started, |_| {
            fanouts.fetch_add(1, Ordering::SeqCst);
        })
        .await;
        (result, fanouts.load(Ordering::SeqCst))
    }

    /// The chat is untouched: no anchor row, no message, nothing registered.
    fn untouched(fake: &FakeHost) {
        assert!(!fake.chat().exists(WS), "no `Chat started.` row");
        assert_eq!(fake.chat().head_id(WS), 0, "no message");
        assert!(fake.media_sent_calls().is_empty(), "nothing registered");
    }

    /// A fake serving `GIF` at `URL` through a real media state.
    fn serving() -> (Arc<FakeHost>, Arc<FakeFetch>) {
        let fake = FakeHost::new();
        let fetch = Arc::new(FakeFetch::default());
        fetch.serve(URL, GIF, URL, None);
        fake.use_media(fetch.clone());
        (fake, fetch)
    }

    async fn settled(fake: &FakeHost, id: i64) -> WorkspaceChatMessage {
        for _ in 0..200 {
            let row = fake.chat().media_message(WS, id).unwrap().unwrap();
            if row.media_state != Some(ChatMediaState::Pending) {
                return row;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the media fetch never finished");
    }

    #[tokio::test]
    async fn human_gif_with_blank_text_is_stored_after_the_anchor() {
        let fake = FakeHost::new();
        let (sent, fanouts) = send_as(&fake, human(Some("default")), "  ", Some(gif())).await;
        let sent = sent.unwrap();
        assert_eq!(sent.message_id, 2, "after the first-use anchor");
        assert_eq!(sent.from, HUMAN);
        assert_eq!(sent.from_name, "Sam");
        assert_eq!(sent.text, "");
        assert_eq!(sent.media_team, Some(launch_team("default")));
        assert!(
            sent.attachments[0].own_sender,
            "the person's url is this Mac's own"
        );
        let page = fake.chat().read(WS, None, None).unwrap();
        assert_eq!(page.messages[0].text, "Chat started.");
        assert_eq!(page.messages[0].kind, MessageKind::System);
        assert_eq!(fanouts, 1, "one fan-out per accepted send");
    }

    #[tokio::test]
    async fn human_arm_prepares_as_the_person_with_no_session_lookup() {
        let fake = FakeHost::new();
        let (sent, _) = send_as(&fake, human(Some("design")), "look", Some(gif())).await;
        assert_eq!(sent.unwrap().media_team, Some(launch_team("design")));
        let calls = fake.prepare_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].team,
            launch_team("design"),
            "the given team's config"
        );
        assert!(calls[0].own, "admitted as this machine's own");
        assert!(matches!(calls[0].scope, CallerScope::Human));
        assert_eq!(calls[0].workspace_root, None);
        let lookups = fake.lookups();
        assert!(
            lookups.is_empty(),
            "no session lookup on \"human\": {lookups:?}"
        );
    }

    #[tokio::test]
    async fn session_arm_still_looks_its_sender_up() {
        let fake = FakeHost::new();
        fake.own_sender("H1");
        let session = ChatSender::Session {
            handle: "H1".into(),
            remote: false,
        };
        let (sent, fanouts) = send_as(&fake, session, "look", Some(gif())).await;
        let sent = sent.unwrap();
        assert_eq!(sent.from, "H1");
        assert_eq!(sent.media_team, Some(launch_team("default")));
        let methods: Vec<_> = fake.lookups().into_iter().map(|(m, _)| m).collect();
        for method in ["own_media_sender", "caller_scope", "caller_media_workspace"] {
            assert!(methods.contains(&method), "{method} in {methods:?}");
        }
        assert_eq!(fanouts, 1);
    }

    #[tokio::test]
    async fn blank_text_with_no_media_is_empty_text() {
        let fake = FakeHost::new();
        let (err, fanouts) = send_as(&fake, human(Some("default")), "  ", None).await;
        let err = err.unwrap_err();
        assert!(
            matches!(err, SendRefusal::Store(ChatStoreError::EmptyText)),
            "{err:?}"
        );
        assert_eq!(
            human_send_error(&err, false),
            ChatStoreError::EmptyText.to_string()
        );
        assert_eq!(fanouts, 0);
        untouched(&fake);
    }

    #[tokio::test]
    async fn text_only_send_ignores_its_team() {
        for team in [Some("default"), Some("nosuch"), None] {
            let fake = FakeHost::new();
            let (sent, fanouts) = send_as(&fake, human(team), "hi", None).await;
            let sent = sent.unwrap();
            assert_eq!(sent.message_id, 2, "{team:?}: after the anchor");
            assert_eq!(sent.media_team, None);
            assert!(sent.attachments.is_empty());
            assert!(fake.prepare_calls().is_empty());
            assert_eq!(fanouts, 1);
        }
    }

    #[tokio::test]
    async fn each_refused_gif_writes_nothing() {
        let overlong_url = format!(
            "https://media.giphy.com/media/{}/giphy.gif",
            "a".repeat(MAX_URL_BYTES)
        );
        let untagged = |url: &str| MediaInput {
            provider: None,
            provider_id: None,
            url: Some(url.into()),
            ..gif()
        };
        let cases: Vec<(&str, Option<&str>, MediaInput, MediaRefusal)> = vec![
            (
                "a path",
                Some("default"),
                MediaInput {
                    url: None,
                    path: Some("cat.gif".into()),
                    provider: None,
                    provider_id: None,
                    ..gif()
                },
                MediaRefusal::Invalid("media from the person must be a url".into()),
            ),
            (
                "a bad url",
                Some("default"),
                untagged("not a url"),
                MediaRefusal::Invalid(String::new()),
            ),
            (
                "an empty alt",
                Some("default"),
                MediaInput {
                    alt: "  ".into(),
                    ..gif()
                },
                MediaRefusal::NoAlt,
            ),
            (
                "an overlong alt",
                Some("default"),
                MediaInput {
                    alt: "a".repeat(MAX_ALT_BYTES + 1),
                    ..gif()
                },
                MediaRefusal::Invalid(format!("media.alt exceeds {MAX_ALT_BYTES} bytes")),
            ),
            (
                "an overlong url",
                Some("default"),
                untagged(overlong_url.as_str()),
                MediaRefusal::Invalid(format!("media.url exceeds {MAX_URL_BYTES} bytes")),
            ),
            (
                "a provider without an id",
                Some("default"),
                MediaInput {
                    provider_id: None,
                    ..gif()
                },
                MediaRefusal::Invalid(String::new()),
            ),
            ("no team", None, gif(), MediaRefusal::NoTeam),
            (
                "an unknown team",
                Some("nosuch"),
                gif(),
                MediaRefusal::NoTeam,
            ),
        ];
        for (case, team, media, want) in cases {
            let fake = FakeHost::new();
            let (err, fanouts) = send_as(&fake, human(team), "look", Some(media)).await;
            let SendRefusal::Media(got) = err.unwrap_err() else {
                panic!("{case}: not a media refusal");
            };
            match (&want, &got) {
                (MediaRefusal::Invalid(w), MediaRefusal::Invalid(g)) if w.is_empty() => {
                    assert!(!g.is_empty(), "{case}");
                }
                _ => assert_eq!(got, want, "{case}"),
            }
            let copy = human_send_error(&SendRefusal::Media(got), true);
            let want_copy = match want {
                MediaRefusal::NoAlt => NO_ALT,
                MediaRefusal::NoTeam => NO_TEAM,
                MediaRefusal::Invalid(_) => CANT_SEND,
            };
            assert_eq!(copy, want_copy, "{case}");
            assert_eq!(fanouts, 0, "{case}: no fan-out");
            assert!(fake.prepare_calls().is_empty(), "{case}: nothing prepared");
            untouched(&fake);
        }
    }

    #[tokio::test]
    async fn an_overlong_line_with_a_gif_reads_as_too_long() {
        // Inside the text cap, but escaped in JSON past the log's line bound.
        let text = "\u{1}".repeat(12_000);
        for media in [Some(gif()), None] {
            let fake = FakeHost::new();
            let with_media = media.is_some();
            let (err, fanouts) = send_as(&fake, human(Some("default")), &text, media).await;
            let err = err.unwrap_err();
            assert!(
                matches!(err, SendRefusal::Store(ChatStoreError::LineTooLong)),
                "{err:?}"
            );
            let want = if with_media {
                TOO_LONG.to_string()
            } else {
                ChatStoreError::LineTooLong.to_string()
            };
            assert_eq!(human_send_error(&err, with_media), want);
            assert_eq!(fanouts, 0);
            untouched(&fake);
        }
    }

    #[tokio::test]
    async fn a_human_gif_is_registered_once_across_the_send_and_a_read() {
        let (fake, fetch) = serving();
        let (sent, _) = send_as(&fake, human(Some("default")), "", Some(gif())).await;
        let sent = sent.unwrap();
        {
            let calls = fake.media_sent_calls();
            assert_eq!(calls.len(), 1);
            let (media, stored_first) = &calls[0];
            assert!(stored_first, "registration runs after the append");
            assert_eq!(media.message_id, sent.message_id);
            assert_eq!(media.chat.as_deref(), Some(WS));
            assert_eq!(media.team, launch_team("default"));
            assert_eq!(media.attachment.provider_id.as_deref(), Some("g1"));
        }
        let done = settled(&fake, sent.message_id).await;
        assert_eq!(done.media_state, Some(ChatMediaState::Cached));
        assert_eq!(fetch.calls(), [URL]);
        // Reading the chat back indexes it; that registers nothing again.
        let host = port(&fake);
        InboxHost::index_chat_media(&*fake, WS).await;
        let mut page = fake.chat().read(WS, None, None).unwrap();
        super::super::media::present(&*host, WS, &mut page.messages).await;
        assert_eq!(fake.media_sent_calls().len(), 1, "registered once");
    }

    #[tokio::test]
    async fn with_media_off_a_human_gif_waits_for_a_tap() {
        let (fake, fetch) = serving();
        fake.set_media_config(
            "default",
            Config {
                remote: Remote::Off,
                ..Config::default()
            },
        );
        let (sent, fanouts) = send_as(&fake, human(Some("default")), "", Some(gif())).await;
        let sent = sent.unwrap();
        assert_eq!(sent.media_state, Some(ChatMediaState::TapToLoad));
        assert_eq!(fanouts, 1);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(fetch.calls().is_empty(), "nothing fetched");
    }

    #[test]
    fn each_refusal_reads_as_its_sentence() {
        let media = SendRefusal::Media;
        assert_eq!(human_send_error(&media(MediaRefusal::NoAlt), true), NO_ALT);
        assert_eq!(
            human_send_error(&media(MediaRefusal::NoTeam), true),
            NO_TEAM
        );
        assert_eq!(
            human_send_error(
                &media(MediaRefusal::Invalid("media.url is not https".into())),
                true
            ),
            CANT_SEND
        );
        assert_eq!(
            human_send_error(&SendRefusal::Store(ChatStoreError::LineTooLong), true),
            TOO_LONG
        );
        assert_eq!(
            human_send_error(&SendRefusal::Store(ChatStoreError::LineTooLong), false),
            ChatStoreError::LineTooLong.to_string()
        );
        assert_eq!(
            human_send_error(&SendRefusal::Store(ChatStoreError::TooLong), true),
            ChatStoreError::TooLong.to_string()
        );
    }
}

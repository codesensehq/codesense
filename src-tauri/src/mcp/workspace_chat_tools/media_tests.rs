// SPDX-License-Identifier: MIT
//! Images on workspace chat posts: the send, admission, registration, the media index
//! owner, loading and reading, and what `workspace_chat_read` tells agents.

use std::sync::Arc;

use super::*;
use crate::commands::agent_inbox::tests::{port, FakeHost};
use crate::commands::agent_inbox::{mark_onloads_sent, InboxHost};
use crate::commands::dashboard_launch::LaunchTeam;
use crate::commands::workspace_chat::media::{load, present, read};
use crate::commands::workspace_chat::{index, ChatAppendMedia, HUMAN};
use crate::media::{Attachment, Config, FakeFetch, MediaInput, MediaProvider, Remote};

const GIF: &[u8] = b"GIF89a\x02\x00\x03\x00";
const TAGGED_URL: &str = "https://media.giphy.com/media/g1/giphy.gif";
const WS: &str = "story:chat";

fn gif_sha() -> String {
    use sha2::Digest as _;
    format!("{:x}", sha2::Sha256::digest(GIF))
}

fn team() -> LaunchTeam {
    LaunchTeam {
        org: "acme".into(),
        team: "default".into(),
    }
}

fn url_media(url: &str) -> MediaInput {
    MediaInput {
        url: Some(url.into()),
        path: None,
        alt: "Typing cat".into(),
        provider: None,
        provider_id: None,
    }
}

fn tagged() -> MediaInput {
    MediaInput {
        provider: Some(MediaProvider::Giphy),
        provider_id: Some("g1".into()),
        ..url_media(TAGGED_URL)
    }
}

fn poster(handle: &str, remote: bool) -> ChatPoster {
    ChatPoster {
        handle: handle.into(),
        from_name: handle.into(),
        workspace: WS.into(),
        remote,
    }
}

fn params(text: &str, media: Option<MediaInput>) -> WorkspaceChatSendParams {
    WorkspaceChatSendParams {
        session_id: String::new(),
        text: text.into(),
        workspace: None,
        content_type: None,
        on_click: None,
        primary_file: None,
        media,
    }
}

/// Post as `poster`, with the first-use anchor the app writes.
async fn send(
    fake: &Arc<FakeHost>,
    poster: ChatPoster,
    text: &str,
    media: Option<MediaInput>,
) -> Result<WorkspaceChatMessage, ErrorData> {
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
    send_core(&host, &store, poster, params(text, media), started).await
}

/// The chat's log bytes (if any) and the chats the store lists.
fn written(fake: &FakeHost) -> (Option<Vec<u8>>, Vec<String>) {
    let log = index::log_path(fake.dir(), &index::workspace_slug(WS));
    let chats = fake
        .chat()
        .list()
        .into_iter()
        .map(|e| e.workspace_id)
        .collect();
    (std::fs::read(log).ok(), chats)
}

fn sidecar(fake: &FakeHost) -> std::path::PathBuf {
    index::chats_dir(fake.dir()).join(format!("{}.media.json", index::workspace_slug(WS)))
}

fn row(fake: &FakeHost, id: i64) -> WorkspaceChatMessage {
    fake.chat().media_message(WS, id).unwrap().unwrap()
}

/// Message `id` once its fetch has left `pending`.
async fn settled(fake: &FakeHost, id: i64) -> WorkspaceChatMessage {
    for _ in 0..200 {
        let row = row(fake, id);
        if row.media_state != Some(ChatMediaState::Pending) {
            return row;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the media fetch never finished");
}

/// Wait until `check` holds, for at most 2 s.
async fn eventually(check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("never happened");
}

/// A fake host whose H1 runs on this machine, serving `GIF` at `url`.
fn serving(url: &str) -> (Arc<FakeHost>, Arc<FakeFetch>, Arc<crate::media::MediaState>) {
    let fake = FakeHost::new();
    let fetch = Arc::new(FakeFetch::default());
    fetch.serve(url, GIF, url, None);
    let media = fake.use_media(fetch.clone());
    fake.own_sender("H1");
    (fake, fetch, media)
}

async fn assert_refused(media: MediaInput, reason: &str) {
    let fake = FakeHost::new();
    fake.own_sender("H1");
    let before = written(&fake);
    let err = send(&fake, poster("H1", false), "look", Some(media))
        .await
        .unwrap_err();
    assert!(err.message.contains(reason), "{err:?}");
    assert_eq!(written(&fake), before, "a refused send writes nothing");
    assert!(fake.media_sent_calls().is_empty());
}

#[tokio::test]
async fn chat_media_send_refuses_a_blank_alt() {
    let media = MediaInput {
        alt: "  ".into(),
        ..url_media(TAGGED_URL)
    };
    assert_refused(media, "media.alt is required").await;
}

#[tokio::test]
async fn chat_media_send_refuses_an_overlong_alt() {
    use crate::commands::workspace_chat::media::MAX_ALT_BYTES;
    let media = MediaInput {
        alt: "a".repeat(MAX_ALT_BYTES + 1),
        ..url_media(TAGGED_URL)
    };
    assert_refused(media, "media.alt exceeds 1024 bytes").await;
    let fake = FakeHost::new();
    fake.own_sender("H1");
    let at_cap = MediaInput {
        alt: "a".repeat(MAX_ALT_BYTES),
        ..url_media(TAGGED_URL)
    };
    let sent = send(&fake, poster("H1", false), "", Some(at_cap))
        .await
        .unwrap();
    assert_eq!(sent.attachments[0].alt.len(), MAX_ALT_BYTES);
}

#[tokio::test]
async fn chat_media_send_refuses_an_overlong_url() {
    use crate::commands::workspace_chat::media::MAX_URL_BYTES;
    let url = format!(
        "https://media.giphy.com/media/{}/giphy.gif",
        "a".repeat(MAX_URL_BYTES)
    );
    assert_refused(url_media(&url), "media.url exceeds 2048 bytes").await;
}

#[tokio::test]
async fn chat_media_send_refuses_a_line_the_log_cannot_read_back() {
    // Inside the text cap, but escaped in JSON past the log's line bound.
    let text = "\u{1}".repeat(12_000);
    let fake = FakeHost::new();
    fake.own_sender("H1");
    let before = written(&fake);
    for media in [Some(url_media(TAGGED_URL)), None] {
        let err = send(&fake, poster("H1", false), &text, media)
            .await
            .unwrap_err();
        assert_eq!(err.code, rmcp::model::ErrorCode::INVALID_PARAMS, "{err:?}");
        assert!(err.message.contains("message exceeds"), "{err:?}");
        assert_eq!(written(&fake), before, "a refused send writes nothing");
    }
    assert!(fake.media_sent_calls().is_empty());
}

#[tokio::test]
async fn chat_media_send_refuses_both_url_and_path() {
    let media = MediaInput {
        path: Some("cat.gif".into()),
        ..url_media(TAGGED_URL)
    };
    assert_refused(media, "media requires exactly one of url or path").await;
}

#[tokio::test]
async fn chat_media_send_refuses_neither_url_nor_path() {
    let media = MediaInput {
        url: None,
        ..url_media(TAGGED_URL)
    };
    assert_refused(media, "media requires exactly one of url or path").await;
}

#[tokio::test]
async fn chat_media_send_refuses_a_provider_without_its_id() {
    let media = MediaInput {
        provider_id: None,
        ..tagged()
    };
    assert_refused(media, "media.provider and media.providerId go together").await;
}

#[tokio::test]
async fn chat_media_send_stores_the_image_on_the_row() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    let media = MediaInput {
        alt: "a cat token: hunter2secret".into(),
        ..tagged()
    };
    let sent = send(&fake, poster("H1", false), "  look  ", Some(media))
        .await
        .unwrap();
    assert_eq!(sent.message_id, 2, "after the first-use anchor");
    assert_eq!(sent.text, "look");
    assert_eq!(sent.media_team, Some(team()));
    assert_eq!(sent.media_state, Some(ChatMediaState::Pending));
    let a = &sent.attachments[0];
    assert_eq!(a.alt, "a cat token: [redacted]", "alt is scanned like text");
    assert_eq!(a.source_url.as_deref(), Some(TAGGED_URL));
    assert!(a.own_sender);
    assert_eq!(a.provider, Some(MediaProvider::Giphy));
    assert_eq!(a.provider_id.as_deref(), Some("g1"));
    // The log keeps the row as sent; the fetch result lands in the sidecar.
    let done = settled(&fake, 2).await;
    assert_eq!(done.media_state, Some(ChatMediaState::Cached));
    assert_eq!(
        done.attachments[0].sha256.as_deref(),
        Some(gif_sha().as_str())
    );
    let page = fake.chat().read(WS, None, None).unwrap();
    assert_eq!(page.messages[1], done);
    assert_eq!(fetch.calls(), [TAGGED_URL]);
    assert_eq!(fake.chat_media_changes(), [(WS.to_string(), 2)]);
}

#[tokio::test]
async fn chat_media_text_is_optional_with_media() {
    let fake = FakeHost::new();
    let sent = send(&fake, poster("H1", false), "   ", Some(tagged()))
        .await
        .unwrap();
    assert_eq!(sent.text, "");
    assert_eq!(sent.attachments.len(), 1);
}

#[tokio::test]
async fn chat_media_text_blank_without_media_is_refused() {
    let fake = FakeHost::new();
    let before = written(&fake);
    let err = send(&fake, poster("H1", false), "  ", None)
        .await
        .unwrap_err();
    assert!(err.message.contains("empty text"), "{err:?}");
    assert_eq!(written(&fake), before);
    let sent = send(&fake, poster("H1", false), "hi", None).await.unwrap();
    assert!(sent.attachments.is_empty());
    assert_eq!(sent.media_team, None);
    assert_eq!(sent.media_state, None);
}

#[tokio::test]
async fn chat_media_registers_once() {
    let fake = FakeHost::new();
    fake.own_sender("H1");
    let first = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    {
        let sent = fake.media_sent_calls();
        assert_eq!(sent.len(), 1);
        let (media, stored_first) = &sent[0];
        assert!(stored_first, "registration runs after the append");
        assert_eq!(media.message_id, first.message_id);
        assert_eq!(media.chat.as_deref(), Some(WS));
        assert_eq!(media.team, team());
        assert_eq!(media.attachment.provider, Some(MediaProvider::Giphy));
        assert_eq!(media.attachment.provider_id.as_deref(), Some("g1"));
    }
    assert_eq!(
        row(&fake, first.message_id).attachments[0].attribution(),
        Some(MediaProvider::Giphy)
    );
    // Each call is a new send: there is no request id to replay.
    let again = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    assert_ne!(again.message_id, first.message_id);
    assert_eq!(fake.media_sent_calls().len(), 2);
    // Text alone registers nothing, and neither does a refused claim.
    send(&fake, poster("H1", false), "hi", None).await.unwrap();
    let wrong = MediaInput {
        provider: Some(MediaProvider::Klipy),
        ..tagged()
    };
    send(&fake, poster("H1", false), "", Some(wrong))
        .await
        .unwrap_err();
    assert_eq!(fake.media_sent_calls().len(), 2);
}

#[tokio::test]
async fn chat_media_never_reaches_disk() {
    let url = "https://i.giphy.com/cat.gif";
    let (fake, fetch, media) = serving(url);
    // From this machine it loads at once; from another machine it waits for a tap.
    let own = send(&fake, poster("H1", false), "", Some(url_media(url)))
        .await
        .unwrap();
    assert_eq!(
        settled(&fake, own.message_id).await.media_state,
        Some(ChatMediaState::Cached)
    );
    let theirs = send(&fake, poster("H1", true), "", Some(url_media(url)))
        .await
        .unwrap();
    assert_eq!(theirs.media_state, Some(ChatMediaState::TapToLoad));
    let host = port(&fake);
    load(&host, WS, theirs.message_id).await.unwrap();
    assert_eq!(
        row(&fake, theirs.message_id).media_state,
        Some(ChatMediaState::Cached)
    );
    let bytes = read(&host, WS, theirs.message_id, &gif_sha())
        .await
        .unwrap();
    assert_eq!(bytes.bytes, GIF);
    assert_eq!(fetch.calls().len(), 2);
    assert!(media.is_memory_only(&gif_sha(), None));
    let cache = fake.dir().join("media-cache");
    let files = std::fs::read_dir(&cache).map(|d| d.count()).unwrap_or(0);
    assert_eq!(files, 0, "nothing under the media cache");
    let log = index::log_path(fake.dir(), &index::workspace_slug(WS));
    for path in [log, sidecar(&fake)] {
        let on_disk = std::fs::read(&path).unwrap();
        assert!(
            !on_disk.windows(GIF.len()).any(|w| w == GIF),
            "no image bytes in {}",
            path.display()
        );
        assert!(!String::from_utf8_lossy(&on_disk).contains("data:"));
    }
}

#[tokio::test]
async fn chat_media_admission_own_sender_on_a_listed_host_autoloads() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    let sent = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    assert_eq!(sent.media_state, Some(ChatMediaState::Pending));
    settled(&fake, sent.message_id).await;
    assert_eq!(fetch.calls(), [TAGGED_URL]);
}

#[tokio::test]
async fn chat_media_admission_remote_sender_waits_for_a_tap() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    // H1 has a tab here, but its session runs on another machine.
    let sent = send(&fake, poster("H1", true), "", Some(tagged()))
        .await
        .unwrap();
    assert_eq!(sent.media_state, Some(ChatMediaState::TapToLoad));
    let a = &sent.attachments[0];
    assert!(!a.own_sender);
    assert_eq!(a.reason.as_deref(), Some("sender"));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(fetch.calls().is_empty());
}

#[tokio::test]
async fn chat_media_admission_off_list_host_waits_for_a_tap() {
    let url = "https://example.com/cat.gif";
    let (fake, fetch, _media) = serving(url);
    let sent = send(&fake, poster("H1", false), "", Some(url_media(url)))
        .await
        .unwrap();
    assert_eq!(sent.media_state, Some(ChatMediaState::TapToLoad));
    assert!(sent.attachments[0].own_sender);
    assert_eq!(sent.attachments[0].reason.as_deref(), Some("host"));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(fetch.calls().is_empty());
}

#[tokio::test]
async fn chat_media_remote_path_refused() {
    let fake = FakeHost::new();
    fake.own_sender("H1");
    let path = MediaInput {
        url: None,
        path: Some("cat.gif".into()),
        ..url_media(TAGGED_URL)
    };
    let before = written(&fake);
    // Refused on the sender, whatever read scope its team gives it.
    let err = send(&fake, poster("H1", true), "", Some(path.clone()))
        .await
        .unwrap_err();
    assert!(err
        .message
        .contains("media.path needs a session on this machine"));
    // A sender with no tab on this machine is refused the same way.
    let err = send(&fake, poster("H2", false), "", Some(path))
        .await
        .unwrap_err();
    assert!(err
        .message
        .contains("media.path needs a session on this machine"));
    assert_eq!(written(&fake), before);
}

#[tokio::test]
async fn chat_media_no_team_refused() {
    let fake = FakeHost::new();
    fake.own_sender("H1");
    fake.set_launch_team("H1", None);
    let before = written(&fake);
    let err = send(&fake, poster("H1", false), "look", Some(tagged()))
        .await
        .unwrap_err();
    assert!(
        err.message.contains("media needs a session in a team"),
        "{err:?}"
    );
    assert_eq!(written(&fake), before);
    assert!(fake.media_sent_calls().is_empty());
    // Its text-only post is unchanged.
    let sent = send(&fake, poster("H1", false), "look", None)
        .await
        .unwrap();
    assert_eq!(sent.text, "look");
}

#[tokio::test]
async fn chat_media_team_off_refuses_load_and_read() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    let cached = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    settled(&fake, cached.message_id).await;
    let held = send(&fake, poster("H1", true), "", Some(tagged()))
        .await
        .unwrap();
    fake.set_media_config(
        "default",
        Config {
            remote: Remote::Off,
            ..Config::default()
        },
    );
    // With the team's media Off, a send's fetch never runs.
    let off = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    assert_eq!(off.media_state, Some(ChatMediaState::TapToLoad));
    let host = port(&fake);
    for id in [held.message_id, off.message_id] {
        let err = load(&host, WS, id).await.unwrap_err();
        assert_eq!(err, "media is off in team config");
    }
    let err = read(&host, WS, cached.message_id, &gif_sha())
        .await
        .unwrap_err();
    assert_eq!(err, "media is off in team config");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(fetch.calls().len(), 1, "only the first send fetched");
}

#[tokio::test]
async fn chat_media_append_completes_while_a_fetch_is_parked() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    let gate = fetch.hold();
    let sent = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    eventually(|| fetch.calls().len() == 1).await;
    // The fetch is parked inside `fetch_media`: no store lock is held across it.
    let posted = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        send(&fake, poster("H1", false), "meanwhile", None),
    )
    .await
    .expect("an append waits on no fetch")
    .unwrap();
    assert_eq!(posted.message_id, sent.message_id + 1);
    assert_eq!(
        row(&fake, sent.message_id).media_state,
        Some(ChatMediaState::Pending),
        "a fetch in flight reads as pending"
    );
    let err = load(&port(&fake), WS, sent.message_id).await.unwrap_err();
    assert_eq!(
        err, "media cannot be loaded",
        "an image in flight loads once"
    );
    gate.notify_one();
    assert_eq!(
        settled(&fake, sent.message_id).await.media_state,
        Some(ChatMediaState::Cached)
    );
}

#[tokio::test]
async fn chat_media_fetch_error_reads_as_failed_and_loads() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    fake.fail_fetches(Some("media fetch unavailable"));
    let sent = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    assert_eq!(sent.media_state, Some(ChatMediaState::Pending));
    let failed = settled(&fake, sent.message_id).await;
    assert_eq!(failed.media_state, Some(ChatMediaState::Failed));
    let a = &failed.attachments[0];
    assert_eq!(
        (a.state.as_str(), a.reason.as_deref(), a.retryable),
        ("failed", Some("fetch"), true)
    );
    let on_disk = std::fs::read_to_string(sidecar(&fake)).unwrap();
    assert!(
        on_disk.contains("\"failed\""),
        "the failure is recorded: {on_disk}"
    );
    fake.fail_fetches(None);
    load(&port(&fake), WS, sent.message_id).await.unwrap();
    assert_eq!(
        row(&fake, sent.message_id).media_state,
        Some(ChatMediaState::Cached)
    );
    assert_eq!(fetch.calls().len(), 1, "only the tap reached the network");
}

#[tokio::test]
async fn chat_media_panicking_fetch_reads_as_interrupted_and_loads() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    fake.panic_fetches(true);
    let sent = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    // The fetch task unwinds without recording a result; its in-flight mark goes with it.
    let failed = settled(&fake, sent.message_id).await;
    assert_eq!(failed.media_state, Some(ChatMediaState::Failed));
    let a = &failed.attachments[0];
    assert_eq!(
        (a.state.as_str(), a.reason.as_deref(), a.retryable),
        ("failed", Some("interrupted"), true)
    );
    fake.panic_fetches(false);
    load(&port(&fake), WS, sent.message_id).await.unwrap();
    assert_eq!(
        row(&fake, sent.message_id).media_state,
        Some(ChatMediaState::Cached)
    );
    assert_eq!(fetch.calls().len(), 1, "only the tap reached the network");
}

#[tokio::test]
async fn chat_media_stale_pending_reads_as_interrupted_and_loads() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    // A previous run of the app appended a pending image and quit before its fetch
    // finished: this process has no fetch in flight for it.
    let earlier = crate::commands::workspace_chat::WorkspaceChatStore::default();
    earlier.install(fake.dir());
    let image = Attachment::remote(TAGGED_URL, "Typing cat", &Config::default(), true).unwrap();
    let stale = earlier
        .append(
            ChatAppend {
                workspace_id: WS.into(),
                from: "H1".into(),
                from_name: "H1".into(),
                text: String::new(),
                kind: MessageKind::Chat,
                content_type: None,
                on_click: None,
                primary_file: None,
                media: Some(ChatAppendMedia {
                    team: team(),
                    attachment: image,
                    state: ChatMediaState::Pending,
                }),
            },
            1,
        )
        .unwrap();
    assert_eq!(
        earlier
            .media_message(WS, stale.message_id)
            .unwrap()
            .unwrap()
            .media_state,
        Some(ChatMediaState::Pending),
        "the run that fetches it reads it as pending"
    );
    let now = row(&fake, stale.message_id);
    assert_eq!(now.media_state, Some(ChatMediaState::Failed));
    let a = &now.attachments[0];
    assert_eq!(
        (a.state.as_str(), a.reason.as_deref(), a.retryable),
        ("failed", Some("interrupted"), true)
    );
    let page = fake.chat().read(WS, Some(0), None).unwrap().messages;
    let read: WorkspaceChatReadMessage = page
        .into_iter()
        .find(|m| m.message_id == stale.message_id)
        .unwrap()
        .into();
    assert_eq!(
        serde_json::to_value(&read).unwrap()["media"]["state"],
        "failed"
    );
    load(&port(&fake), WS, stale.message_id).await.unwrap();
    assert_eq!(
        row(&fake, stale.message_id).media_state,
        Some(ChatMediaState::Cached)
    );
    assert_eq!(fetch.calls().len(), 1);
}

#[tokio::test]
async fn chat_media_app_read_presents_against_the_team() {
    let (fake, _fetch, _media) = serving(TAGGED_URL);
    let cached = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    settled(&fake, cached.message_id).await;
    let host = port(&fake);
    // The log also holds the chat's first-use anchor; the image is on the sent row.
    let mut rows = fake.chat().read(WS, Some(0), None).unwrap().messages;
    present(&*host, WS, &mut rows).await;
    let row = rows
        .iter()
        .find(|m| m.message_id == cached.message_id)
        .unwrap();
    assert_eq!(row.attachments[0].state, "cached");
    assert_eq!(
        row.attachments[0].sha256.as_deref(),
        Some(gif_sha().as_str())
    );
    fake.set_media_config(
        "default",
        Config {
            remote: Remote::Off,
            ..Config::default()
        },
    );
    let mut rows = fake.chat().read(WS, Some(0), None).unwrap().messages;
    present(&*host, WS, &mut rows).await;
    let row = rows
        .iter()
        .find(|m| m.message_id == cached.message_id)
        .unwrap();
    let a = &row.attachments[0];
    assert_eq!(a.state, "blocked", "the team's Off switch wins on the read");
    assert_eq!(a.sha256, None, "a blocked image names no cached bytes");
    assert_eq!(
        row.media_state,
        Some(ChatMediaState::Cached),
        "the row's own state is left as stored"
    );
}

#[tokio::test]
async fn chat_media_read_authority() {
    let (fake, _fetch, media) = serving(TAGGED_URL);
    let served = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = served.clone();
    media.when_served(Arc::new(move |sha: &str| {
        seen.lock().unwrap().push(sha.to_string())
    }));
    let cached = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    settled(&fake, cached.message_id).await;
    let held = send(&fake, poster("H1", true), "", Some(tagged()))
        .await
        .unwrap();
    let text = send(&fake, poster("H1", false), "hi", None).await.unwrap();
    let host = port(&fake);
    let other = "0".repeat(64);
    for (id, sha, reason) in [
        (cached.message_id, "nope", "invalid media hash"),
        (cached.message_id, other.as_str(), "media unavailable"),
        (held.message_id, gif_sha().as_str(), "media unavailable"),
        (text.message_id, gif_sha().as_str(), "message has no media"),
        (99, gif_sha().as_str(), "message unavailable"),
    ] {
        let err = read(&host, WS, id, sha).await.unwrap_err();
        assert_eq!(err, reason, "message {id}");
    }
    assert!(served.lock().unwrap().is_empty());
    let image = read(&host, WS, cached.message_id, &gif_sha())
        .await
        .unwrap();
    assert_eq!(image.mime, "image/gif");
    assert_eq!(image.bytes, GIF);
    assert_eq!(
        *served.lock().unwrap(),
        [gif_sha()],
        "served by the media state"
    );
}

#[tokio::test]
async fn chat_media_load_refusals() {
    let (fake, fetch, _media) = serving(TAGGED_URL);
    let cached = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    settled(&fake, cached.message_id).await;
    let text = send(&fake, poster("H1", false), "hi", None).await.unwrap();
    // A pending image is fetching already.
    let pending = fake
        .chat()
        .append(
            ChatAppend {
                media: Some(ChatAppendMedia {
                    team: team(),
                    attachment: cached.attachments[0].clone(),
                    state: ChatMediaState::Pending,
                }),
                ..ChatAppend {
                    workspace_id: WS.into(),
                    from: "H1".into(),
                    from_name: "H1".into(),
                    text: String::new(),
                    kind: MessageKind::Chat,
                    content_type: None,
                    on_click: None,
                    primary_file: None,
                    media: None,
                }
            },
            9,
        )
        .unwrap();
    let host = port(&fake);
    for (id, reason) in [
        (99, "message unavailable"),
        (text.message_id, "message has no media"),
        (cached.message_id, "media cannot be loaded"),
        (pending.message_id, "media cannot be loaded"),
    ] {
        let err = load(&host, WS, id).await.unwrap_err();
        assert_eq!(err, reason, "message {id}");
    }
    assert_eq!(fetch.calls().len(), 1, "no refusal fetched");
    // A held image loads, and so does a failed one.
    let held = send(&fake, poster("H1", true), "", Some(tagged()))
        .await
        .unwrap();
    load(&host, WS, held.message_id).await.unwrap();
    assert_eq!(fetch.calls().len(), 2);
    // A failed one loads again only when its failure is retryable, as in the inbox.
    let mut failed = held.attachments[0].clone();
    failed.state = "failed".into();
    failed.reason = Some("http".into());
    for retryable in [false, true] {
        failed.retryable = retryable;
        fake.chat()
            .set_media(
                WS,
                held.message_id,
                vec![failed.clone()],
                ChatMediaState::Failed,
            )
            .unwrap();
        let loaded = load(&host, WS, held.message_id).await;
        if retryable {
            loaded.unwrap();
        } else {
            assert_eq!(loaded.unwrap_err(), "media cannot be retried");
        }
    }
    assert_eq!(fetch.calls().len(), 3);
    assert_eq!(
        row(&fake, held.message_id).media_state,
        Some(ChatMediaState::Cached)
    );
}

#[tokio::test]
async fn chat_media_read_projection() {
    let fake = FakeHost::new();
    let store = fake.chat();
    let image =
        |url: &str| Attachment::remote(url, "Typing cat", &Config::default(), true).unwrap();
    let post = |text: &str, media: Option<(Attachment, ChatMediaState)>| ChatAppend {
        workspace_id: WS.into(),
        from: "H1".into(),
        from_name: "H1".into(),
        text: text.into(),
        kind: MessageKind::Chat,
        content_type: None,
        on_click: None,
        primary_file: None,
        media: media.map(|(attachment, state)| ChatAppendMedia {
            team: team(),
            attachment,
            state,
        }),
    };
    for (n, state) in [
        ChatMediaState::Pending,
        ChatMediaState::TapToLoad,
        ChatMediaState::Pending,
        ChatMediaState::Pending,
    ]
    .into_iter()
    .enumerate()
    {
        let url = if n == 1 {
            "https://example.com/cat.gif"
        } else {
            TAGGED_URL
        };
        store
            .append(post("", Some((image(url), state))), 1)
            .unwrap();
    }
    store.append(post("hi", None), 1).unwrap();
    // Message 3 fetched; message 4 failed.
    let mut done = image(TAGGED_URL);
    done.state = "cached".into();
    done.sha256 = Some(gif_sha());
    store
        .set_media(WS, 3, vec![done], ChatMediaState::Cached)
        .unwrap();
    store
        .set_media(WS, 4, vec![image(TAGGED_URL)], ChatMediaState::Failed)
        .unwrap();
    let page = store.read(WS, None, None).unwrap();
    let read: Vec<WorkspaceChatReadMessage> = page.messages.into_iter().map(Into::into).collect();
    let json = serde_json::to_value(&read).unwrap();
    let states: Vec<_> = json
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.pointer("/media/state").cloned())
        .collect();
    assert_eq!(
        states,
        [
            Some(serde_json::json!("pending")),
            Some(serde_json::json!("tapToLoad")),
            Some(serde_json::json!("cached")),
            Some(serde_json::json!("failed")),
            None,
        ]
    );
    assert_eq!(
        json[0]["media"],
        serde_json::json!({"alt": "Typing cat", "provider": "giphy", "state": "pending"})
    );
    assert_eq!(
        json[1]["media"],
        serde_json::json!({"alt": "Typing cat", "state": "tapToLoad"}),
        "no provider for other media"
    );
    let text = serde_json::to_string(&json).unwrap();
    for hidden in [
        "sourceUrl",
        "sha256",
        "attachments",
        "mediaTeam",
        "mediaState",
    ] {
        assert!(!text.contains(hidden), "{hidden} leaked: {text}");
    }
    assert!(json[4].get("media").is_none());
    assert_eq!(json[4]["text"], "hi");
}

/// A cached GIPHY-tagged GIF sent from this machine, with `GIF`'s sha.
fn tagged_cached() -> Attachment {
    let mut a = Attachment::remote(TAGGED_URL, "Typing cat", &Config::default(), true).unwrap();
    a.state = "cached".into();
    a.sha256 = Some(gif_sha());
    a.provider = Some(MediaProvider::Giphy);
    a.provider_id = Some("g1".into());
    a.media_provider = Some(MediaProvider::Giphy);
    a
}

#[tokio::test]
async fn chat_media_owner_refetch_and_onload() {
    let (fake, fetch, media) = serving(TAGGED_URL);
    let gif = crate::gif::register::tests::Harness::new();
    gif.found_all("g1");
    fake.use_registration(gif.registration.clone());
    let host = port(&fake);
    let wire = |media: &Arc<crate::media::MediaState>| {
        let (registration, persist) = (gif.registration.clone(), host.clone());
        media.when_served(crate::gif::register::serve_hook(
            move || Some(registration.clone()),
            Arc::downgrade(media),
            move || persist.clone(),
        ));
    };
    wire(&media);
    let sent = send(&fake, poster("H1", false), "", Some(tagged()))
        .await
        .unwrap();
    let id = sent.message_id;
    settled(&fake, id).await;
    eventually(|| gif.wire.actions() == ["SENT"]).await;
    // The first view pings once, and the chat sidecar records it.
    read(&host, WS, id, &gif_sha()).await.unwrap();
    eventually(|| gif.wire.actions() == ["SENT", "SEEN"]).await;
    eventually(|| row(&fake, id).attachments[0].onload_sent).await;

    // A restart: memory and index cleared. The chat is indexed on
    // its first read, so the saved own-machine URL is fetched again, and the settled view
    // ping is never claimed again.
    let media = fake.use_media(fetch.clone());
    wire(&media);
    assert_eq!(media.index.refetch_url(&gif_sha()), None);
    let image = read(&host, WS, id, &gif_sha()).await.unwrap();
    assert_eq!(image.bytes, GIF);
    assert_eq!(fetch.calls().len(), 2);
    assert_eq!(
        media.index.refetch_url(&gif_sha()).as_deref(),
        Some(TAGGED_URL)
    );
    assert!(media.index.claim_onloads(&gif_sha()).is_empty());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(gif.wire.actions(), ["SENT", "SEEN"]);
}

#[tokio::test]
async fn chat_media_owner_claim_given_back_is_claimed_again() {
    let fake = FakeHost::new();
    let media = fake.use_media(Arc::new(FakeFetch::default()));
    let host = port(&fake);
    let mut sent = fake
        .chat()
        .append(
            ChatAppend {
                workspace_id: WS.into(),
                from: "H1".into(),
                from_name: "H1".into(),
                text: String::new(),
                kind: MessageKind::Chat,
                content_type: None,
                on_click: None,
                primary_file: None,
                media: Some(ChatAppendMedia {
                    team: team(),
                    attachment: tagged_cached(),
                    state: ChatMediaState::Cached,
                }),
            },
            1,
        )
        .unwrap();
    host.index_chat_media(WS).await;
    let claimed = media.index.claim_onloads(&gif_sha());
    let owner = crate::commands::workspace_chat::media::owner(&team(), WS, sent.message_id);
    assert_eq!(claimed, [(owner.clone(), 0)]);
    media.index.release_onloads(&gif_sha(), &claimed);
    let claimed = media.index.claim_onloads(&gif_sha());
    assert_eq!(claimed, [(owner, 0)]);
    mark_onloads_sent(&host, claimed).await;
    sent.attachments[0].onload_sent = true;
    assert_eq!(row(&fake, sent.message_id).attachments, sent.attachments);
    assert!(media.index.claim_onloads(&gif_sha()).is_empty());
}

#[tokio::test]
async fn chat_media_owner_same_id_stays_apart() {
    let fake = FakeHost::new();
    let media = fake.use_media(Arc::new(FakeFetch::default()));
    let host = port(&fake);
    // Inbox message 1 in team `default` and chat message 1 carry the same GIF.
    let path = fake.team_store("default");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let inbox_store = crate::weft::WeftStore::open(path).unwrap();
    let inbox_id = crate::weft::inbox::inbox_insert(
        &inbox_store,
        "H1",
        HUMAN,
        "hi",
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    crate::weft::inbox::inbox_set_attachments(&inbox_store, inbox_id, &[tagged_cached()]).unwrap();
    host.note_media(&team(), inbox_id, &[tagged_cached()]).await;
    let chat = fake
        .chat()
        .append(
            ChatAppend {
                workspace_id: WS.into(),
                from: "H1".into(),
                from_name: "H1".into(),
                text: String::new(),
                kind: MessageKind::Chat,
                content_type: None,
                on_click: None,
                primary_file: None,
                media: Some(ChatAppendMedia {
                    team: team(),
                    attachment: tagged_cached(),
                    state: ChatMediaState::Cached,
                }),
            },
            1,
        )
        .unwrap();
    assert_eq!(chat.message_id, inbox_id);
    let chat_owner = crate::commands::workspace_chat::media::owner(&team(), WS, chat.message_id);
    host.note_chat_media(chat_owner.clone(), &chat.attachments)
        .await;
    let claimed = media.index.claim_onloads(&gif_sha());
    assert_eq!(claimed.len(), 2, "two owners: {claimed:?}");
    let (to_chat, to_inbox): (Vec<_>, Vec<_>) =
        claimed.into_iter().partition(|(o, _)| o.chat.is_some());
    let inbox_onload = || {
        crate::weft::inbox::inbox_get(&inbox_store, inbox_id)
            .unwrap()
            .unwrap()
            .attachments[0]
            .onload_sent
    };
    // The chat owner's view ping marks only the chat message.
    mark_onloads_sent(&host, to_chat).await;
    assert!(row(&fake, chat.message_id).attachments[0].onload_sent);
    assert!(!inbox_onload());
    mark_onloads_sent(&host, to_inbox).await;
    assert!(inbox_onload());
    // Forgetting the chat message's references leaves the inbox message's.
    host.note_chat_media(chat_owner, &[]).await;
    let owners: Vec<_> = media
        .index
        .references(&gif_sha())
        .into_iter()
        .map(|r| r.owner)
        .collect();
    assert_eq!(owners.len(), 1);
    assert_eq!(owners[0].chat, None);
    assert_eq!(owners[0].message_id, inbox_id);
}

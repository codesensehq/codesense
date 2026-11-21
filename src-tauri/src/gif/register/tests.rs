// SPDX-License-Identifier: MIT
use super::*;
use crate::commands::credential_store::{CredentialStore, FakeStore};
use crate::gif::giphy::{Failure, Giphy, Reply, Transport};
use crate::gif::settings::{Keys, SettingsUpdate};
use crate::gif::{Adapters, Candidate, Found, GifProvider, Pingbacks};
use std::sync::atomic::{AtomicI64, Ordering};

const ACCOUNT: &str = "someone";
const KEY: &str = "fake-gif-key-for-tests-7f3a";
const OTHER_KEY: &str = "another-fake-gif-key-for-tests-91c";
const START_MS: i64 = 1_800_000_000_000;
const MINUTE: i64 = 60 * 1000;
const URL: &str = "https://media.giphy.com/media/g1/giphy.gif";
const STILL: &str = "https://media.giphy.com/media/g1/giphy_s.gif";
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// GIPHY's network as the tests need it: the random id call answers [`Wire::random`], a
/// pingback answers [`Wire::ping_status`], a search answers no results. Every URL is kept.
struct Wire {
    urls: Mutex<Vec<url::Url>>,
    random: Mutex<Result<Reply, Failure>>,
    ping_status: Mutex<u16>,
}
impl Wire {
    fn new() -> Self {
        Self {
            urls: Mutex::new(Vec::new()),
            random: Mutex::new(Ok(reply(200, r#"{"data":{"random_id":"rid-123"}}"#))),
            ping_status: Mutex::new(200),
        }
    }
    fn urls(&self) -> Vec<url::Url> {
        self.urls.lock().unwrap().clone()
    }
    /// The pingbacks sent, `SENT` or `SEEN`, in order.
    fn pings(&self) -> Vec<url::Url> {
        self.urls()
            .into_iter()
            .filter(|u| u.host_str() == Some("pingback.giphy.com"))
            .collect()
    }
    fn actions(&self) -> Vec<String> {
        self.pings()
            .iter()
            .map(|u| pair(u, "action_type").unwrap_or_default())
            .collect()
    }
    fn random_calls(&self) -> usize {
        self.urls()
            .iter()
            .filter(|u| u.path() == "/v1/randomid")
            .count()
    }
}
fn reply(status: u16, body: &str) -> Reply {
    Reply {
        status,
        retry_after: None,
        body: body.as_bytes().to_vec(),
    }
}
fn pair(url: &url::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}
impl Transport for Wire {
    fn get<'a>(&'a self, url: &'a url::Url) -> BoxFuture<'a, Result<Reply, Failure>> {
        self.urls.lock().unwrap().push(url.clone());
        let answer = if url.path() == "/v1/randomid" {
            self.random.lock().unwrap().clone()
        } else if url.host_str() == Some("pingback.giphy.com") {
            Ok(reply(*self.ping_status.lock().unwrap(), ""))
        } else {
            Ok(reply(200, r#"{"data":[]}"#))
        };
        Box::pin(async move { answer })
    }
}

struct Harness {
    dir: tempfile::TempDir,
    wire: Arc<Wire>,
    now: Arc<AtomicI64>,
    service: Arc<GifService>,
    registration: Registration,
}
impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FakeStore::default());
        store.set(ACCOUNT, &Secret::new(KEY)).unwrap();
        let keys = Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3));
        let wire = Arc::new(Wire::new());
        let now = Arc::new(AtomicI64::new(START_MS));
        let adapter_wire: Arc<dyn Transport> = wire.clone();
        let adapters: Adapters = Arc::new(
            move |_: Provider, key: Secret, now: i64| -> Box<dyn GifProvider> {
                Box::new(Giphy::new(key, adapter_wire.clone(), now))
            },
        );
        let clock_now = now.clone();
        let clock: crate::gif::Clock = Arc::new(move || clock_now.load(Ordering::SeqCst));
        let service = Arc::new(GifService::new(
            dir.path().to_path_buf(),
            keys,
            adapters,
            clock.clone(),
        ));
        let registration = Registration::new(service.clone(), wire.clone(), clock);
        Self {
            dir,
            wire,
            now,
            service,
            registration,
        }
    }
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
    /// A search returned GIF `id` at `URL` (still `STILL`) with these pingbacks.
    fn found(&self, id: &str, pingbacks: Pingbacks) {
        let candidate = Candidate {
            provider: Provider::Giphy,
            id: id.into(),
            title: "cat".into(),
            url: URL.into(),
            preview_url: STILL.into(),
            width: 480,
            height: 270,
            auto_loads: true,
        };
        self.service.analytics.record(
            Provider::Giphy,
            &[Found {
                candidate,
                pingbacks: Some(pingbacks),
            }],
            self.now(),
        );
    }
    fn found_all(&self, id: &str) {
        self.found(id, all_pingbacks());
    }
    fn keys(&self) -> Keys {
        self.service.keys.clone()
    }
    fn install_file(&self) -> std::path::PathBuf {
        self.dir.path().join(FILE)
    }
    fn bucket_key(&self) -> String {
        crate::gif::bucket_key(Provider::Giphy, &crate::gif::fingerprint(&Secret::new(KEY)))
    }
    async fn send(&self, message_id: i64, id: &str, url: &str) {
        self.registration
            .register_send(sent(message_id, id, url))
            .await;
    }
}

fn all_pingbacks() -> Pingbacks {
    let url = |action: &str| {
        Some(format!(
            "https://pingback.giphy.com/v2/pingback_simple?analytics_response_payload=p&action_type={action}&api_key=leaked"
        ))
    };
    Pingbacks {
        onload: url("SEEN"),
        onclick: url("CLICK"),
        onsent: url("SENT"),
    }
}

fn slot(message_id: i64) -> Slot {
    (
        Owner {
            org: "acme".into(),
            team: "core".into(),
            message_id,
        },
        0,
    )
}

fn sent(message_id: i64, id: &str, url: &str) -> Sent {
    Sent {
        slot: slot(message_id),
        provider: MediaProvider::Giphy,
        provider_id: id.into(),
        url: url.into(),
    }
}

#[tokio::test]
async fn a_bound_send_pings_onsent_once_per_message_with_the_install_id_and_never_the_key() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 1);
    assert_eq!(h.wire.actions(), vec!["SENT"]);
    let ping = &h.wire.pings()[0];
    assert_eq!(pair(ping, "random_id").as_deref(), Some("rid-123"));
    assert_eq!(pair(ping, "ts"), Some(h.now().to_string()));
    assert_eq!(
        pair(ping, "analytics_response_payload").as_deref(),
        Some("p")
    );
    // The same GIF sent again in that message is one send; the still URL binds too.
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.actions(), vec!["SENT"]);
    h.send(2, "g1", STILL).await;
    assert_eq!(h.wire.actions(), vec!["SENT", "SENT"]);
    assert_eq!(
        h.wire.random_calls(),
        1,
        "the install id is made once and kept"
    );
    for ping in h.wire.pings() {
        assert!(!ping.as_str().contains("api_key"), "{ping}");
        assert!(!ping.as_str().contains(KEY));
    }
    // The file holds the id and the key's fingerprint, readable by this user only.
    let file = std::fs::read_to_string(h.install_file()).unwrap();
    assert!(file.contains("rid-123") && !file.contains(KEY), "{file}");
    let opened = std::fs::File::open(h.install_file()).unwrap();
    assert!(codesense_platform::fs::is_owner_only(&opened).unwrap());
}

#[tokio::test]
async fn each_skip_sends_nothing() {
    let h = Harness::new();
    // No search returned it.
    h.send(1, "unknown", URL).await;
    // A KLIPY send registers later.
    let mut klipy = sent(2, "g1", "https://static.klipy.com/a.gif");
    klipy.provider = MediaProvider::Klipy;
    h.found_all("g1");
    h.registration.register_send(klipy).await;
    // The id sent with another GIF's URL.
    h.send(3, "g1", "https://media.giphy.com/media/other/giphy.gif")
        .await;
    // No onsent URL in the search's pingbacks.
    h.found(
        "g2",
        Pingbacks {
            onsent: None,
            ..all_pingbacks()
        },
    );
    h.send(4, "g2", URL).await;
    assert!(h.wire.urls().is_empty(), "{:?}", h.wire.urls());
    // An unbound send arms no onload, even once its fetch finishes.
    h.registration.note_fetched(&slot(3), Some(SHA), true);
    assert!(h.registration.take_onloads(SHA).is_empty());
}

#[tokio::test]
async fn off_or_no_key_makes_no_call_and_turning_off_or_removing_the_key_deletes_the_id() {
    let h = Harness::new();
    h.found_all("g1");
    // Sent while On: its onload is pending when search is turned Off.
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    assert!(h.install_file().exists());
    let calls = h.wire.urls().len();
    let off = SettingsUpdate {
        enabled: Some(false),
        ..SettingsUpdate::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), off).unwrap();
    assert!(!h.install_file().exists(), "Off deletes the install id");
    h.send(2, "g1", URL).await;
    let taken = h.registration.take_onloads(SHA);
    assert_eq!(taken.len(), 1);
    let marks = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(marks, vec![slot(1)], "marked, so it never fires later");
    assert_eq!(
        h.wire.urls().len(),
        calls,
        "no onsent, onload or random id while Off"
    );
    assert!(!h.install_file().exists());

    let on = SettingsUpdate {
        enabled: Some(true),
        ..SettingsUpdate::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), on).unwrap();
    h.send(3, "g1", URL).await;
    assert!(h.install_file().exists());
    settings::remove_with(&h.keys(), h.dir.path()).unwrap();
    assert!(
        !h.install_file().exists(),
        "removing the key deletes the install id"
    );
    let calls = h.wire.urls().len();
    h.send(4, "g1", URL).await;
    assert_eq!(h.wire.urls().len(), calls, "no call without a key");
    assert!(!h.install_file().exists());
}

#[tokio::test]
async fn a_provider_backoff_drops_pings_and_a_ping_429_never_sets_one() {
    let h = Harness::new();
    h.found_all("g1");
    let key = h.bucket_key();
    h.service.bucket.back_off(&key, 60, h.now());
    h.send(1, "g1", URL).await;
    assert!(h.wire.pings().is_empty(), "dropped during the backoff");
    h.advance(61_000);
    h.found_all("g1");
    *h.wire.ping_status.lock().unwrap() = 429;
    h.send(2, "g1", URL).await;
    assert_eq!(h.wire.actions(), vec!["SENT"]);
    assert_eq!(h.service.bucket.backoff_until(&key, h.now()), None);
    // Pings are not searches: the search bucket counted none of them.
    let rate = std::fs::read_to_string(h.dir.path().join(crate::gif::bucket::FILE)).unwrap();
    assert!(!rate.contains("\"searches\":[1"), "{rate}");
}

#[tokio::test]
async fn the_301st_ping_in_an_hour_is_dropped() {
    let h = Harness::new();
    h.found_all("g1");
    for message in 0..=PINGS_PER_HOUR as i64 {
        h.send(message, "g1", URL).await;
    }
    assert_eq!(h.wire.pings().len(), PINGS_PER_HOUR);
    h.advance(ONLOAD_WINDOW_MS);
    h.found_all("g1");
    h.send(1_000, "g1", URL).await;
    assert_eq!(
        h.wire.pings().len(),
        PINGS_PER_HOUR + 1,
        "the hour rolls on"
    );
}

#[tokio::test]
async fn a_random_id_that_is_not_an_id_or_a_failed_call_skips_pings_and_search_still_works() {
    let h = Harness::new();
    h.found_all("g1");
    *h.wire.random.lock().unwrap() = Ok(reply(200, r#"{"data":{"random_id":"not an id!"}}"#));
    h.send(1, "g1", URL).await;
    assert!(h.wire.pings().is_empty());
    assert!(!h.install_file().exists(), "a refused id is never saved");
    *h.wire.random.lock().unwrap() = Err(Failure::Timeout);
    h.send(2, "g1", URL).await;
    assert!(h.wire.pings().is_empty());
    let request = crate::gif::normalize(Some("cat"), None, None).unwrap();
    assert!(h.service.run(&request, None, None).await.is_ok());
    // Once GIPHY answers, pings go out.
    *h.wire.random.lock().unwrap() = Ok(reply(200, r#"{"data":{"random_id":"rid-9"}}"#));
    h.send(3, "g1", URL).await;
    assert_eq!(h.wire.actions(), vec!["SENT"]);
}

#[tokio::test]
async fn a_new_key_gets_a_new_install_id() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 1);
    settings::save_with(&h.keys(), h.dir.path(), OTHER_KEY).unwrap();
    assert!(!h.install_file().exists());
    *h.wire.random.lock().unwrap() = Ok(reply(200, r#"{"data":{"random_id":"rid-new"}}"#));
    h.send(2, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 2);
    assert_eq!(
        pair(&h.wire.pings()[1], "random_id").as_deref(),
        Some("rid-new")
    );
    // A file left by another key is not used: the fingerprint doesn't match.
    let fp = crate::gif::fingerprint(&Secret::new(OTHER_KEY));
    assert_eq!(
        read_install(h.dir.path(), Provider::Giphy, &fp).as_deref(),
        Some("rid-new")
    );
    assert_eq!(
        read_install(h.dir.path(), Provider::Giphy, "0000000000000000"),
        None
    );
}

#[tokio::test]
async fn onload_fires_once_within_the_hour_from_the_send_not_the_search() {
    let h = Harness::new();
    h.found_all("g1");
    h.advance(50 * MINUTE);
    h.send(1, "g1", URL).await;
    // The fetch finishes after the send; it could as well finish first.
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    h.advance(30 * MINUTE);
    let taken = h.registration.take_onloads(SHA);
    assert_eq!(taken.len(), 1);
    let marks = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(marks, vec![slot(1)]);
    assert_eq!(h.wire.actions(), vec!["SENT", "SEEN"]);
    let seen = &h.wire.pings()[1];
    assert_eq!(pair(seen, "random_id").as_deref(), Some("rid-123"));
    assert!(!seen.as_str().contains("api_key"));
    // A second serve, at another chunk offset, takes nothing.
    assert!(h.registration.take_onloads(SHA).is_empty());
    h.registration.settle_serve(Vec::new(), Vec::new()).await;
    assert_eq!(h.wire.actions(), vec!["SENT", "SEEN"]);
}

#[tokio::test]
async fn a_fetch_finished_before_the_send_still_gets_its_onload() {
    let h = Harness::new();
    h.found_all("g1");
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    h.send(1, "g1", URL).await;
    let taken = h.registration.take_onloads(SHA);
    h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(h.wire.actions(), vec!["SENT", "SEEN"]);
}

#[tokio::test]
async fn a_serve_of_a_shared_sha_fires_and_marks_both_attachments() {
    let h = Harness::new();
    h.found_all("g1");
    for message in [1, 2] {
        h.send(message, "g1", URL).await;
        h.registration.note_fetched(&slot(message), Some(SHA), true);
    }
    let taken = h.registration.take_onloads(SHA);
    assert_eq!(taken.len(), 2);
    let marks = h
        .registration
        .settle_serve(vec![slot(1), slot(2)], taken)
        .await;
    assert_eq!(marks.len(), 2);
    assert_eq!(h.wire.actions(), vec!["SENT", "SENT", "SEEN", "SEEN"]);
}

#[tokio::test]
async fn concurrent_serves_take_a_pending_onload_once() {
    let h = Arc::new(Harness::new());
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    let takers: Vec<_> = (0..8)
        .map(|_| {
            let h = h.clone();
            std::thread::spawn(move || h.registration.take_onloads(SHA).len())
        })
        .collect();
    let taken: usize = takers.into_iter().map(|t| t.join().unwrap()).sum();
    assert_eq!(taken, 1);
}

#[tokio::test]
async fn an_expired_onload_is_marked_without_firing() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    h.advance(ONLOAD_WINDOW_MS + 1);
    let taken = h.registration.take_onloads(SHA);
    let marks = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(marks, vec![slot(1)]);
    assert_eq!(h.wire.actions(), vec!["SENT"]);
}

#[tokio::test]
async fn after_a_restart_the_first_view_marks_without_firing() {
    let h = Harness::new();
    // Nothing pending in this run: the send was before the restart.
    let marks = h.registration.settle_serve(vec![slot(1)], Vec::new()).await;
    assert_eq!(marks, vec![slot(1)]);
    assert!(h.wire.urls().is_empty());
}

#[tokio::test]
async fn a_tag_dropped_by_a_redirect_loses_its_onload() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), Some(SHA), false);
    assert!(h.registration.take_onloads(SHA).is_empty());
}

#[test]
fn a_pingback_url_keeps_giphy_hosts_and_never_carries_a_key() {
    let url = pingback_url(
        "https://pingback.giphy.com/v2/pingback_simple?a=1&api_key=k&random_id=old&ts=1",
        "rid",
        42,
    )
    .unwrap();
    assert_eq!(
        url.as_str(),
        "https://pingback.giphy.com/v2/pingback_simple?a=1&random_id=rid&ts=42"
    );
    assert_eq!(pingback_url("https://evil.test/p?a=1", "rid", 42), None);
    assert_eq!(pingback_url("http://pingback.giphy.com/p", "rid", 42), None);
}

#[test]
fn the_registration_client_builds() {
    assert!(ping_client().is_ok());
}

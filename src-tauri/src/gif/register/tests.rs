// SPDX-License-Identifier: MIT
use super::*;
use crate::commands::credential_store::{CredentialStore, FakeStore};
use crate::gif::giphy::Giphy;
use crate::gif::settings::{Keys, SettingsUpdate};
use crate::gif::transport::{Failure, Reply, Transport};
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
pub(crate) struct Wire {
    urls: Mutex<Vec<url::Url>>,
    /// Every pingback waits this long first.
    pub(crate) ping_delay: Mutex<Option<Duration>>,
    random: Mutex<Result<Reply, Failure>>,
    ping_status: Mutex<u16>,
    /// Runs while the random id call is in flight.
    during_random: Mutex<Option<Box<dyn Fn() + Send>>>,
    /// What a search answers, and what runs while it is in flight.
    search_body: Mutex<String>,
    during_search: Mutex<Option<Box<dyn Fn() + Send>>>,
}
impl Wire {
    fn new() -> Self {
        Self {
            urls: Mutex::new(Vec::new()),
            random: Mutex::new(Ok(reply(200, r#"{"data":{"random_id":"rid-123"}}"#))),
            ping_status: Mutex::new(200),
            during_random: Mutex::new(None),
            search_body: Mutex::new(r#"{"data":[]}"#.to_string()),
            during_search: Mutex::new(None),
            ping_delay: Mutex::new(None),
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
    pub(crate) fn actions(&self) -> Vec<String> {
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
            if let Some(during) = &*self.during_random.lock().unwrap() {
                during();
            }
            self.random.lock().unwrap().clone()
        } else if url.host_str() == Some("pingback.giphy.com") {
            Ok(reply(*self.ping_status.lock().unwrap(), ""))
        } else {
            if let Some(during) = &*self.during_search.lock().unwrap() {
                during();
            }
            Ok(reply(200, &self.search_body.lock().unwrap()))
        };
        let delay = *self.ping_delay.lock().unwrap();
        Box::pin(async move {
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            answer
        })
    }
}

/// A registration over a temp data dir with a saved key, GIF search On, the [`Wire`] and a
/// clock the test moves.
pub(crate) struct Harness {
    dir: tempfile::TempDir,
    pub(crate) wire: Arc<Wire>,
    now: Arc<AtomicI64>,
    service: Arc<GifService>,
    pub(crate) registration: Arc<Registration>,
}
impl Harness {
    pub(crate) fn new() -> Self {
        let store = Arc::new(FakeStore::default());
        store.set(ACCOUNT, &Secret::new(KEY)).unwrap();
        Self::over(store)
    }

    /// The harness over this keychain.
    fn over(store: Arc<dyn CredentialStore>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3));
        let wire = Arc::new(Wire::new());
        let now = Arc::new(AtomicI64::new(START_MS));
        let adapter_wire: Arc<dyn Transport> = wire.clone();
        let adapters: Adapters = Arc::new(
            move |_: Provider, key: Secret, _: Option<String>, now: i64| -> Box<dyn GifProvider> {
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
        let registration = Arc::new(Registration::new(service.clone(), wire.clone(), clock));
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
        // As a search does: entries from before an epoch change go first.
        let epoch = install_epoch(self.dir.path());
        crate::gif::analytics::Analytics::start_epoch(&self.service.analytics, epoch);
        self.service.analytics.record(
            Provider::Giphy,
            &[Found {
                candidate,
                pingbacks: Some(pingbacks),
            }],
            crate::gif::Rating::Pg,
            Some("ship it"),
            self.now(),
        );
    }
    pub(crate) fn found_all(&self, id: &str) {
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
            chat: None,
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
    // An unbound send arms no onload, even once its fetch finishes: its serve marks it.
    h.registration.note_fetched(&slot(3), Some(SHA), true);
    let taken = h.registration.take_onloads(SHA);
    assert!(taken.iter().all(|(_, p)| p.onload.is_none()));
    let settled = h.registration.settle_serve(vec![slot(3)], taken).await;
    assert_eq!(settled.marks, vec![slot(3)]);
    assert!(h.wire.urls().is_empty());
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
    assert!(taken.is_empty(), "Off lets go of pending onloads");
    let marks = h
        .registration
        .settle_serve(vec![slot(1)], taken)
        .await
        .marks;
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
    h.found_all("g1");
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
    // The install id call, which carries the key, counts as one of the hour's calls.
    assert_eq!(h.wire.random_calls(), 1);
    assert_eq!(h.wire.pings().len(), PINGS_PER_HOUR - 1);
    h.advance(ONLOAD_WINDOW_MS);
    h.found_all("g1");
    h.send(1_000, "g1", URL).await;
    assert_eq!(h.wire.pings().len(), PINGS_PER_HOUR, "the hour rolls on");
}

#[tokio::test]
async fn a_random_id_that_is_not_an_id_or_a_failed_call_skips_pings_and_search_still_works() {
    let h = Harness::new();
    h.found_all("g1");
    *h.wire.random.lock().unwrap() = Ok(reply(200, r#"{"data":{"random_id":"not an id!"}}"#));
    h.send(1, "g1", URL).await;
    assert!(h.wire.pings().is_empty());
    assert!(!h.install_file().exists(), "a refused id is never saved");
    h.advance(RANDOM_ID_RETRY_MS);
    *h.wire.random.lock().unwrap() = Err(Failure::Timeout);
    h.send(2, "g1", URL).await;
    assert!(h.wire.pings().is_empty());
    assert_eq!(h.wire.random_calls(), 2);
    let request = crate::gif::normalize(Some("cat"), None, None).unwrap();
    assert!(h.service.run(&request, None, None).await.is_ok());
    // Once GIPHY answers, pings go out.
    h.advance(RANDOM_ID_RETRY_MS);
    h.found_all("g1");
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
    h.found_all("g1");
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
    let marks = h
        .registration
        .settle_serve(vec![slot(1)], taken)
        .await
        .marks;
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
        .await
        .marks;
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
    let marks = h
        .registration
        .settle_serve(vec![slot(1)], taken)
        .await
        .marks;
    assert_eq!(marks, vec![slot(1)]);
    assert_eq!(h.wire.actions(), vec!["SENT"]);
}

#[tokio::test]
async fn after_a_restart_the_first_view_marks_without_firing() {
    let h = Harness::new();
    // Nothing pending in this run: the send was before the restart.
    let marks = h
        .registration
        .settle_serve(vec![slot(1)], Vec::new())
        .await
        .marks;
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

#[tokio::test]
async fn a_failing_random_id_call_is_retried_at_most_every_fifteen_minutes() {
    let h = Harness::new();
    h.found_all("g1");
    *h.wire.random.lock().unwrap() = Ok(reply(500, ""));
    for message in 0..5 {
        h.send(message, "g1", URL).await;
        h.registration.note_fetched(&slot(message), Some(SHA), true);
    }
    // A serve with onloads due asks for no id either, and its onloads stay pending.
    let taken = h.registration.take_onloads(SHA);
    assert_eq!(taken.len(), 5);
    let settled = h
        .registration
        .settle_serve((0..5).map(slot).collect(), taken)
        .await;
    assert!(settled.marks.is_empty());
    assert_eq!(settled.retry.len(), 5);
    assert_eq!(h.wire.random_calls(), 1);
    assert!(h.wire.pings().is_empty());
    // Once the id can be had, a later serve fires them.
    h.advance(RANDOM_ID_RETRY_MS);
    *h.wire.random.lock().unwrap() = Ok(reply(200, r#"{"data":{"random_id":"rid-1"}}"#));
    let taken = h.registration.take_onloads(SHA);
    assert_eq!(taken.len(), 5);
    let settled = h
        .registration
        .settle_serve((0..5).map(slot).collect(), taken)
        .await;
    assert_eq!(settled.marks.len(), 5);
    assert_eq!(h.wire.random_calls(), 2);
    assert_eq!(h.wire.actions(), vec!["SEEN"; 5]);
}

#[tokio::test]
async fn no_random_id_call_during_a_provider_backoff() {
    let h = Harness::new();
    h.found_all("g1");
    h.service.bucket.back_off(&h.bucket_key(), 60, h.now());
    h.send(1, "g1", URL).await;
    assert!(h.wire.urls().is_empty(), "{:?}", h.wire.urls());
}

#[tokio::test]
async fn an_id_made_while_search_is_turned_off_is_never_saved() {
    let h = Harness::new();
    h.found_all("g1");
    let dir = h.dir.path().to_path_buf();
    *h.wire.during_random.lock().unwrap() = Some(Box::new(move || forget_install(&dir)));
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 1);
    assert!(!h.install_file().exists());
    assert!(h.wire.pings().is_empty());
}

#[tokio::test]
async fn turning_search_off_and_on_or_replacing_the_key_forgets_what_the_old_id_held() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    for enabled in [false, true] {
        let change = SettingsUpdate {
            enabled: Some(enabled),
            ..SettingsUpdate::default()
        };
        settings::set_with(&h.keys(), h.dir.path(), change).unwrap();
    }
    let calls = h.wire.urls().len();
    // The search entry, the pending onload and the sent record are gone: the GIF needs a new
    // search before it registers again, so no ping repeats the old payload with a new id.
    assert!(h.registration.take_onloads(SHA).is_empty());
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.urls().len(), calls);
    assert_eq!(h.service.analytics.held_count(), 0);
    // Replacing the key forgets them too.
    h.found_all("g1");
    settings::save_with(&h.keys(), h.dir.path(), OTHER_KEY).unwrap();
    h.send(2, "g1", URL).await;
    assert_eq!(h.wire.urls().len(), calls);
    assert_eq!(h.service.analytics.held_count(), 0);
}

#[tokio::test]
async fn a_send_that_cannot_register_never_reads_the_keychain() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(CountingStore::default());
    let keys = Keys::new(store.clone(), true, Some(ACCOUNT), Duration::from_secs(3));
    let wire = Arc::new(Wire::new());
    let adapters: Adapters = Arc::new(
        move |_: Provider, key: Secret, _: Option<String>, now: i64| -> Box<dyn GifProvider> {
            Box::new(Giphy::new(key, Arc::new(Wire::new()), now))
        },
    );
    let clock: crate::gif::Clock = Arc::new(|| START_MS);
    let service = Arc::new(GifService::new(
        dir.path().to_path_buf(),
        keys,
        adapters,
        clock.clone(),
    ));
    let registration = Registration::new(service, wire, clock);
    // No search returned it, and an id with another GIF's URL: neither reads the keychain.
    registration.register_send(sent(1, "unknown", URL)).await;
    assert_eq!(store.gets.load(Ordering::SeqCst), 0);
}

/// A keychain with no key that counts its reads.
#[derive(Default)]
struct CountingStore {
    gets: std::sync::atomic::AtomicUsize,
}
impl CredentialStore for CountingStore {
    fn get(
        &self,
        _: &str,
    ) -> Result<Option<Secret>, crate::commands::credential_store::CredentialError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
    fn set(
        &self,
        _: &str,
        _: &Secret,
    ) -> Result<(), crate::commands::credential_store::CredentialError> {
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<(), crate::commands::credential_store::CredentialError> {
        Ok(())
    }
}

#[tokio::test]
async fn a_serve_before_the_send_is_registered_keeps_the_onload_pending() {
    let h = Harness::new();
    h.found_all("g1");
    h.registration.expect_send(&slot(1));
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    let taken = h.registration.take_onloads(SHA);
    let settled = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(
        (settled.marks.len(), settled.retry.clone()),
        (0, vec![slot(1)])
    );
    h.send(1, "g1", URL).await;
    let taken = h.registration.take_onloads(SHA);
    let settled = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(settled.marks, vec![slot(1)]);
    assert_eq!(h.wire.actions(), vec!["SENT", "SEEN"]);
}

#[tokio::test]
async fn a_failed_fetch_keeps_the_onload_for_a_retry() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), None, true);
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    let taken = h.registration.take_onloads(SHA);
    assert!(taken[0].1.onload.is_some());
    h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(h.wire.actions(), vec!["SENT", "SEEN"]);
}

#[tokio::test]
async fn a_taken_onload_the_index_did_not_claim_goes_back() {
    let h = Harness::new();
    h.found_all("g1");
    h.send(1, "g1", URL).await;
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    let taken = h.registration.take_onloads(SHA);
    let settled = h.registration.settle_serve(Vec::new(), taken).await;
    assert_eq!(settled, Settled::default());
    assert_eq!(h.registration.take_onloads(SHA).len(), 1);
}

#[test]
fn a_sent_url_binds_in_either_form() {
    let entry = crate::gif::analytics::Entry {
        url: "https://MEDIA.giphy.com/media/g1/giphy.gif".into(),
        preview_url: STILL.into(),
        pingbacks: all_pingbacks(),
        rating: crate::gif::Rating::Pg,
        query: None,
    };
    assert!(crate::gif::analytics::Entry::binds(&entry, URL));
    assert!(crate::gif::analytics::Entry::binds(&entry, STILL));
    assert!(!crate::gif::analytics::Entry::binds(
        &entry,
        "https://media.giphy.com/media/g2/giphy.gif"
    ));
}

#[test]
fn only_a_send_from_this_machine_registers() {
    let mut attachment =
        crate::media::Attachment::remote(URL, "cat", &crate::media::Config::default(), false)
            .unwrap();
    attachment.provider = Some(MediaProvider::Giphy);
    attachment.provider_id = Some("g1".into());
    let media = crate::commands::agent_inbox::StoredMedia {
        team: crate::commands::dashboard_launch::LaunchTeam {
            org: "acme".into(),
            team: "core".into(),
        },
        message_id: 1,
        slot: 0,
        attachment,
        chat: None,
    };
    assert_eq!(sent_of(&media), None);
    let mut own = media.clone();
    own.attachment.own_sender = true;
    assert_eq!(sent_of(&own), Some(sent(1, "g1", URL)));
}

#[tokio::test]
async fn an_entry_armed_while_a_serve_settles_is_merged_back_not_lost() {
    let h = Harness::new();
    h.found_all("g1");
    h.registration.expect_send(&slot(1));
    h.registration.note_fetched(&slot(1), Some(SHA), true);
    // The serve takes the waiting entry; the send arms its onload before the serve puts it back.
    let taken = h.registration.take_onloads(SHA);
    h.send(1, "g1", URL).await;
    let settled = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(settled.retry, vec![slot(1)]);
    let taken = h.registration.take_onloads(SHA);
    assert_eq!(taken.len(), 1);
    assert!(taken[0].1.onload.is_some() && !taken[0].1.waiting);
    let settled = h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(settled.marks, vec![slot(1)]);
    assert_eq!(h.wire.actions(), vec!["SENT", "SEEN"]);
}

#[tokio::test]
async fn a_search_that_spans_turning_search_off_is_not_held() {
    let h = Harness::new();
    *h.wire.search_body.lock().unwrap() = include_str!("../fixtures/search.json").to_string();
    let request = crate::gif::normalize(Some("cat"), None, None).unwrap();
    let dir = h.dir.path().to_path_buf();
    *h.wire.during_search.lock().unwrap() = Some(Box::new(move || forget_install(&dir)));
    assert!(!h
        .service
        .run(&request, None, None)
        .await
        .unwrap()
        .1
        .is_empty());
    assert_eq!(
        h.service.analytics.held_count(),
        0,
        "found under the old id: not held"
    );
    *h.wire.during_search.lock().unwrap() = None;
    h.service.run(&request, None, None).await.unwrap();
    assert!(h.service.analytics.held_count() > 0);
}

#[tokio::test]
async fn a_new_key_ends_the_wait_after_a_failed_random_id_call() {
    let h = Harness::new();
    h.found_all("g1");
    *h.wire.random.lock().unwrap() = Ok(reply(500, ""));
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 1);
    settings::save_with(&h.keys(), h.dir.path(), OTHER_KEY).unwrap();
    *h.wire.random.lock().unwrap() = Ok(reply(200, r#"{"data":{"random_id":"rid-2"}}"#));
    h.found_all("g1");
    h.send(2, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 2, "asked again at once");
    assert_eq!(h.wire.actions(), vec!["SENT"]);
}

#[tokio::test]
async fn a_random_id_that_could_not_be_saved_waits_like_a_failed_call() {
    let h = Harness::new();
    h.found_all("g1");
    // A folder where the file goes: the id can't be saved.
    std::fs::create_dir_all(h.install_file()).unwrap();
    h.send(1, "g1", URL).await;
    h.send(2, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 1);
    assert!(h.wire.pings().is_empty());
    h.advance(RANDOM_ID_RETRY_MS);
    h.send(3, "g1", URL).await;
    assert_eq!(h.wire.random_calls(), 2);
}

/// A keychain whose reads fail, as a locked one or a denied prompt does, and are counted.
#[derive(Default)]
struct DeniedStore {
    gets: std::sync::atomic::AtomicUsize,
}
impl CredentialStore for DeniedStore {
    fn get(
        &self,
        _: &str,
    ) -> Result<Option<Secret>, crate::commands::credential_store::CredentialError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        Err("keychain read failed: denied".into())
    }
    fn set(
        &self,
        _: &str,
        _: &Secret,
    ) -> Result<(), crate::commands::credential_store::CredentialError> {
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<(), crate::commands::credential_store::CredentialError> {
        Ok(())
    }
}

#[tokio::test]
async fn after_a_failed_keychain_read_serves_wait_before_reading_it_again() {
    let store = Arc::new(DeniedStore::default());
    let h = Harness::over(store.clone());
    let armed = || Pending {
        onload: all_pingbacks().onload,
        sha: Some(SHA.into()),
        expires: h.now() + ONLOAD_WINDOW_MS,
        waiting: false,
    };
    h.registration.put_back(vec![(slot(1), armed())]);
    for _ in 0..3 {
        let taken = h.registration.take_onloads(SHA);
        assert_eq!(taken.len(), 1, "the onload stays pending");
        let settled = h.registration.settle_serve(vec![slot(1)], taken).await;
        assert_eq!(settled.retry, vec![slot(1)]);
    }
    assert_eq!(store.gets.load(Ordering::SeqCst), 1, "one read in the wait");
    h.advance(KEY_RETRY_MS);
    let taken = h.registration.take_onloads(SHA);
    h.registration.settle_serve(vec![slot(1)], taken).await;
    assert_eq!(store.gets.load(Ordering::SeqCst), 2);
    assert!(h.wire.urls().is_empty());
}

// The person's pick in the Inbox pane's picker: onclick, once per pick.

#[tokio::test]
async fn click_fires_once_per_pick() {
    let h = Harness::new();
    h.found_all("g1");
    h.registration.register_click(Provider::Giphy, "g1").await;
    assert_eq!(h.wire.actions(), vec!["CLICK"]);
    let ping = &h.wire.pings()[0];
    assert_eq!(pair(ping, "random_id").as_deref(), Some("rid-123"));
    assert!(!ping.as_str().contains("api_key") && !ping.as_str().contains(KEY));
    // Each pick is its own click, the same GIF's included; a pick is never a send.
    h.registration.register_click(Provider::Giphy, "g1").await;
    assert_eq!(h.wire.actions(), vec!["CLICK", "CLICK"]);
    // Sending the picked GIF is still one onsent.
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.actions(), vec!["CLICK", "CLICK", "SENT"]);
    assert_eq!(h.wire.random_calls(), 1);
}

#[tokio::test]
async fn click_is_a_noop_when_off_or_unknown_id() {
    let h = Harness::new();
    // No search returned it, or not within the hour.
    h.registration
        .register_click(Provider::Giphy, "unknown")
        .await;
    h.found_all("g1");
    h.advance(crate::gif::analytics::TTL_MS);
    h.registration.register_click(Provider::Giphy, "g1").await;
    // No onclick URL in the search's pingbacks.
    h.found(
        "g3",
        Pingbacks {
            onclick: None,
            ..all_pingbacks()
        },
    );
    h.registration.register_click(Provider::Giphy, "g3").await;
    assert!(h.wire.urls().is_empty(), "{:?}", h.wire.urls());
    // Search Off: the held entries go with the install id, and nothing is sent.
    let off = SettingsUpdate {
        enabled: Some(false),
        ..SettingsUpdate::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), off).unwrap();
    h.found_all("g1");
    h.registration.register_click(Provider::Giphy, "g1").await;
    assert!(h.wire.urls().is_empty(), "no click or random id while Off");
}

#[tokio::test]
async fn click_is_a_noop_without_key_or_after_epoch_change() {
    let h = Harness::new();
    h.found_all("g1");
    settings::remove_with(&h.keys(), h.dir.path()).unwrap();
    h.registration.register_click(Provider::Giphy, "g1").await;
    assert!(h.wire.urls().is_empty(), "no call without a key");
    // A search under an earlier epoch: its entry is let go, so its pick sends nothing.
    let h = Harness::new();
    h.found_all("g1");
    h.registration.register_click(Provider::Giphy, "g1").await;
    assert_eq!(h.wire.actions(), vec!["CLICK"]);
    forget_install(h.dir.path());
    h.registration.register_click(Provider::Giphy, "g1").await;
    assert_eq!(
        h.wire.actions(),
        vec!["CLICK"],
        "the old epoch's entry is gone"
    );
}

#[tokio::test]
async fn click_counts_against_the_ceiling() {
    let h = Harness::new();
    h.found_all("g1");
    for _ in 0..PINGS_PER_HOUR {
        h.registration.register_click(Provider::Giphy, "g1").await;
    }
    // The install id call is one of the hour's calls.
    assert_eq!(h.wire.pings().len(), PINGS_PER_HOUR - 1);
    // Clicks and sends share the hour.
    h.send(1, "g1", URL).await;
    assert_eq!(h.wire.pings().len(), PINGS_PER_HOUR - 1);
    assert!(h.wire.actions().iter().all(|a| a == "CLICK"));
}

// One guard path: a send, a pick and a serve refuse the same cases.

/// A keychain the test can lock.
#[derive(Default)]
struct Lockable {
    inner: FakeStore,
    locked: std::sync::atomic::AtomicBool,
}
impl CredentialStore for Lockable {
    fn get(
        &self,
        account: &str,
    ) -> Result<Option<Secret>, crate::commands::credential_store::CredentialError> {
        if self.locked.load(Ordering::SeqCst) {
            return Err("keychain read failed: locked".into());
        }
        self.inner.get(account)
    }
    fn set(
        &self,
        account: &str,
        value: &Secret,
    ) -> Result<(), crate::commands::credential_store::CredentialError> {
        self.inner.set(account, value)
    }
    fn delete(
        &self,
        account: &str,
    ) -> Result<(), crate::commands::credential_store::CredentialError> {
        self.inner.delete(account)
    }
}

#[derive(Clone, Copy, Debug)]
enum Refusal {
    Off,
    NoKey,
    Locked,
    SearchHourOver,
}

fn refuse(h: &Harness, store: &Lockable, refusal: Refusal) {
    match refusal {
        Refusal::Off => {
            let off = SettingsUpdate {
                enabled: Some(false),
                ..SettingsUpdate::default()
            };
            settings::set_with(&h.keys(), h.dir.path(), off).unwrap();
        }
        Refusal::NoKey => h.keys().remove_key(Provider::Giphy).unwrap(),
        Refusal::Locked => {
            // Saved outside the app, so nothing caches it, then locked.
            h.keys().remove_key(Provider::Giphy).unwrap();
            store.inner.set(ACCOUNT, &Secret::new(KEY)).unwrap();
            store.locked.store(true, Ordering::SeqCst);
        }
        Refusal::SearchHourOver => h.advance(crate::gif::analytics::TTL_MS),
    }
}

#[tokio::test]
async fn a_send_a_pick_and_a_serve_refuse_the_same_cases() {
    let refusals = [
        Refusal::Off,
        Refusal::NoKey,
        Refusal::Locked,
        Refusal::SearchHourOver,
    ];
    for refusal in refusals {
        for entry in ["send", "pick", "serve"] {
            let store = Arc::new(Lockable::default());
            store.inner.set(ACCOUNT, &Secret::new(KEY)).unwrap();
            let h = Harness::over(store.clone());
            h.found_all("g1");
            if entry == "serve" {
                h.send(1, "g1", URL).await;
                h.registration.note_fetched(&slot(1), Some(SHA), true);
            }
            let before = h.wire.pings().len();
            refuse(&h, &store, refusal);
            match entry {
                "send" => h.send(2, "g1", URL).await,
                "pick" => h.registration.register_click(Provider::Giphy, "g1").await,
                _ => {
                    let taken = h.registration.take_onloads(SHA);
                    h.registration.settle_serve(vec![slot(1)], taken).await;
                }
            }
            assert_eq!(h.wire.pings().len(), before, "{refusal:?}: {entry}");
        }
    }
}

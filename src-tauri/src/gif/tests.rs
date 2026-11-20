// SPDX-License-Identifier: MIT
use super::giphy::{Failure, Giphy, Reply, Transport};
use super::settings::{self, KeyState, Keys, SettingsUpdate};
use super::*;
use crate::commands::credential_store::{
    CredentialError, CredentialStore, EnvStore, FakeStore, Secret,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const ACCOUNT: &str = "someone";
const KEY: &str = "fake-gif-key-for-tests-7f3a";
const SEARCH: &str = include_str!("fixtures/search.json");
const LOOKUP: &str = include_str!("fixtures/lookup.json");
const START_MS: i64 = 1_800_000_000_000;

/// Recorded API replies, one per request, and the URLs asked for.
#[derive(Default)]
struct Recorded {
    replies: Mutex<VecDeque<Result<Reply, Failure>>>,
    urls: Mutex<Vec<url::Url>>,
}
impl Recorded {
    fn reply(&self, status: u16, retry_after: Option<&str>, body: &str) {
        self.replies.lock().unwrap().push_back(Ok(Reply {
            status,
            retry_after: retry_after.map(str::to_string),
            body: body.as_bytes().to_vec(),
        }));
    }
    fn fail(&self, failure: Failure) {
        self.replies.lock().unwrap().push_back(Err(failure));
    }
    fn requests(&self) -> usize {
        self.urls.lock().unwrap().len()
    }
    fn last_pairs(&self) -> Vec<(String, String)> {
        let urls = self.urls.lock().unwrap();
        urls.last()
            .expect("a request")
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }
}
impl Transport for Recorded {
    fn get<'a>(&'a self, url: &'a url::Url) -> BoxFuture<'a, Result<Reply, Failure>> {
        self.urls.lock().unwrap().push(url.clone());
        let next = self.replies.lock().unwrap().pop_front();
        Box::pin(async move {
            next.unwrap_or_else(|| {
                Ok(Reply {
                    status: 200,
                    retry_after: None,
                    body: br#"{"data":[]}"#.to_vec(),
                })
            })
        })
    }
}

/// A store that counts every call, so a test can show none was made.
#[derive(Default)]
struct Counting {
    inner: FakeStore,
    calls: AtomicUsize,
}
impl CredentialStore for Counting {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.get(account)
    }
    fn set(&self, account: &str, value: &Secret) -> Result<(), CredentialError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.delete(account)
    }
}

/// A locked Keychain: every call fails.
struct Locked;
impl CredentialStore for Locked {
    fn get(&self, _: &str) -> Result<Option<Secret>, CredentialError> {
        Err("keychain read failed: locked".into())
    }
    fn set(&self, _: &str, _: &Secret) -> Result<(), CredentialError> {
        Err("keychain write failed: locked".into())
    }
    fn delete(&self, _: &str) -> Result<(), CredentialError> {
        Err("keychain delete failed: locked".into())
    }
}

/// A keychain read that waits on an access prompt until the test lets it go.
struct Prompting {
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    gets: AtomicUsize,
}
impl CredentialStore for Prompting {
    fn get(&self, _: &str) -> Result<Option<Secret>, CredentialError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        let _ = self
            .release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5));
        Ok(Some(Secret::new(KEY)))
    }
    fn set(&self, _: &str, _: &Secret) -> Result<(), CredentialError> {
        Ok(())
    }
}

struct Harness {
    dir: tempfile::TempDir,
    store: Arc<Counting>,
    transport: Arc<Recorded>,
    now: Arc<AtomicI64>,
    service: GifService,
}
impl Harness {
    /// The service's own keys, so a save here reaches the key a search uses.
    fn keys(&self) -> Keys {
        self.service.keys.clone()
    }
    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    async fn run(
        &self,
        request: &Request,
        rating: Option<&str>,
    ) -> Result<Vec<Candidate>, GifError> {
        self.service
            .run(request, None, rating)
            .await
            .map(|(_, candidates)| candidates)
    }
    async fn search(&self, query: &str) -> Result<Vec<Candidate>, GifError> {
        let request = normalize(Some(query), None, Some(6))?;
        self.run(&request, None).await
    }
    fn file(&self, name: &str) -> String {
        std::fs::read_to_string(self.dir.path().join(name)).unwrap_or_default()
    }
}

fn harness_with(keys: impl FnOnce(Arc<Counting>) -> Keys, with_key: bool) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Counting::default());
    if with_key {
        store.inner.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    }
    let transport = Arc::new(Recorded::default());
    let now = Arc::new(AtomicI64::new(START_MS));
    let adapter_transport: Arc<dyn Transport> = transport.clone();
    let adapters: Adapters = Arc::new(
        move |_: Provider, key: Secret, now: i64| -> Box<dyn GifProvider> {
            Box::new(Giphy::new(key, adapter_transport.clone(), now))
        },
    );
    let clock_now = now.clone();
    let clock: Clock = Arc::new(move || clock_now.load(Ordering::SeqCst));
    let service = GifService::new(
        dir.path().to_path_buf(),
        keys(store.clone()),
        adapters,
        clock,
    );
    Harness {
        dir,
        store,
        transport,
        now,
        service,
    }
}

fn harness() -> Harness {
    harness_with(
        |store| Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3)),
        true,
    )
}

fn ids(candidates: &[Candidate]) -> Vec<&str> {
    candidates.iter().map(|c| c.id.as_str()).collect()
}

// ---- AC 1: candidates, renditions, rating, input, autoLoads, hosts, titles, analytics ----

#[tokio::test]
async fn search_returns_candidates_in_provider_order_by_the_rendition_rule() {
    let h = harness();
    h.transport.reply(200, None, SEARCH);
    let found = h.search("ship it").await.unwrap();
    assert_eq!(ids(&found), ["ShipIt01", "Small-02", "Title08"]);

    // The fewest bytes among animated renditions at least 480 wide (the original's WebP), not
    // the smaller 480w still or the smaller 480w preview cut; the preview is fixed_width_still.
    let ship = &found[0];
    assert_eq!(ship.provider, Provider::Giphy);
    assert_eq!(
        ship.url,
        "https://media1.giphy.com/media/ShipIt01/giphy.webp"
    );
    assert_eq!((ship.width, ship.height), (600, 400));
    assert_eq!(
        ship.preview_url,
        "https://media1.giphy.com/media/ShipIt01/200w_s.gif"
    );
    assert_eq!(ship.title, "Ship It GIF by Example Studio");

    // No rendition 480 wide: the widest. Its only stills are mp4, so the preview is the GIF.
    let small = &found[1];
    assert_eq!(small.url, "https://media2.giphy.com/media/Small-02/200.gif");
    assert_eq!((small.width, small.height), (300, 200));
    assert_eq!(small.preview_url, small.url);

    let wire = serde_json::to_value(ship).unwrap();
    for field in [
        "provider",
        "id",
        "title",
        "url",
        "previewUrl",
        "width",
        "height",
        "autoLoads",
    ] {
        assert!(wire.get(field).is_some(), "{field}");
    }
}

fn rendition(name: &str, format: Format, width: Option<u32>, bytes: Option<u64>) -> Rendition {
    Rendition {
        name: name.into(),
        url: format!("https://media.giphy.com/media/x/{name}"),
        format,
        still: name.ends_with("_still"),
        width,
        height: width.map(|w| w / 2),
        bytes,
    }
}

#[test]
fn renditions_without_a_size_or_dimensions_or_over_the_limits_never_qualify() {
    let none = [
        rendition("no_size", Format::Gif, Some(600), None),
        rendition("no_dimensions", Format::Gif, None, Some(1000)),
        rendition("over_8mb", Format::Gif, Some(800), Some(9 * 1024 * 1024)),
        rendition("too_wide", Format::Webp, Some(5000), Some(1000)),
        rendition("video", Format::Other, Some(480), Some(1000)),
        rendition("480w_still", Format::Jpeg, Some(480), Some(10)),
    ];
    assert_eq!(pick_animated(&none), None);
    let mut some = none.to_vec();
    some.push(rendition(
        "exactly_8mb",
        Format::Gif,
        Some(100),
        Some(8 * 1024 * 1024),
    ));
    assert_eq!(pick_animated(&some).unwrap().name, "exactly_8mb");
    // A still is never animated, and the 480w still is the preview only when it is the one still.
    assert_eq!(pick_preview(&none).unwrap().name, "480w_still");
}

#[test]
fn the_widest_wins_when_none_is_480_wide_and_the_smallest_when_several_are() {
    let narrow = [
        rendition("a", Format::Gif, Some(200), Some(100)),
        rendition("b", Format::Webp, Some(320), Some(900)),
    ];
    assert_eq!(pick_animated(&narrow).unwrap().name, "b");
    let wide = [
        rendition("big", Format::Gif, Some(1000), Some(5000)),
        rendition("small", Format::Gif, Some(480), Some(3000)),
        rendition("narrow", Format::Gif, Some(200), Some(10)),
    ];
    assert_eq!(pick_animated(&wide).unwrap().name, "small");
}

#[tokio::test]
async fn every_request_carries_the_rating_mapped_and_capped_at_the_ceiling() {
    let h = harness();
    let rating_of = |h: &Harness| {
        h.transport
            .last_pairs()
            .into_iter()
            .find(|(k, _)| k == "rating")
            .map(|(_, v)| v)
    };
    let search = normalize(Some("ship it"), None, None).unwrap();
    h.run(&search, None).await.unwrap();
    assert_eq!(rating_of(&h).as_deref(), Some("pg"), "the default ceiling");
    assert!(
        h.transport
            .last_pairs()
            .contains(&("limit".into(), "12".into())),
        "a search asks for twice its limit"
    );
    h.run(&normalize(Some("ship it"), None, Some(10)).unwrap(), None)
        .await
        .unwrap();
    assert!(h
        .transport
        .last_pairs()
        .contains(&("limit".into(), "20".into())));
    h.run(&search, Some("G")).await.unwrap();
    assert_eq!(rating_of(&h).as_deref(), Some("g"));
    for above in ["pg-13", "r", "nonsense"] {
        h.run(&search, Some(above)).await.unwrap();
        assert_eq!(rating_of(&h).as_deref(), Some("pg"), "{above}");
    }
    settings::set_with(
        &h.keys(),
        h.dir.path(),
        SettingsUpdate {
            ceiling: Some("pg-13".into()),
            ..Default::default()
        },
    )
    .unwrap();
    h.run(&search, Some("PG-13")).await.unwrap();
    assert_eq!(rating_of(&h).as_deref(), Some("pg-13"));
    let first = ["First_1".to_string()];
    let lookup = normalize(None, Some(first.as_slice()), None).unwrap();
    h.run(&lookup, Some("g")).await.unwrap();
    assert_eq!(
        rating_of(&h).as_deref(),
        Some("g"),
        "a lookup carries it too"
    );
    let pairs = h.transport.last_pairs();
    assert!(pairs.contains(&("ids".into(), "First_1".into())));
}

#[tokio::test]
async fn results_above_the_ceiling_are_dropped() {
    let h = harness();
    h.transport.reply(200, None, SEARCH);
    let found = h
        .service
        .run(&normalize(Some("ship it"), None, None).unwrap(), Some("g"))
        .await
        .unwrap();
    assert_eq!(ids(&found), ["ShipIt01", "Title08"]);
}

#[test]
fn ratings_parse_in_any_case_and_clamp_to_the_ceiling() {
    assert_eq!(Rating::parse(" PG-13 "), Some(Rating::Pg13));
    assert_eq!(Rating::parse("G"), Some(Rating::G));
    assert_eq!(Rating::parse("r"), None);
    assert_eq!(Rating::clamp(Some("g"), Rating::Pg), Rating::G);
    assert_eq!(Rating::clamp(Some("pg-13"), Rating::Pg), Rating::Pg);
    assert_eq!(Rating::clamp(Some("r"), Rating::Pg13), Rating::Pg13);
    assert_eq!(Rating::clamp(None, Rating::G), Rating::G);
    assert_eq!(Rating::default(), Rating::Pg);
    assert_eq!(serde_json::to_value(Rating::Pg13).unwrap(), "pg-13");
}

#[test]
fn input_is_normalized_before_anything_runs() {
    let search = |limit| normalize(Some("ship it"), None, limit);
    assert_eq!(
        search(None),
        Ok(Request::Search {
            query: "ship it".into(),
            limit: 6
        })
    );
    for (asked, used) in [(0, 1), (-4, 1), (3, 3), (10, 10), (50, 10)] {
        assert_eq!(
            search(Some(asked)),
            Ok(Request::Search {
                query: "ship it".into(),
                limit: used
            }),
            "{asked}"
        );
    }
    let long = "a".repeat(101);
    for bad in ["", "   ", "ship\nit", "ship\u{7}it", long.as_str()] {
        assert!(
            matches!(normalize(Some(bad), None, None), Err(GifError::BadQuery(_))),
            "{bad:?}"
        );
    }
    let hundred = "é".repeat(100);
    assert!(normalize(Some(hundred.as_str()), None, None).is_ok());
}

#[test]
fn auto_loads_follows_remote_auto_and_the_team_allowlist() {
    let candidate = |url: &str| Candidate {
        provider: Provider::Giphy,
        id: "x".into(),
        title: String::new(),
        url: url.into(),
        preview_url: url.into(),
        width: 1,
        height: 1,
        auto_loads: false,
    };
    let mut found = vec![
        candidate("https://media1.giphy.com/media/x/giphy.gif"),
        candidate("https://i.giphy.com/media/y/giphy.gif"),
    ];
    set_auto_loads(&mut found, &crate::media::Config::default());
    assert!(found.iter().all(|c| c.auto_loads));

    let not_allowed = crate::media::Config {
        hosts: vec!["i.giphy.com".into()],
        ..Default::default()
    };
    set_auto_loads(&mut found, &not_allowed);
    assert_eq!(
        found.iter().map(|c| c.auto_loads).collect::<Vec<_>>(),
        [false, true]
    );

    let ask = crate::media::Config {
        remote: crate::media::Remote::Ask,
        ..Default::default()
    };
    set_auto_loads(&mut found, &ask);
    assert!(found.iter().all(|c| !c.auto_loads));
}

#[test]
fn candidates_off_the_provider_hosts_or_not_https_are_dropped() {
    let animated = |url: &str| Rendition {
        name: "original".into(),
        url: url.into(),
        format: Format::Gif,
        still: false,
        width: Some(480),
        height: Some(270),
        bytes: Some(1000),
    };
    for url in [
        "https://media.giphy.com/media/x/giphy.gif",
        "https://giphy.com/media/x/giphy.gif",
        "https://MEDIA.GIPHY.COM./media/x/giphy.gif",
    ] {
        assert!(
            candidate(Provider::Giphy, "x", "", &[animated(url)]).is_some(),
            "{url}"
        );
    }
    for url in [
        "http://media.giphy.com/media/x/giphy.gif",
        "https://giphy.com.example.net/x.gif",
        "https://evilgiphy.com/x.gif",
        concat!("https://user:pass", "@", "media.giphy.com/x.gif"),
        "https://media.klipy.com/x.gif",
    ] {
        assert!(
            candidate(Provider::Giphy, "x", "", &[animated(url)]).is_none(),
            "{url}"
        );
    }
    // An id outside the shared pattern is never a candidate.
    let ok = animated("https://media.giphy.com/media/x/giphy.gif");
    assert!(candidate(Provider::Giphy, "../x", "", &[ok]).is_none());
}

#[tokio::test]
async fn titles_lose_control_and_bidi_characters_and_stop_at_120() {
    let h = harness();
    h.transport.reply(200, None, SEARCH);
    let found = h.search("nailed it").await.unwrap();
    assert_eq!(found[2].title, "Nailed it!");

    let long = format!("\u{202E}{}\u{200B}tail", "word ".repeat(40));
    let cleaned = clean_title(&long);
    assert_eq!(cleaned.chars().count(), MAX_TITLE_CHARS - 1);
    assert!(!cleaned.contains('\u{202E}') && !cleaned.contains('\u{200B}'));
    assert_eq!(clean_title("a\u{0}b\u{1b}[31mc\u{2066}d"), "ab[31mcd");
    // Tag characters spell hidden text; variation selectors, the soft hyphen, the combining
    // grapheme joiner and interlinear annotations are invisible too.
    let hidden = "ok\u{E0001}\u{E0069}\u{E0067}\u{E006E}\u{E007F}\u{FE0F}\u{E0100}\u{00AD}\u{034F}\u{180E}\u{FFF9}!";
    assert_eq!(clean_title(hidden), "ok!");
}

#[tokio::test]
async fn pingbacks_are_held_an_hour_then_dropped() {
    let h = harness();
    h.transport.reply(200, None, SEARCH);
    h.search("ship it").await.unwrap();
    let onsent = |now| {
        h.service
            .analytics
            .pingbacks_for(Provider::Giphy, "ShipIt01", now)
            .and_then(|p| p.onsent)
    };
    assert!(onsent(h.now()).unwrap().contains("action_type=SENT"));
    let small = h
        .service
        .analytics
        .pingbacks_for(Provider::Giphy, "Small-02", h.now())
        .unwrap();
    assert_eq!(small.onload, None, "an off-host pingback is dropped");
    assert_eq!(small.onclick, None, "a pingback over 2 KB is dropped");
    assert!(small.onsent.is_some());
    assert!(
        h.service
            .analytics
            .pingbacks_for(Provider::Giphy, "Title08", h.now())
            .is_none(),
        "a result with no pingbacks holds none"
    );
    assert!(onsent(h.now() + analytics::TTL_MS - 1).is_some());
    assert!(onsent(h.now() + analytics::TTL_MS).is_none());
    // A later search drops the expired entries.
    h.advance(analytics::TTL_MS + 1);
    h.search("ship it").await.unwrap();
    assert_eq!(h.service.analytics.held_count(), 0);
}

#[test]
fn the_pingback_map_holds_at_most_2000_entries_and_drops_the_oldest() {
    let held = analytics::Analytics::new();
    let found = |i: usize| Found {
        candidate: Candidate {
            provider: Provider::Giphy,
            id: format!("id{i}"),
            title: String::new(),
            url: String::new(),
            preview_url: String::new(),
            width: 1,
            height: 1,
            auto_loads: false,
        },
        pingbacks: Some(Pingbacks {
            onsent: Some(format!("https://giphy-analytics.giphy.com/{i}")),
            ..Default::default()
        }),
    };
    let batch: Vec<Found> = (0..2100).map(found).collect();
    held.record(Provider::Giphy, &batch, START_MS);
    assert_eq!(held.held_count(), analytics::MAX_ENTRIES);
    assert!(held
        .pingbacks_for(Provider::Giphy, "id0", START_MS)
        .is_none());
    assert!(held
        .pingbacks_for(Provider::Giphy, "id99", START_MS)
        .is_none());
    assert!(held
        .pingbacks_for(Provider::Giphy, "id100", START_MS)
        .is_some());
    // Recording one again makes it the newest.
    held.record(Provider::Giphy, &[found(100), found(5000)], START_MS + 1);
    assert_eq!(held.held_count(), analytics::MAX_ENTRIES);
    assert!(held
        .pingbacks_for(Provider::Giphy, "id100", START_MS)
        .is_some());
    assert!(held
        .pingbacks_for(Provider::Giphy, "id101", START_MS)
        .is_none());
}

/// A provider that answers from memory, to show the service runs any adapter through the trait.
struct Canned(Vec<Found>);
impl GifProvider for Canned {
    fn search_gifs<'a>(
        &'a self,
        _: &'a str,
        _: Rating,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move { Ok(self.0.iter().take(limit).cloned().collect()) })
    }
    fn lookup_gifs<'a>(
        &'a self,
        _: &'a [String],
        _: Rating,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

#[tokio::test]
async fn the_service_runs_any_provider_through_the_trait_in_its_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(FakeStore::default());
    store.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let canned: Vec<Found> = ["c", "a", "b"]
        .iter()
        .map(|id| Found {
            candidate: Candidate {
                provider: Provider::Giphy,
                id: id.to_string(),
                title: id.to_string(),
                url: format!("https://media.giphy.com/media/{id}/giphy.gif"),
                preview_url: format!("https://media.giphy.com/media/{id}/200w_s.gif"),
                width: 480,
                height: 270,
                auto_loads: false,
            },
            pingbacks: Some(Pingbacks {
                onsent: Some(format!("https://giphy-analytics.giphy.com/{id}")),
                ..Default::default()
            }),
        })
        .collect();
    let adapters: Adapters = Arc::new(
        move |_: Provider, _: Secret, _: i64| -> Box<dyn GifProvider> {
            Box::new(Canned(canned.clone()))
        },
    );
    let service = GifService::new(
        dir.path().to_path_buf(),
        Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3)),
        adapters,
        Arc::new(|| START_MS),
    );
    let (provider, found) = service
        .run(&normalize(Some("x"), None, Some(2)).unwrap(), None, None)
        .await
        .unwrap();
    assert_eq!(provider, Provider::Giphy);
    assert_eq!(ids(&found), ["c", "a"]);
    assert!(service
        .analytics
        .pingbacks_for(Provider::Giphy, "a", START_MS)
        .is_some());
    let named = service
        .run(
            &normalize(Some("x"), None, None).unwrap(),
            Some(Provider::Giphy),
            None,
        )
        .await;
    assert!(named.is_ok(), "the active provider may be named");
}

// ---- AC 2: typed, safe errors ----

#[tokio::test]
async fn no_key_is_no_provider_without_a_network_call() {
    let h = harness_with(
        |store| Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3)),
        false,
    );
    assert_eq!(h.search("ship it").await, Err(GifError::NoProvider));
    assert_eq!(h.transport.requests(), 0);
    let text = GifError::NoProvider.tool_result().to_string();
    assert!(text.contains("noProvider") && text.contains("Settings → Messaging"));
}

#[tokio::test]
async fn a_locked_keychain_is_keychain_unavailable_without_a_network_call() {
    let h = harness_with(
        |_| {
            Keys::new(
                Arc::new(Locked),
                true,
                Some(ACCOUNT),
                Duration::from_secs(3),
            )
        },
        true,
    );
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::KeychainUnavailable)
    );
    assert_eq!(h.transport.requests(), 0);
    let no_login_name = harness_with(
        |store| Keys::new(store, true, None, Duration::from_secs(3)),
        true,
    );
    assert_eq!(
        no_login_name.search("ship it").await,
        Err(GifError::KeychainUnavailable)
    );
    assert_eq!(no_login_name.store.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn gif_search_off_is_no_provider_without_a_keychain_or_network_call() {
    let h = harness();
    settings::set_with(
        &h.keys(),
        h.dir.path(),
        SettingsUpdate {
            enabled: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    let calls = h.store.calls.load(Ordering::SeqCst);
    assert_eq!(h.search("ship it").await, Err(GifError::NoProvider));
    assert_eq!(h.store.calls.load(Ordering::SeqCst), calls);
    assert_eq!(h.transport.requests(), 0);
    assert!(h.file(settings::FILE).contains("\"enabled\": false"));
}

#[tokio::test]
async fn with_no_secret_store_nothing_touches_the_keyring_or_network_and_saves_are_refused() {
    let h = harness_with(
        |store| Keys::new(store, false, Some(ACCOUNT), Duration::from_secs(3)),
        true,
    );
    let before = h.store.calls.load(Ordering::SeqCst);
    let error = h.search("ship it").await.unwrap_err();
    assert_eq!(error, GifError::NoSecretStore);
    assert_eq!(error.code(), "keychainUnavailable");
    assert!(error.to_string().contains("no secret store"));
    assert!(!error.to_string().contains("Settings"));
    let keys = Keys::new(
        h.store.clone(),
        false,
        Some(ACCOUNT),
        Duration::from_secs(3),
    );
    assert!(settings::save_with(&keys, h.dir.path(), "another-key-value-0001").is_err());
    assert!(settings::remove_with(&keys, h.dir.path()).is_err());
    assert_eq!(
        settings::status_with(&keys, h.dir.path()).status,
        KeyState::Unavailable
    );
    assert_eq!(
        h.store.calls.load(Ordering::SeqCst),
        before,
        "no keyring call"
    );
    assert_eq!(h.transport.requests(), 0);
    assert_eq!(
        h.store.inner.get(ACCOUNT).unwrap().unwrap().expose(),
        KEY,
        "nothing was saved"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_keychain_read_that_waits_on_a_prompt_gives_up_and_never_piles_up() {
    let (release, wait) = std::sync::mpsc::channel();
    let store = Arc::new(Prompting {
        release: Mutex::new(wait),
        gets: AtomicUsize::new(0),
    });
    let prompting = store.clone();
    let h = harness_with(
        move |_| Keys::new(store, true, Some(ACCOUNT), Duration::from_millis(100)),
        false,
    );
    let error = h.search("ship it").await.unwrap_err();
    assert_eq!(error, GifError::KeychainUnavailable);
    assert!(error.to_string().contains("Settings → Messaging"));
    // A second search while the prompt still waits starts no second read.
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::KeychainUnavailable)
    );
    assert_eq!(prompting.gets.load(Ordering::SeqCst), 1);
    assert_eq!(h.transport.requests(), 0);
    // Once the user allows it, the key read is kept and the next search uses it.
    release.send(()).unwrap();
    let mut found = Err(GifError::KeychainUnavailable);
    for _ in 0..50 {
        found = h.search("ship it").await;
        if found.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(found.is_ok(), "{found:?}");
    assert_eq!(prompting.gets.load(Ordering::SeqCst), 1);
    assert_eq!(settings::KEY_READ_TIMEOUT, Duration::from_secs(3));
}

#[tokio::test]
async fn provider_failures_map_to_typed_errors() {
    let h = harness();
    let replies = [
        (Some(401), GifError::InvalidKey),
        (Some(403), GifError::InvalidKey),
        (Some(500), GifError::ProviderUnavailable),
        (Some(503), GifError::ProviderUnavailable),
        (Some(302), GifError::ProviderUnavailable),
        (Some(404), GifError::BadQuery("GIPHY refused the request")),
        (Some(414), GifError::BadQuery("GIPHY refused the request")),
        (None, GifError::ProviderUnavailable),
    ];
    for (status, expected) in replies {
        match status {
            Some(status) => h.transport.reply(status, None, "{}"),
            None => h.transport.reply(200, None, "<html>"),
        }
        assert_eq!(h.search("ship it").await, Err(expected), "{status:?}");
    }
    h.transport.reply(200, None, r#"{"data":{}}"#);
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::ProviderUnavailable)
    );
    for failure in [Failure::Timeout, Failure::Network, Failure::TooLarge] {
        h.transport.fail(failure);
        assert_eq!(
            h.search("ship it").await,
            Err(GifError::ProviderUnavailable),
            "{failure:?}"
        );
    }
    h.transport.reply(429, Some("30"), "{}");
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 30 })
    );
}

#[tokio::test]
async fn no_results_is_an_empty_list() {
    let h = harness();
    h.transport
        .reply(200, None, r#"{"data":[],"meta":{"status":200}}"#);
    assert_eq!(h.search("nothing matches this").await, Ok(vec![]));
}

// ---- AC 3: the rate limit ----

#[tokio::test]
async fn the_91st_search_in_an_hour_is_rate_limited_and_the_count_survives_a_restart() {
    let h = harness();
    for _ in 0..90 {
        h.search("ship it").await.unwrap();
    }
    let limited = h.search("ship it").await;
    assert_eq!(limited, Err(GifError::RateLimited { retry_after: 3600 }));
    assert_eq!(h.transport.requests(), 90);

    let restarted = bucket::Bucket::new(h.dir.path().join(bucket::FILE));
    let key = format!("giphy:{}", fingerprint(&Secret::new(KEY)));
    assert!(restarted.take(&key, false, h.now() + 3_599_999).is_err());
    // The window rolls: an hour after the first search, one is free again.
    assert!(restarted.take(&key, false, h.now() + 3_600_000).is_ok());
    assert!(!h.file(bucket::FILE).contains(KEY));
}

#[tokio::test]
async fn the_limit_is_a_rolling_hour_of_90_searches() {
    let h = harness();
    // 90 searches 30 s apart fill 44.5 minutes; the 91st, under an hour after the first, waits
    // until the first is an hour old.
    for _ in 0..90 {
        h.search("ship it").await.unwrap();
        h.advance(30_000);
    }
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 900 })
    );
    h.advance(899_000);
    assert!(h.search("ship it").await.is_err());
    h.advance(1_000);
    assert!(
        h.search("ship it").await.is_ok(),
        "the first search left the window"
    );
    assert!(
        h.search("ship it").await.is_err(),
        "the second is 30 s younger"
    );
    h.advance(30_000);
    assert!(h.search("ship it").await.is_ok());
    assert_eq!(h.transport.requests(), 92);
}

#[tokio::test]
async fn a_production_key_has_no_local_cap_and_replacing_it_clears_the_flag() {
    let h = harness();
    let production = |flag| SettingsUpdate {
        production: Some(flag),
        ..Default::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), production(true)).unwrap();
    assert!(settings::status_with(&h.keys(), h.dir.path()).production);
    for _ in 0..100 {
        h.search("ship it").await.unwrap();
    }
    assert_eq!(h.transport.requests(), 100);

    let replaced = settings::save_with(&h.keys(), h.dir.path(), "a-replacement-key").unwrap();
    assert!(!replaced.production);
    assert!(!h.file(settings::FILE).contains("giphy:"));
    // The replacement is a new key with a full bucket of its own.
    assert!(h.search("ship it").await.is_ok());

    settings::set_with(&h.keys(), h.dir.path(), production(true)).unwrap();
    let removed = settings::remove_with(&h.keys(), h.dir.path()).unwrap();
    assert_eq!(removed.status, KeyState::Missing);
    assert!(!h.file(settings::FILE).contains("giphy:"));
    assert!(settings::set_with(&h.keys(), h.dir.path(), production(true)).is_err());
}

#[test]
fn retry_after_takes_seconds_or_an_http_date_clamped_to_a_day() {
    let now = chrono::DateTime::parse_from_rfc2822("Wed, 21 Oct 2026 07:28:00 GMT")
        .unwrap()
        .timestamp_millis();
    let retry = |value| bucket::retry_after_secs(value, now);
    assert_eq!(retry(Some("120")), 120);
    assert_eq!(retry(Some(" 0 ")), 0);
    assert_eq!(retry(Some("999999")), bucket::MAX_BACKOFF_SECS);
    assert_eq!(
        retry(Some("99999999999999999999999")),
        bucket::MAX_BACKOFF_SECS
    );
    assert_eq!(retry(Some("Wed, 21 Oct 2026 07:29:30 GMT")), 90);
    assert_eq!(retry(Some("Wed, 21 Oct 2026 07:00:00 GMT")), 0);
    assert_eq!(
        retry(Some("Fri, 23 Oct 2026 07:28:00 GMT")),
        bucket::MAX_BACKOFF_SECS
    );
    assert_eq!(retry(None), bucket::DEFAULT_BACKOFF_SECS);
    assert_eq!(retry(Some("")), bucket::DEFAULT_BACKOFF_SECS);
    assert_eq!(retry(Some("soon")), bucket::DEFAULT_BACKOFF_SECS);
    assert_eq!(bucket::DEFAULT_BACKOFF_SECS, 15 * 60);
}

#[tokio::test]
async fn a_429_blocks_searches_until_its_retry_after_or_15_minutes() {
    let h = harness();
    h.transport.reply(429, Some("120"), "{}");
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 120 })
    );
    h.advance(60_000);
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 60 })
    );
    assert_eq!(h.transport.requests(), 1, "a backoff makes no request");
    h.advance(60_000);
    assert!(h.search("ship it").await.is_ok());

    let date = chrono::DateTime::from_timestamp_millis(h.now() + 300_000)
        .unwrap()
        .to_rfc2822();
    h.transport.reply(429, Some(date.as_str()), "{}");
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 300 })
    );
    h.advance(300_000);

    h.transport.reply(429, None, "{}");
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 900 })
    );
    h.advance(899_000);
    assert!(h.search("ship it").await.is_err());
    h.advance(1_000);
    assert!(h.search("ship it").await.is_ok());

    h.transport.reply(429, Some("172800"), "{}");
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited {
            retry_after: bucket::MAX_BACKOFF_SECS
        })
    );
}

#[tokio::test]
async fn a_429_that_asks_for_no_wait_still_blocks_for_a_second() {
    let past = chrono::DateTime::from_timestamp_millis(START_MS - 60_000)
        .unwrap()
        .to_rfc2822();
    for retry_after in ["0", past.as_str()] {
        let h = harness();
        h.transport.reply(429, Some(retry_after), "{}");
        assert_eq!(
            h.search("ship it").await,
            Err(GifError::RateLimited { retry_after: 1 }),
            "{retry_after}"
        );
        assert_eq!(
            h.search("ship it").await,
            Err(GifError::RateLimited { retry_after: 1 })
        );
        assert_eq!(h.transport.requests(), 1);
        h.advance(1_000);
        assert!(h.search("ship it").await.is_ok());
    }
}

fn bucket_in(dir: &std::path::Path, contents: &str) -> bucket::Bucket {
    let path = dir.join(bucket::FILE);
    std::fs::write(&path, contents).unwrap();
    bucket::Bucket::new(path)
}

#[test]
fn a_missing_state_starts_with_every_search_and_a_corrupt_or_future_one_with_none() {
    let dir = tempfile::tempdir().unwrap();
    let missing = bucket::Bucket::new(dir.path().join(bucket::FILE));
    assert!(missing
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS)
        .is_ok());

    let corrupt = bucket_in(dir.path(), "{not json");
    assert!(corrupt
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS)
        .is_err());
    assert!(corrupt
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS + 3_599_999)
        .is_err());
    assert!(corrupt
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS + 3_600_000)
        .is_ok());

    let future = format!(
        r#"{{"buckets":{{"giphy:bbbbbbbbbbbbbbbb":{{"searches":[{}]}}}}}}"#,
        START_MS + 60_000
    );
    let ahead = bucket_in(dir.path(), &future);
    assert!(ahead
        .take("giphy:bbbbbbbbbbbbbbbb", false, START_MS)
        .is_err());
    assert!(ahead
        .take("giphy:bbbbbbbbbbbbbbbb", false, START_MS + 3_600_000)
        .is_ok());
}

#[test]
fn a_saved_backoff_within_a_day_is_kept_and_one_beyond_is_clamped() {
    let dir = tempfile::tempdir().unwrap();
    let state = format!(
        r#"{{"buckets":{{
            "giphy:aaaaaaaaaaaaaaaa":{{"searches":[],"backoffUntilMs":{soon}}},
            "giphy:bbbbbbbbbbbbbbbb":{{"searches":[],"backoffUntilMs":{late}}}
        }}}}"#,
        soon = START_MS + 2 * 3_600_000,
        late = START_MS + 48 * 3_600_000,
    );
    let restarted = bucket_in(dir.path(), &state);
    assert_eq!(
        restarted.take("giphy:aaaaaaaaaaaaaaaa", false, START_MS),
        Err(GifError::RateLimited { retry_after: 7200 })
    );
    assert_eq!(
        restarted.take("giphy:bbbbbbbbbbbbbbbb", true, START_MS),
        Err(GifError::RateLimited {
            retry_after: bucket::MAX_BACKOFF_SECS
        }),
        "a backoff applies to a production key too"
    );
    assert!(restarted
        .take("giphy:bbbbbbbbbbbbbbbb", true, START_MS + 24 * 3_600_000)
        .is_ok());
}

#[test]
fn concurrent_searches_never_lose_a_count() {
    let dir = tempfile::tempdir().unwrap();
    let bucket = Arc::new(bucket::Bucket::new(dir.path().join(bucket::FILE)));
    let taken = Arc::new(AtomicUsize::new(0));
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let (bucket, taken) = (bucket.clone(), taken.clone());
            std::thread::spawn(move || {
                for _ in 0..10 {
                    if bucket
                        .take("giphy:cccccccccccccccc", false, START_MS)
                        .is_ok()
                    {
                        taken.fetch_add(1, Ordering::SeqCst);
                    }
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(taken.load(Ordering::SeqCst), 90);
    let restarted = bucket::Bucket::new(dir.path().join(bucket::FILE));
    assert!(restarted
        .take("giphy:cccccccccccccccc", false, START_MS)
        .is_err());
}

// ---- AC 4: the key stays on the machine ----

#[test]
fn the_key_is_the_giphy_keychain_item_under_the_login_name() {
    assert_eq!(Provider::Giphy.key_service(), "ai.codesense.giphy-api-key");
    let dir = tempfile::tempdir().unwrap();
    // An item saved outside the app under the login name is found with no re-entry.
    let store = Arc::new(FakeStore::default());
    store.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let keys = Keys::new(store.clone(), true, Some(ACCOUNT), Duration::from_secs(3));
    let status = settings::status_with(&keys, dir.path());
    assert_eq!(status.status, KeyState::Saved);
    assert_eq!(status.hint.as_deref(), Some("…7f3a"));
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        serde_json::json!({"status": "saved", "hint": "…7f3a", "production": false})
    );

    settings::save_with(&keys, dir.path(), "  a-new-key-value-0001 \n").unwrap();
    assert_eq!(
        store.get(ACCOUNT).unwrap().unwrap().expose(),
        "a-new-key-value-0001"
    );
    for bad in [
        "",
        "   \n",
        "two words here, long",
        "tab\tinside-a-long-key",
        "short-key-15chr",
    ] {
        assert!(
            settings::save_with(&keys, dir.path(), bad).is_err(),
            "{bad:?}"
        );
    }
    assert_eq!(
        store.get(ACCOUNT).unwrap().unwrap().expose(),
        "a-new-key-value-0001"
    );
    let other = Keys::new(
        store.clone(),
        true,
        Some("someone-else"),
        Duration::from_secs(3),
    );
    assert_eq!(
        settings::status_with(&other, dir.path()).status,
        KeyState::Missing
    );
    settings::remove_with(&keys, dir.path()).unwrap();
    assert_eq!(store.get(ACCOUNT).unwrap(), None);
}

#[tokio::test]
async fn a_key_saved_outside_the_app_with_a_trailing_newline_is_trimmed_on_read() {
    let h = harness_with(
        |store| {
            store
                .inner
                .set(ACCOUNT, &Secret::new(format!("{KEY}\n")))
                .unwrap();
            Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3))
        },
        false,
    );
    let status = settings::status_with(&h.keys(), h.dir.path());
    assert_eq!(status.hint.as_deref(), Some("…7f3a"));
    h.search("ship it").await.unwrap();
    let pairs = h.transport.last_pairs();
    assert!(pairs.contains(&("api_key".into(), KEY.into())));
}

#[test]
fn a_short_key_saved_outside_the_app_shows_no_hint() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(FakeStore::default());
    store.set(ACCOUNT, &Secret::new("short-key")).unwrap();
    let keys = Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3));
    let status = settings::status_with(&keys, dir.path());
    assert_eq!(status.status, KeyState::Saved);
    assert_eq!(status.hint, None);
}

/// A keychain that reads but refuses writes.
struct ReadOnly(FakeStore);
impl CredentialStore for ReadOnly {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        self.0.get(account)
    }
    fn set(&self, _: &str, _: &Secret) -> Result<(), CredentialError> {
        Err("keychain write failed".into())
    }
}

#[test]
fn a_failed_key_save_says_what_changed() {
    let dir = tempfile::tempdir().unwrap();
    let inner = FakeStore::default();
    inner.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let keys = Keys::new(
        Arc::new(ReadOnly(inner)),
        true,
        Some(ACCOUNT),
        Duration::from_secs(3),
    );
    let error = settings::save_with(&keys, dir.path(), "a-replacement-key-0001").unwrap_err();
    assert!(error.ends_with("Nothing changed."), "{error}");

    let production = SettingsUpdate {
        production: Some(true),
        ..Default::default()
    };
    settings::set_with(&keys, dir.path(), production).unwrap();
    let error = settings::save_with(&keys, dir.path(), "a-replacement-key-0001").unwrap_err();
    assert!(
        error.contains("no longer marked as a production key"),
        "{error}"
    );
    assert!(!error.contains("Nothing changed"));
    assert!(settings::load(dir.path()).production_keys.is_empty());
    assert!(!settings::status_with(&keys, dir.path()).production);
}

#[test]
fn an_environment_credential_source_refuses_key_writes() {
    let dir = tempfile::tempdir().unwrap();
    let env = Arc::new(EnvStore::new(Provider::Giphy.key_service()));
    let keys = Keys::new(env, true, Some(ACCOUNT), Duration::from_secs(3));
    let error = settings::save_with(&keys, dir.path(), "a-key-value-long-enough").unwrap_err();
    assert!(error.contains("OS keychain"), "{error}");
}

#[tokio::test]
async fn the_key_never_reaches_an_error_a_log_line_or_a_file() {
    crate::test_logger::clear("gif");
    let h = harness();
    settings::set_with(
        &h.keys(),
        h.dir.path(),
        SettingsUpdate {
            production: Some(true),
            ceiling: Some("g".into()),
            ..Default::default()
        },
    )
    .unwrap();
    h.transport.fail(Failure::Network);
    h.transport
        .reply(500, None, &format!("{{\"echo\":\"{KEY}\"}}"));
    h.transport.reply(401, None, "{}");
    h.transport.reply(200, None, "not json");
    h.transport.reply(429, Some("5"), "{}");
    let mut errors = Vec::new();
    for _ in 0..5 {
        errors.push(h.search("ship it").await.unwrap_err());
    }
    assert!(
        h.transport
            .urls
            .lock()
            .unwrap()
            .iter()
            .all(|u| u.as_str().contains(KEY)),
        "the request itself carries the key"
    );
    for error in &errors {
        assert!(!error.to_string().contains(KEY));
        assert!(!error.tool_result().to_string().contains(KEY));
        assert!(!error.tool_result().to_string().contains("api.giphy.com"));
        assert!(!format!("{error:?}").contains(KEY));
    }
    let lines = crate::test_logger::lines("gif");
    assert!(lines.len() >= 5, "{lines:?}");
    for line in &lines {
        assert!(!line.contains(KEY) && !line.contains("api_key"), "{line}");
    }
    assert!(h.file(settings::FILE).contains("giphy:"));
    assert!(!h.file(settings::FILE).contains(KEY));
    assert!(h.file(bucket::FILE).contains("giphy:"));
    assert!(!h.file(bucket::FILE).contains(KEY));
}

#[tokio::test]
async fn the_real_transport_keeps_the_key_out_of_a_failure_and_its_logs() {
    crate::test_logger::clear("gif");
    crate::test_logger::clear("reqwest");
    let http = giphy::Http::new().unwrap();
    let url: url::Url = format!("https://gif-test.invalid/v1/gifs/search?api_key={KEY}&q=x")
        .parse()
        .unwrap();
    let failure = http.get(&url).await.unwrap_err();
    assert_eq!(failure, Failure::Network);
    assert!(!format!("{failure:?}").contains(KEY));
    for target in ["gif", "reqwest"] {
        for line in crate::test_logger::lines(target) {
            assert!(!line.contains(KEY) && !line.contains("api_key"), "{line}");
        }
    }
}

fn local_http() -> giphy::Http {
    giphy::Http::on(reqwest::Client::builder()).unwrap()
}

fn at(server: &wiremock::MockServer, path: &str) -> url::Url {
    format!("{}{path}", server.uri()).parse().unwrap()
}

#[tokio::test]
async fn the_transport_sends_its_agent_follows_no_redirect_and_reads_retry_after() {
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/moved"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("{}/elsewhere", server.uri())),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/elsewhere"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .expect(0)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/limited"))
        .and(header("user-agent", giphy::USER_AGENT))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "120"))
        .mount(&server)
        .await;
    let http = local_http();
    let moved = http.get(&at(&server, "/moved")).await.unwrap();
    assert_eq!(moved.status, 302, "a redirect is never followed");
    let limited = http.get(&at(&server, "/limited")).await.unwrap();
    assert_eq!(limited.status, 429, "the request carries the agent");
    assert_eq!(limited.retry_after.as_deref(), Some("120"));
}

#[tokio::test]
async fn the_transport_reads_at_most_2_mib_with_a_content_length() {
    use wiremock::matchers::path;
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    for (route, size) in [("/fits", giphy::MAX_BODY), ("/over", giphy::MAX_BODY + 1)] {
        Mock::given(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'a'; size]))
            .mount(&server)
            .await;
    }
    let http = local_http();
    let fits = http.get(&at(&server, "/fits")).await.unwrap();
    assert_eq!(fits.body.len(), giphy::MAX_BODY);
    assert_eq!(
        http.get(&at(&server, "/over")).await,
        Err(Failure::TooLarge)
    );
}

/// A server that answers one request with a chunked body of `total` bytes and no length.
async fn chunked_server(total: usize) -> url::Url {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        let _ = socket.read(&mut request).await;
        let head = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
        if socket.write_all(head).await.is_err() {
            return;
        }
        let chunk = vec![b'a'; 64 * 1024];
        let mut sent = 0;
        while sent < total {
            let n = chunk.len().min(total - sent);
            let framed = [format!("{n:x}\r\n").as_bytes(), &chunk[..n], b"\r\n"].concat();
            if socket.write_all(&framed).await.is_err() {
                return;
            }
            sent += n;
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
    });
    format!("http://{addr}/").parse().unwrap()
}

#[tokio::test]
async fn the_transport_reads_at_most_2_mib_without_a_content_length() {
    let http = local_http();
    let small = http.get(&chunked_server(1000).await).await.unwrap();
    assert_eq!(small.body.len(), 1000);
    assert_eq!(
        http.get(&chunked_server(giphy::MAX_BODY + 1).await).await,
        Err(Failure::TooLarge)
    );
}

#[tokio::test]
async fn the_tool_result_names_the_provider_and_marks_auto_loads_from_the_team() {
    use crate::mcp::gif_tools::{search_with, GifSearchParams};
    let h = harness();
    let search = || GifSearchParams {
        query: Some("ship it".into()),
        ..Default::default()
    };
    h.transport.reply(200, None, SEARCH);
    let no_team = search_with(&h.service, None, search()).await;
    assert_eq!(no_team["status"], "ok");
    assert_eq!(no_team["provider"], "giphy");
    let candidates = no_team["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 3);
    assert!(
        candidates.iter().all(|c| c["autoLoads"] == false),
        "with no team config nothing auto-loads"
    );

    h.transport.reply(200, None, SEARCH);
    let team = crate::media::Config::default();
    let with_team = search_with(&h.service, Some(&team), search()).await;
    let candidates = with_team["candidates"].as_array().unwrap();
    assert!(candidates.iter().all(|c| c["autoLoads"] == true));

    let unknown = search_with(
        &h.service,
        None,
        GifSearchParams {
            ids: Some(vec!["First_1".into()]),
            provider: Some("klipy".into()),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(unknown["status"], "error");
    assert_eq!(unknown["error"], "badQuery");
    let both = search_with(
        &h.service,
        None,
        GifSearchParams {
            query: Some("ship it".into()),
            ids: Some(vec!["First_1".into()]),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(both["error"], "badQuery");
    assert_eq!(h.transport.requests(), 2, "bad input makes no request");

    h.transport.reply(429, Some("30"), "{}");
    let limited = search_with(&h.service, None, search()).await;
    assert_eq!(
        limited,
        serde_json::json!({
            "status": "error",
            "error": "rateLimited",
            "message": "GIF search is paused. Try again in 30 seconds.",
            "retryAfter": 30,
        })
    );
}

// ---- AC 5 and 7: settings ----

#[test]
fn missing_or_corrupt_settings_read_as_on_pg_and_not_production() {
    let dir = tempfile::tempdir().unwrap();
    let defaults = settings::load(dir.path());
    assert!(defaults.enabled);
    assert_eq!(defaults.provider, Provider::Giphy);
    assert_eq!(defaults.ceiling, Rating::Pg);
    assert!(defaults.production_keys.is_empty());
    let read = |contents: &str| {
        std::fs::write(dir.path().join(settings::FILE), contents).unwrap();
        settings::load(dir.path())
    };
    assert_eq!(read("{broken"), defaults);
    assert_eq!(read("[1,2]"), defaults);
    let odd = read(
        r#"{"enabled":"no","provider":"tenor","ceiling":"r","productionKeys":["giphy:short",
        "giphy:0123456789abcdef", 7, "klipy:0123456789abcdef"]}"#,
    );
    assert!(odd.enabled);
    assert_eq!(odd.provider, Provider::Giphy);
    assert_eq!(odd.ceiling, Rating::Pg);
    assert_eq!(odd.production_keys, ["giphy:0123456789abcdef"]);
    let off = read(r#"{"enabled":false,"ceiling":"PG-13","provider":"giphy"}"#);
    assert!(!off.enabled);
    assert_eq!(off.ceiling, Rating::Pg13);
}

#[test]
fn the_ceiling_is_g_pg_or_pg13_and_never_r() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Keys::new(
        Arc::new(FakeStore::default()),
        true,
        Some(ACCOUNT),
        Duration::from_secs(3),
    );
    let set = |ceiling: &str| {
        settings::set_with(
            &keys,
            dir.path(),
            SettingsUpdate {
                ceiling: Some(ceiling.into()),
                ..Default::default()
            },
        )
    };
    assert_eq!(set("g").unwrap().ceiling, Rating::G);
    assert!(set("r").is_err());
    assert_eq!(settings::load(dir.path()).ceiling, Rating::G);
    let wire = serde_json::to_value(set("pg-13").unwrap()).unwrap();
    assert_eq!(
        wire,
        serde_json::json!({"enabled": true, "provider": "giphy", "ceiling": "pg-13"})
    );
}

// ---- AC 8: lookup by id ----

#[tokio::test]
async fn lookup_returns_the_ids_asked_in_order_and_counts_against_the_bucket() {
    let h = harness();
    h.transport.reply(200, None, LOOKUP);
    let asked = ["First_1", "Second2", "Above-3"].map(String::from);
    let request = normalize(None, Some(asked.as_slice()), None).unwrap();
    let found = h.run(&request, None).await.unwrap();
    assert_eq!(
        ids(&found),
        ["First_1", "Second2"],
        "above pg and unasked ids are dropped"
    );
    assert_eq!(
        found[0].url,
        "https://media0.giphy.com/media/First_1/200.gif"
    );
    let pairs = h.transport.last_pairs();
    assert!(pairs.contains(&("ids".into(), "First_1,Second2,Above-3".into())));
    assert!(h.transport.urls.lock().unwrap()[0]
        .path()
        .ends_with("/v1/gifs"));

    let state: serde_json::Value = serde_json::from_str(&h.file(bucket::FILE)).unwrap();
    let key = format!("giphy:{}", fingerprint(&Secret::new(KEY)));
    assert_eq!(
        state["buckets"][&key]["searches"],
        serde_json::json!([START_MS])
    );
}

#[test]
fn ids_are_one_to_ten_entries_of_the_shared_pattern_and_exclusive_with_query() {
    let list = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(ID_PATTERN, "^[A-Za-z0-9_-]{1,64}$");
    assert!(normalize(None, Some(list(&["a", "B-2", "c_3"]).as_slice()), None).is_ok());
    let ten: Vec<String> = (0..10).map(|i| format!("id{i}")).collect();
    assert!(normalize(None, Some(ten.as_slice()), None).is_ok());
    let eleven: Vec<String> = (0..11).map(|i| format!("id{i}")).collect();
    let long = "x".repeat(65);
    for bad in [
        vec![],
        eleven,
        list(&["ok", "not/ok"]),
        list(&["sp ace"]),
        list(&[""]),
        vec![long],
        list(&["é"]),
    ] {
        assert!(
            matches!(
                normalize(None, Some(bad.as_slice()), None),
                Err(GifError::BadQuery(_))
            ),
            "{bad:?}"
        );
    }
    assert!(valid_id(&"x".repeat(64)));
    assert!(matches!(
        normalize(Some("ship it"), Some(list(&["a"]).as_slice()), None),
        Err(GifError::BadQuery(_))
    ));
    assert!(matches!(
        normalize(None, None, None),
        Err(GifError::BadQuery(_))
    ));
}

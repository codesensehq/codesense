// SPDX-License-Identifier: MIT
use super::giphy::Giphy;
use super::klipy::Klipy;
use super::settings::{self, KeyState, Keys, SettingsUpdate};
use super::transport::{Failure, Reply, Transport};
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
    fn delete(&self, _: &str) -> Result<(), CredentialError> {
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

/// `gif.json` choosing GIPHY: KLIPY is the default, and most tests here search GIPHY.
const GIPHY_SETTINGS: &str = r#"{"provider":"giphy"}"#;

/// Choose GIPHY in `dir`'s `gif.json`.
fn pin_giphy(dir: &std::path::Path) {
    std::fs::write(dir.join(settings::FILE), GIPHY_SETTINGS).unwrap();
}

/// Save `key` for the provider `gif.json` names, as the Settings card's key row does.
fn save_active(
    keys: &Keys,
    dir: &std::path::Path,
    key: &str,
) -> Result<settings::KeyStatus, String> {
    settings::save_with(keys, dir, settings::load(dir).provider, key)
}

fn harness_with(keys: impl FnOnce(Arc<Counting>) -> Keys, with_key: bool) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    pin_giphy(dir.path());
    let store = Arc::new(Counting::default());
    if with_key {
        store.inner.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    }
    let transport = Arc::new(Recorded::default());
    let now = Arc::new(AtomicI64::new(START_MS));
    let adapter_transport: Arc<dyn Transport> = transport.clone();
    let adapters: Adapters = Arc::new(
        move |provider: Provider,
              key: Secret,
              customer_id: Option<String>,
              now: i64|
              -> Box<dyn GifProvider> {
            let transport = adapter_transport.clone();
            match provider {
                Provider::Giphy => Box::new(Giphy::new(key, transport, now)),
                Provider::Klipy => Box::new(Klipy::new(key, customer_id, transport, now)),
            }
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
    assert_eq!(
        pick_preview(Provider::Giphy, &none).unwrap().name,
        "480w_still"
    );
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
    held.record(Provider::Giphy, &batch, Rating::Pg, None, START_MS);
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
    held.record(
        Provider::Giphy,
        &[found(100), found(5000)],
        Rating::Pg,
        None,
        START_MS + 1,
    );
    assert_eq!(held.held_count(), analytics::MAX_ENTRIES);
    assert!(held
        .pingbacks_for(Provider::Giphy, "id100", START_MS)
        .is_some());
    assert!(held
        .pingbacks_for(Provider::Giphy, "id101", START_MS)
        .is_none());
}

/// A GIPHY result `id` with an onsent pingback, as a search holds it.
fn giphy_found(id: &str) -> Found {
    Found {
        candidate: Candidate {
            provider: Provider::Giphy,
            id: id.to_string(),
            title: String::new(),
            url: format!("https://media.giphy.com/media/{id}/giphy.gif"),
            preview_url: format!("https://media.giphy.com/media/{id}/200w_s.gif"),
            width: 1,
            height: 1,
            auto_loads: false,
        },
        pingbacks: Some(Pingbacks {
            onsent: Some(format!("https://giphy-analytics.giphy.com/{id}")),
            ..Default::default()
        }),
    }
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

/// A GIPHY search that answers `found` after GIPHY's key is replaced while it is in flight,
/// which moves GIPHY's install epoch on disk and nowhere else.
struct KeyReplacedMidSearch {
    dir: std::path::PathBuf,
    found: Vec<Found>,
}
impl GifProvider for KeyReplacedMidSearch {
    fn search_gifs<'a>(
        &'a self,
        _: &'a str,
        _: Rating,
        _: usize,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        install::forget_install_for(&self.dir, Provider::Giphy);
        Box::pin(async move { Ok(self.found.clone()) })
    }
    fn lookup_gifs<'a>(
        &'a self,
        _: &'a [String],
        _: Rating,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
}

/// Catches a search recorded without its disk-epoch check. The analytics' held epoch lags the
/// disk until something follows the new one, so a record checked against the held epoch alone
/// would hold a search that spanned a key change.
#[tokio::test]
async fn a_search_whose_disk_epoch_moved_is_not_recorded() {
    let dir = tempfile::tempdir().unwrap();
    pin_giphy(dir.path());
    let store = Arc::new(FakeStore::default());
    store.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let moved = dir.path().to_path_buf();
    let adapters: Adapters = Arc::new(
        move |_: Provider, _: Secret, _: Option<String>, _: i64| -> Box<dyn GifProvider> {
            Box::new(KeyReplacedMidSearch {
                dir: moved.clone(),
                found: vec![giphy_found("g1")],
            })
        },
    );
    let service = GifService::new(
        dir.path().to_path_buf(),
        Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3)),
        adapters,
        Arc::new(|| START_MS),
    );
    let before = install::install_epoch(dir.path(), Provider::Giphy);
    let (_, found) = service
        .run(&normalize(Some("x"), None, Some(2)).unwrap(), None, None)
        .await
        .unwrap();
    assert_eq!(ids(&found), vec!["g1"], "the search still answers");
    assert_eq!(
        install::install_epoch(dir.path(), Provider::Giphy),
        before + 1,
        "the disk epoch moved mid-search"
    );
    assert_eq!(
        service.analytics.held_count(),
        0,
        "found under the old key: not held"
    );
}

#[tokio::test]
async fn the_service_runs_any_provider_through_the_trait_in_its_order() {
    let dir = tempfile::tempdir().unwrap();
    pin_giphy(dir.path());
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
        move |_: Provider, _: Secret, _: Option<String>, _: i64| -> Box<dyn GifProvider> {
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
    assert_eq!(
        save_active(&keys, h.dir.path(), "another-key-value-0001"),
        Err(
            "This computer has no secret store, so the key can't be kept here. Nothing changed."
                .to_string()
        )
    );
    assert!(settings::remove_with(&keys, h.dir.path(), Provider::Giphy).is_err());
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_that_ends_after_a_remove_never_caches_the_removed_key() {
    let (release, wait) = std::sync::mpsc::channel();
    let store = Arc::new(Prompting {
        release: Mutex::new(wait),
        gets: AtomicUsize::new(0),
    });
    let keys = Keys::new(
        store.clone(),
        true,
        Some(ACCOUNT),
        Duration::from_millis(100),
    );
    assert_eq!(
        keys.read_timed(Provider::Giphy).await,
        Err(GifError::KeychainUnavailable),
        "the read still waits on its prompt"
    );
    keys.remove_key(Provider::Giphy).unwrap();
    release.send(()).unwrap();
    for _ in 0..100 {
        if !keys.is_reading() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!keys.is_reading());
    assert!(!keys.has_cached_key(), "the late read kept the removed key");
    assert_eq!(store.gets.load(Ordering::SeqCst), 1);
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

#[test]
fn every_gif_error_names_the_active_provider() {
    let after_settings = [
        GifError::NoProvider,
        GifError::KeychainUnavailable,
        GifError::NoSecretStore,
        GifError::InvalidKey,
        GifError::RateLimited { retry_after: 30 },
        GifError::ProviderUnavailable,
        GifError::BadQuery("provider is not the active GIF provider"),
    ];
    for (provider, other) in [
        (Provider::Giphy, Provider::Klipy),
        (Provider::Klipy, Provider::Giphy),
    ] {
        for error in after_settings {
            let text = error.message(Some(provider));
            assert!(text.contains(provider.display_name()), "{text}");
            assert!(!text.contains(other.display_name()), "{text}");
            let failed = Failed {
                provider: Some(provider),
                error,
            };
            assert_eq!(failed.tool_result()["message"], text);
            assert_eq!(failed.tool_result()["error"], error.code());
        }
        // A provider's own refusal names it once.
        let refused = transport::classify(
            provider,
            Ok(Reply {
                status: 404,
                retry_after: None,
                body: Vec::new(),
            }),
            START_MS,
        )
        .unwrap_err();
        let text = refused.message(Some(provider));
        assert_eq!(text.matches(provider.display_name()).count(), 1, "{text}");
    }
    // Input checks, search Off and the pane's media check come before any provider: they say
    // "GIF search" and name none.
    let before_settings = [
        GifError::NoProvider,
        GifError::BadQuery("query is blank"),
        GifError::BadQuery("unknown provider"),
        GifError::MediaOff,
    ];
    for error in after_settings.into_iter().chain(before_settings) {
        let text = error.message(None);
        assert_eq!(text, error.to_string());
        assert!(text.contains("GIF search"), "{text}");
        assert!(!text.contains("GIPHY") && !text.contains("KLIPY"), "{text}");
    }
}

/// A harness whose KLIPY keychain item is empty while GIPHY's holds [`KEY`].
fn harness_without_a_klipy_key() -> Harness {
    harness_with(
        |store| {
            let store: Arc<dyn CredentialStore> = store;
            let empty: Arc<dyn CredentialStore> = Arc::new(FakeStore::default());
            Keys::per_provider(
                move |provider| -> Arc<dyn CredentialStore> {
                    match provider {
                        Provider::Giphy => store.clone(),
                        Provider::Klipy => empty.clone(),
                    }
                },
                true,
                Some(ACCOUNT),
                Duration::from_secs(3),
            )
        },
        true,
    )
}

#[tokio::test]
async fn a_search_error_names_the_provider_it_ran_under() {
    let h = harness_without_a_klipy_key();
    let request = normalize(Some("ship it"), None, None).unwrap();
    let settings = h.dir.path().join(settings::FILE);
    std::fs::write(&settings, r#"{"provider":"klipy"}"#).unwrap();
    let failed = h.service.run_in(&request, None, None).await.unwrap_err();
    assert_eq!(
        failed,
        Failed {
            provider: Some(Provider::Klipy),
            error: GifError::NoProvider,
        }
    );
    assert!(failed.tool_result()["message"]
        .as_str()
        .unwrap()
        .contains("no KLIPY key"));
    let other = h
        .service
        .run_in(&request, Some(Provider::Giphy), None)
        .await
        .unwrap_err();
    assert_eq!(other.provider, Some(Provider::Klipy));
    assert_eq!(other.error.code(), "badQuery");
    // With search Off no provider is active, so none is named.
    std::fs::write(&settings, r#"{"enabled":false,"provider":"klipy"}"#).unwrap();
    assert_eq!(
        h.service.run_in(&request, None, None).await,
        Err(Failed {
            provider: None,
            error: GifError::NoProvider,
        })
    );
    assert_eq!(h.transport.requests(), 0);
}

#[tokio::test]
async fn klipy_key_reads_from_its_own_service() {
    assert_eq!(Provider::Klipy.key_service(), "ai.codesense.klipy-api-key");
    assert_eq!(Provider::Giphy.key_service(), "ai.codesense.giphy-api-key");
    let (giphy, klipy) = (
        Arc::new(FakeStore::default()),
        Arc::new(FakeStore::default()),
    );
    giphy.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let (g, k): (Arc<dyn CredentialStore>, Arc<dyn CredentialStore>) =
        (giphy.clone(), klipy.clone());
    let keys = Keys::per_provider(
        move |provider| match provider {
            Provider::Giphy => g.clone(),
            Provider::Klipy => k.clone(),
        },
        true,
        Some(ACCOUNT),
        Duration::from_secs(3),
    );
    assert!(keys.read_key(Provider::Klipy).unwrap().is_none());
    assert_eq!(
        keys.read_timed(Provider::Klipy).await.map(|_| ()),
        Err(GifError::NoProvider)
    );
    klipy
        .set(ACCOUNT, &Secret::new("a-klipy-key-value-0001"))
        .unwrap();
    assert_eq!(
        keys.read_timed(Provider::Klipy).await.unwrap().expose(),
        "a-klipy-key-value-0001"
    );
    assert_eq!(
        keys.read_timed(Provider::Giphy).await.unwrap().expose(),
        KEY
    );
}

#[test]
fn klipy_has_its_own_bucket_and_production_mark() {
    let fp = fingerprint(&Secret::new(KEY));
    assert_eq!(bucket_key(Provider::Klipy, &fp), format!("klipy:{fp}"));
    assert_ne!(
        bucket_key(Provider::Klipy, &fp),
        bucket_key(Provider::Giphy, &fp)
    );
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(settings::FILE),
        serde_json::json!({"provider": "klipy", "productionKeys": [format!("klipy:{fp}")]})
            .to_string(),
    )
    .unwrap();
    let loaded = settings::load(dir.path());
    assert_eq!(loaded.provider, Provider::Klipy);
    assert!(loaded.is_production(Provider::Klipy, &fp));
    assert!(!loaded.is_production(Provider::Giphy, &fp));
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

    let replaced = save_active(&h.keys(), h.dir.path(), "a-replacement-key").unwrap();
    assert!(!replaced.production);
    assert!(!h.file(settings::FILE).contains("giphy:"));
    // The replacement is a new key with a full bucket of its own.
    assert!(h.search("ship it").await.is_ok());

    settings::set_with(&h.keys(), h.dir.path(), production(true)).unwrap();
    let removed = settings::remove_with(&h.keys(), h.dir.path(), Provider::Giphy).unwrap();
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
    // One search frees every 40 s from then, never all 90 at once.
    assert_eq!(
        corrupt.take("giphy:aaaaaaaaaaaaaaaa", false, START_MS + 1),
        Err(GifError::RateLimited { retry_after: 40 })
    );
    assert!(corrupt
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS + 40_000)
        .is_ok());
    assert!(corrupt
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS + 40_000)
        .is_err());
    assert!(corrupt
        .take("giphy:aaaaaaaaaaaaaaaa", false, START_MS + 80_000)
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
        .take("giphy:bbbbbbbbbbbbbbbb", false, START_MS + 40_000)
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
    pin_giphy(dir.path());
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

    save_active(&keys, dir.path(), "  a-new-key-value-0001 \n").unwrap();
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
        assert!(save_active(&keys, dir.path(), bad).is_err(), "{bad:?}");
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
    settings::remove_with(&keys, dir.path(), Provider::Giphy).unwrap();
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
    pin_giphy(dir.path());
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
    pin_giphy(dir.path());
    let inner = FakeStore::default();
    inner.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let keys = Keys::new(
        Arc::new(ReadOnly(inner)),
        true,
        Some(ACCOUNT),
        Duration::from_secs(3),
    );
    let error = save_active(&keys, dir.path(), "a-replacement-key-0001").unwrap_err();
    assert!(error.ends_with("Nothing changed."), "{error}");

    let production = SettingsUpdate {
        production: Some(true),
        ..Default::default()
    };
    settings::set_with(&keys, dir.path(), production.clone()).unwrap();
    let error = save_active(&keys, dir.path(), "a-replacement-key-0001").unwrap_err();
    assert!(
        error.contains("no longer marked as a production key"),
        "{error}"
    );
    assert!(!error.contains("Nothing changed"));
    assert!(settings::load(dir.path()).production_keys.is_empty());
    assert!(!settings::status_with(&keys, dir.path()).production);

    // Only the provider being saved counts: GIPHY's production mark says nothing about KLIPY.
    settings::set_with(&keys, dir.path(), production).unwrap();
    let klipy = SettingsUpdate {
        provider: Some("klipy".to_string()),
        ..Default::default()
    };
    settings::set_with(&keys, dir.path(), klipy).unwrap();
    let error = save_active(&keys, dir.path(), "a-replacement-key-0001").unwrap_err();
    assert!(error.ends_with("Nothing changed."), "{error}");
    let marks = settings::load(dir.path()).production_keys;
    assert!(marks.iter().all(|k| k.starts_with("giphy:")), "{marks:?}");
    assert_eq!(marks.len(), 1);
}

#[test]
fn a_key_pasted_for_the_other_provider_is_refused_and_changes_nothing() {
    let (h, klipy) = two_key_harness();
    let production = SettingsUpdate {
        production: Some(true),
        ..SettingsUpdate::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), production).unwrap();
    // The card switched to KLIPY after the GIPHY key was pasted.
    settings::set_with(&h.keys(), h.dir.path(), choose("klipy")).unwrap();
    let before = h.file(settings::FILE);
    let refused = settings::save_with(
        &h.keys(),
        h.dir.path(),
        Provider::Giphy,
        "a-replacement-key-0001",
    )
    .unwrap_err();
    assert_eq!(
        refused,
        "GIF search now uses KLIPY, not GIPHY. Nothing changed."
    );
    assert_eq!(h.file(settings::FILE), before, "nothing was written");
    assert_eq!(h.store.inner.get(ACCOUNT).unwrap().unwrap().expose(), KEY);
    assert_eq!(
        klipy.inner.get(ACCOUNT).unwrap().unwrap().expose(),
        KLIPY_KEY
    );
}

#[test]
fn a_bad_paste_is_refused_before_the_production_flag_changes() {
    let dir = tempfile::tempdir().unwrap();
    pin_giphy(dir.path());
    let store = Arc::new(FakeStore::default());
    store.set(ACCOUNT, &Secret::new(KEY)).unwrap();
    let keys = Keys::new(store.clone(), true, Some(ACCOUNT), Duration::from_secs(3));
    let production = SettingsUpdate {
        production: Some(true),
        ..Default::default()
    };
    settings::set_with(&keys, dir.path(), production).unwrap();
    for bad in ["too-short", "two words in a key", ""] {
        let error = save_active(&keys, dir.path(), bad).unwrap_err();
        assert!(error.ends_with("Nothing changed."), "{error}");
        assert!(
            settings::status_with(&keys, dir.path()).production,
            "{bad:?}"
        );
    }
    assert_eq!(store.get(ACCOUNT).unwrap().unwrap().expose(), KEY);
    assert_eq!(
        settings::check_key(Provider::Giphy, "  a-key-of-16-char \n"),
        Ok("a-key-of-16-char".to_string())
    );
}

#[test]
fn an_environment_credential_source_refuses_key_writes() {
    let dir = tempfile::tempdir().unwrap();
    pin_giphy(dir.path());
    let env = Arc::new(EnvStore::new(Provider::Giphy.key_service()));
    let keys = Keys::new(env, true, Some(ACCOUNT), Duration::from_secs(3));
    let error = save_active(&keys, dir.path(), "a-key-value-long-enough").unwrap_err();
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
    let http = transport::Http::new().unwrap();
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

fn local_http() -> transport::Http {
    transport::Http::on(reqwest::Client::builder()).unwrap()
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
        .and(header("user-agent", transport::USER_AGENT))
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
    for (route, size) in [
        ("/fits", transport::MAX_BODY),
        ("/over", transport::MAX_BODY + 1),
    ] {
        Mock::given(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'a'; size]))
            .mount(&server)
            .await;
    }
    let http = local_http();
    let fits = http.get(&at(&server, "/fits")).await.unwrap();
    assert_eq!(fits.body.len(), transport::MAX_BODY);
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
        http.get(&chunked_server(transport::MAX_BODY + 1).await)
            .await,
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
            "message": "GIPHY search is paused. Try again in 30 seconds.",
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
    assert_eq!(
        defaults.provider,
        Provider::Klipy,
        "KLIPY on a fresh install"
    );
    assert_eq!(defaults.ceiling, Rating::Pg);
    assert!(defaults.production_keys.is_empty());
    assert!(defaults.saved_keys.is_empty());
    let read = |contents: &str| {
        std::fs::write(dir.path().join(settings::FILE), contents).unwrap();
        settings::load(dir.path())
    };
    assert_eq!(read("{broken"), defaults);
    assert_eq!(read("[1,2]"), defaults);
    let odd = read(
        r#"{"enabled":"no","provider":"tenor","ceiling":"r","productionKeys":["giphy:short",
        "giphy:0123456789abcdef", 7, "klipy:0123456789abcdef"],
        "savedKeys":["klipy","GIPHY","tenor",3,"klipy","giphy"]}"#,
    );
    assert_eq!(odd.saved_keys, [Provider::Klipy, Provider::Giphy]);
    assert!(odd.enabled);
    assert_eq!(odd.provider, Provider::Klipy);
    assert_eq!(odd.ceiling, Rating::Pg);
    assert_eq!(
        odd.production_keys,
        ["giphy:0123456789abcdef", "klipy:0123456789abcdef"]
    );
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
        serde_json::json!({"enabled": true, "provider": "klipy", "ceiling": "pg-13"})
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
    assert_eq!(ID_PATTERN, "^[A-Za-z0-9_-]{1,128}$");
    assert!(normalize(None, Some(list(&["a", "B-2", "c_3"]).as_slice()), None).is_ok());
    let ten: Vec<String> = (0..10).map(|i| format!("id{i}")).collect();
    assert!(normalize(None, Some(ten.as_slice()), None).is_ok());
    let eleven: Vec<String> = (0..11).map(|i| format!("id{i}")).collect();
    let long = "x".repeat(129);
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
    assert!(valid_id(&"x".repeat(128)));
    assert!(!valid_id(&"x".repeat(129)));
    assert!(normalize(None, Some(&["x".repeat(128)]), None).is_ok());
    assert!(matches!(
        normalize(Some("ship it"), Some(list(&["a"]).as_slice()), None),
        Err(GifError::BadQuery(_))
    ));
    assert!(matches!(
        normalize(None, None, None),
        Err(GifError::BadQuery(_))
    ));
}

// ---- The Inbox pane's gifSearch: stills as data: URIs ----

const STILL: &[u8] = b"GIF89a\x02\x00\x03\x00";

/// Stills served in call order: each call's URL is kept, and the calls named in `fail` fail and
/// those in `hang` never answer.
#[derive(Default)]
struct Stills {
    urls: Mutex<Vec<String>>,
    fail: Vec<usize>,
    hang: Vec<usize>,
}
impl Stills {
    fn calls(&self) -> usize {
        self.urls.lock().unwrap().len()
    }
}
impl crate::media::preview::PreviewFetch for Stills {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, crate::media::Failure>> {
        let call = {
            let mut urls = self.urls.lock().unwrap();
            urls.push(url.to_string());
            urls.len() - 1
        };
        if self.hang.contains(&call) {
            return Box::pin(futures_util::future::pending());
        }
        let failed = self.fail.contains(&call);
        Box::pin(async move {
            if failed {
                Err(crate::media::Failure {
                    reason: "network",
                    retryable: true,
                })
            } else {
                Ok(STILL.to_vec())
            }
        })
    }
}

fn page_args(query: &str) -> SearchArgs<'_> {
    SearchArgs {
        query: Some(query),
        ..Default::default()
    }
}

async fn page(h: &Harness, config: &crate::media::Config, stills: &Stills) -> serde_json::Value {
    page::search_page(
        &h.service,
        config,
        page_args("ship it"),
        stills,
        Duration::from_secs(3),
    )
    .await
}

#[tokio::test]
async fn gif_search_verb_returns_previews_as_data_uris() {
    let h = harness();
    let stills = Stills::default();
    h.transport.reply(200, None, SEARCH);
    let result = page(&h, &crate::media::Config::default(), &stills).await;
    assert_eq!(result["status"], "ok");
    assert_eq!(result["provider"], "giphy");
    let candidates = result["candidates"].as_array().unwrap();
    assert_eq!(candidates.len(), 3);
    let expected = format!(
        "data:image/gif;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, STILL)
    );
    for candidate in candidates {
        assert_eq!(candidate["previewData"], expected.as_str());
        assert_eq!(
            candidate["autoLoads"], true,
            "the team config still marks autoLoads"
        );
    }
    let asked: Vec<&str> = candidates
        .iter()
        .map(|c| c["previewUrl"].as_str().unwrap())
        .collect();
    assert_eq!(
        *stills.urls.lock().unwrap(),
        asked,
        "each still fetched once, in order"
    );
    assert_eq!(h.transport.requests(), 1, "one provider request per search");
}

#[tokio::test]
async fn gif_search_verb_never_returns_the_key() {
    let h = harness();
    let stills = Stills::default();
    h.transport.reply(200, None, SEARCH);
    let ok = page(&h, &crate::media::Config::default(), &stills).await;
    h.transport.reply(401, None, "{}");
    let refused = page(&h, &crate::media::Config::default(), &stills).await;
    assert_eq!(refused["error"], "invalidKey");
    for result in [ok, refused] {
        assert!(!result.to_string().contains(KEY), "{result}");
    }
}

#[tokio::test]
async fn gif_search_verb_off_no_key_keychain_make_no_network_call() {
    let team = crate::media::Config::default();
    let off = harness();
    settings::set_with(
        &off.keys(),
        off.dir.path(),
        SettingsUpdate {
            enabled: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    let no_key = harness_with(
        |store| Keys::new(store, true, Some(ACCOUNT), Duration::from_secs(3)),
        false,
    );
    let locked = harness_with(
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
    let no_store = harness_with(
        |store| Keys::new(store, false, Some(ACCOUNT), Duration::from_secs(3)),
        true,
    );
    for (h, code) in [
        (&off, "noProvider"),
        (&no_key, "noProvider"),
        (&locked, "keychainUnavailable"),
        (&no_store, "keychainUnavailable"),
    ] {
        let stills = Stills::default();
        let result = page(h, &team, &stills).await;
        assert_eq!(result["status"], "error");
        assert_eq!(result["error"], code);
        assert_eq!(h.transport.requests(), 0, "{code}: no provider request");
        assert_eq!(stills.calls(), 0, "{code}: no still fetched");
    }
}

#[tokio::test]
async fn gif_search_verb_team_media_off_makes_no_network_call() {
    let h = harness();
    let stills = Stills::default();
    let before = h.store.calls.load(Ordering::SeqCst);
    let off = crate::media::Config {
        remote: crate::media::Remote::Off,
        ..Default::default()
    };
    let result = page(&h, &off, &stills).await;
    assert_eq!(result["status"], "error");
    assert_eq!(result["error"], "mediaOff");
    assert_eq!(h.transport.requests(), 0);
    assert_eq!(stills.calls(), 0);
    assert_eq!(
        h.store.calls.load(Ordering::SeqCst),
        before,
        "the key is not read"
    );
    // Ask still searches: it guards media other people send, not the person's own search.
    let ask = crate::media::Config {
        remote: crate::media::Remote::Ask,
        ..Default::default()
    };
    h.transport.reply(200, None, SEARCH);
    assert_eq!(page(&h, &ask, &stills).await["status"], "ok");
    assert_eq!(stills.calls(), 3);
}

#[tokio::test]
async fn gif_search_verb_drops_a_failed_still_without_error() {
    let h = harness();
    let stills = Stills {
        fail: vec![1],
        ..Default::default()
    };
    h.transport.reply(200, None, SEARCH);
    let result = page(&h, &crate::media::Config::default(), &stills).await;
    assert_eq!(result["status"], "ok");
    let candidates = result["candidates"].as_array().unwrap();
    assert_eq!(
        candidates.len(),
        3,
        "the candidate stays, with an empty tile"
    );
    assert!(candidates[0]["previewData"].is_string());
    assert!(candidates[1].get("previewData").is_none());
    assert!(candidates[2]["previewData"].is_string());
}

#[tokio::test]
async fn gif_search_verb_drops_a_still_past_the_deadline() {
    let h = harness();
    let stills = Stills {
        hang: vec![0],
        ..Default::default()
    };
    h.transport.reply(200, None, SEARCH);
    let started = std::time::Instant::now();
    let result = page::search_page(
        &h.service,
        &crate::media::Config::default(),
        page_args("ship it"),
        &stills,
        Duration::from_millis(200),
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "one shared deadline"
    );
    assert_eq!(result["status"], "ok");
    let candidates = result["candidates"].as_array().unwrap();
    assert!(candidates[0].get("previewData").is_none());
    assert!(candidates[1]["previewData"].is_string());
    assert!(candidates[2]["previewData"].is_string());
}

#[tokio::test]
async fn mcp_gif_search_is_unchanged_by_previews() {
    use crate::mcp::gif_tools::{search_with, GifSearchParams};
    let h = harness();
    h.transport.reply(200, None, SEARCH);
    let result = search_with(
        &h.service,
        Some(&crate::media::Config::default()),
        GifSearchParams {
            query: Some("ship it".into()),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(h.transport.requests(), 1, "exactly one request per search");
    let mut top: Vec<&str> = result
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    top.sort_unstable();
    assert_eq!(top, ["candidates", "provider", "status"]);
    for candidate in result["candidates"].as_array().unwrap() {
        let mut keys: Vec<&str> = candidate
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "autoLoads",
                "height",
                "id",
                "previewUrl",
                "provider",
                "title",
                "url",
                "width"
            ],
            "no previewData on the MCP result"
        );
    }
}

#[test]
fn a_pick_registers_only_a_known_provider_and_a_valid_id() {
    let mut picks = Vec::new();
    let ok = super::page::picked("giphy", "g1", |provider, id| picks.push((provider, id)));
    assert_eq!(ok, serde_json::json!({"status": "ok"}));
    assert_eq!(picks, vec![(Provider::Giphy, "g1".to_string())]);
    for (provider, id) in [("other", "g1"), ("giphy", "a b"), ("giphy", "")] {
        let refused = super::page::picked(provider, id, |_, _| panic!("not registered"));
        assert_eq!(refused["status"], "error", "{provider} {id}");
        assert_eq!(refused["error"], "badQuery");
    }
}

// ---- KLIPY: search, lookup and its bucket ----

const KLIPY_SEARCH: &str = include_str!("fixtures/klipy/search.json");
const KLIPY_ITEMS: &str = include_str!("fixtures/klipy/items.json");
/// The fixture's usable results, in KLIPY's order: an ad, a result with no slug, one off
/// KLIPY's hosts, one with only video and one with an invalid slug sit between them.
const KLIPY_KEPT: [&str; 12] = [
    "hello-hi-662",
    "wave-hello-101",
    "ship-it-77",
    "thumbs-up-12",
    "party-time-55",
    "thank-you-so-much-for-everything-you-did-today-it-really-made-my-whole-week-better-42",
    "high-five-8",
    "dance-floor-21",
    "mic-drop-4",
    "lets-go-90",
    "celebrate-33",
    "nailed-it-6",
];
const KLIPY_EMPTY: &str = r#"{"result":true,"data":{"data":[]}}"#;

/// The KLIPY adapter on a recorded transport.
fn klipy_adapter(key: &str, customer_id: Option<&str>) -> (Klipy, Arc<Recorded>) {
    let wire = Arc::new(Recorded::default());
    let transport: Arc<dyn Transport> = wire.clone();
    let adapter = Klipy::new(
        Secret::new(key),
        customer_id.map(str::to_string),
        transport,
        START_MS,
    );
    (adapter, wire)
}

/// The harness with KLIPY the active provider.
fn klipy_harness() -> Harness {
    let h = harness();
    std::fs::write(h.dir.path().join(settings::FILE), r#"{"provider":"klipy"}"#).unwrap();
    h
}

fn pairs_of(url: &url::Url) -> Vec<(String, String)> {
    url.query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn lookup(ids: &[&str]) -> Request {
    let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
    normalize(None, Some(ids.as_slice()), None).unwrap()
}

#[tokio::test]
async fn klipy_search_sends_q_per_page_filter_customer_id() {
    let (klipy, wire) = klipy_adapter(KEY, Some("an-install-id"));
    wire.reply(200, None, KLIPY_SEARCH);
    GifProvider::search_gifs(&klipy, "ship it", Rating::Pg, 6)
        .await
        .unwrap();
    let url = wire.urls.lock().unwrap()[0].clone();
    assert_eq!(url.scheme(), "https");
    assert_eq!(url.host_str(), Some("api.klipy.com"));
    assert_eq!(url.path(), format!("/api/v1/{KEY}/gifs/search"));
    let expected = [
        ("q", "ship it"),
        ("per_page", "8"),
        ("page", "1"),
        ("content_filter", "medium"),
        ("customer_id", "an-install-id"),
    ]
    .map(|(k, v)| (k.to_string(), v.to_string()));
    assert_eq!(pairs_of(&url), expected);
}

#[tokio::test]
async fn klipy_search_asks_for_8_and_returns_limit_in_order() {
    for (limit, per_page) in [(1, "8"), (6, "8"), (10, "10")] {
        let (klipy, wire) = klipy_adapter(KEY, None);
        wire.reply(200, None, KLIPY_SEARCH);
        let found = GifProvider::search_gifs(&klipy, "hello", Rating::Pg, limit)
            .await
            .unwrap();
        let candidates: Vec<Candidate> = found.into_iter().map(|f| f.candidate).collect();
        assert_eq!(ids(&candidates), KLIPY_KEPT[..limit], "limit {limit}");
        assert!(wire
            .last_pairs()
            .contains(&("per_page".into(), per_page.into())));
    }
}

#[tokio::test]
async fn klipy_search_never_sends_content_filter_off() {
    for (rating, filter) in [
        (Rating::G, "high"),
        (Rating::Pg, "medium"),
        (Rating::Pg13, "low"),
    ] {
        assert_eq!(klipy::content_filter(rating), filter);
        let (klipy, wire) = klipy_adapter(KEY, None);
        wire.reply(200, None, KLIPY_EMPTY);
        GifProvider::search_gifs(&klipy, "hello", rating, 6)
            .await
            .unwrap();
        let filters: Vec<String> = wire
            .last_pairs()
            .into_iter()
            .filter(|(k, _)| k == "content_filter")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(filters, [filter]);
    }
}

#[tokio::test]
async fn klipy_search_maps_401_403_429_5xx_and_bad_json() {
    let cases: [(u16, Option<&str>, &str, GifError); 11] = [
        (401, None, "{}", GifError::InvalidKey),
        (403, None, "{}", GifError::InvalidKey),
        (
            429,
            Some("30"),
            "{}",
            GifError::RateLimited { retry_after: 30 },
        ),
        (
            429,
            None,
            "{}",
            GifError::RateLimited {
                retry_after: bucket::retry_after_secs(None, START_MS),
            },
        ),
        (
            404,
            None,
            "{}",
            GifError::BadQuery("KLIPY refused the request"),
        ),
        (
            400,
            None,
            "{}",
            GifError::BadQuery("KLIPY refused the request"),
        ),
        (500, None, "{}", GifError::ProviderUnavailable),
        (503, None, "{}", GifError::ProviderUnavailable),
        (200, None, "not json", GifError::ProviderUnavailable),
        (
            200,
            None,
            r#"{"result":false,"data":{"data":[]}}"#,
            GifError::ProviderUnavailable,
        ),
        (
            200,
            None,
            r#"{"result":true,"data":[]}"#,
            GifError::ProviderUnavailable,
        ),
    ];
    for (status, retry_after, body, expected) in cases {
        let (klipy, wire) = klipy_adapter(KEY, None);
        wire.reply(status, retry_after, body);
        let result = GifProvider::search_gifs(&klipy, "hello", Rating::Pg, 6).await;
        assert_eq!(result.map(|_| ()), Err(expected), "{status} {body}");
    }
    let (klipy, wire) = klipy_adapter(KEY, None);
    wire.fail(Failure::Timeout);
    assert_eq!(
        GifProvider::search_gifs(&klipy, "hello", Rating::Pg, 6)
            .await
            .map(|_| ()),
        Err(GifError::ProviderUnavailable)
    );
}

#[tokio::test]
async fn klipy_search_drops_ads_offhost_unfit_and_bad_slugs_only() {
    let (klipy, wire) = klipy_adapter(KEY, None);
    wire.reply(200, None, KLIPY_SEARCH);
    let found = GifProvider::search_gifs(&klipy, "hello", Rating::Pg, 10)
        .await
        .unwrap();
    let candidates: Vec<Candidate> = found.iter().map(|f| f.candidate.clone()).collect();
    for dropped in [
        "ad-slot-1",
        "off-host-9",
        "no-fitting-rendition-3",
        "bad/slug",
    ] {
        assert!(!ids(&candidates).contains(&dropped), "{dropped}");
    }
    assert!(found.iter().all(|f| f.pingbacks.is_none()));
    let first = &candidates[0];
    assert_eq!(first.provider, Provider::Klipy);
    assert_eq!(first.id, "hello-hi-662");
    assert_eq!(first.title, "Hello");
    // The smallest animated rendition at least 480 wide, and the sm still.
    assert_eq!(
        first.url,
        "https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/01/af/md1.webp"
    );
    assert_eq!(
        first.preview_url,
        "https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/01/af/sm1.jpg"
    );
    assert_eq!((first.width, first.height), (498, 280));
    // A slug longer than 64 characters is kept.
    assert!(candidates.iter().any(|c| c.id.len() > 64));
}

#[tokio::test]
async fn klipy_key_is_percent_escaped_in_the_path() {
    let key = "k/ey?x=1#y%z-and-padding-0001";
    let (klipy, wire) = klipy_adapter(key, Some("an-install-id"));
    wire.reply(200, None, KLIPY_EMPTY);
    wire.reply(200, None, KLIPY_EMPTY);
    GifProvider::search_gifs(&klipy, "hello", Rating::Pg, 6)
        .await
        .unwrap();
    GifProvider::lookup_gifs(&klipy, &["hello-hi-662".to_string()], Rating::Pg)
        .await
        .unwrap();
    let urls = wire.urls.lock().unwrap().clone();
    for (url, tail) in urls.iter().zip(["search", "items"]) {
        let segments: Vec<&str> = url.path_segments().unwrap().collect();
        assert_eq!(
            segments,
            [
                "api",
                "v1",
                "k%2Fey%3Fx=1%23y%25z-and-padding-0001",
                "gifs",
                tail
            ],
            "{url}"
        );
        assert_eq!(url.fragment(), None);
        assert!(pairs_of(url)
            .iter()
            .all(|(k, v)| k != "x" && !v.contains("ey")));
    }
    assert_eq!(
        pairs_of(&urls[1]),
        [("slugs".to_string(), "hello-hi-662".to_string())]
    );
}

#[tokio::test]
async fn klipy_no_error_log_or_result_holds_the_key() {
    crate::test_logger::clear("gif");
    let h = klipy_harness();
    h.transport.fail(Failure::Network);
    h.transport
        .reply(500, None, &format!("{{\"echo\":\"{KEY}\"}}"));
    h.transport.reply(401, None, "{}");
    h.transport.reply(404, None, "{}");
    h.transport.reply(200, None, "not json");
    h.transport.reply(200, None, r#"{"result":false}"#);
    h.transport.reply(429, Some("5"), "{}");
    let request = normalize(Some("ship it"), None, None).unwrap();
    for _ in 0..7 {
        let failed = h.service.run_in(&request, None, None).await.unwrap_err();
        assert_eq!(failed.provider, Some(Provider::Klipy));
        let result = failed.tool_result().to_string();
        assert!(
            !result.contains(KEY) && !result.contains("api.klipy.com"),
            "{result}"
        );
        assert!(!format!("{failed:?}").contains(KEY));
    }
    assert!(h
        .transport
        .urls
        .lock()
        .unwrap()
        .iter()
        .all(|u| u.path().contains(KEY) && u.query().is_some_and(|q| !q.contains(KEY))));
    let lines = crate::test_logger::lines("gif");
    assert!(lines.len() >= 7, "{lines:?}");
    for line in &lines {
        assert!(!line.contains(KEY), "{line}");
    }
    assert!(h.file(bucket::FILE).contains("klipy:"));
    assert!(!h.file(bucket::FILE).contains(KEY));
}

/// A KLIPY search reply with one md GIF per `(slug, url)`.
fn klipy_reply(items: &[(&str, String)]) -> String {
    let items: Vec<serde_json::Value> = items
        .iter()
        .map(|(slug, url)| {
            serde_json::json!({
                "slug": slug,
                "title": "x",
                "file": {"md": {"gif": {"url": url, "width": 498, "height": 280, "size": 300000}}},
            })
        })
        .collect();
    serde_json::json!({"result": true, "data": {"data": items}}).to_string()
}

#[tokio::test]
async fn klipy_drops_a_candidate_on_the_api_host_or_holding_the_key() {
    let key = "k/ey?x=1#y%z-and-padding-0001";
    let escaped = "k%2Fey%3Fx=1%23y%25z-and-padding-0001";
    let (klipy, wire) = klipy_adapter(key, None);
    wire.reply(
        200,
        None,
        &klipy_reply(&[
            (
                "api-host-1",
                "https://api.klipy.com/ii/x/md1.gif".to_string(),
            ),
            (
                "escaped-key-2",
                format!("https://static.klipy.com/ii/{escaped}/md1.gif"),
            ),
            (
                "kept-3",
                "https://static.klipy.com/ii/x/md1.gif".to_string(),
            ),
        ]),
    );
    let found = GifProvider::search_gifs(&klipy, "hello", Rating::Pg, 10)
        .await
        .unwrap();
    let candidates: Vec<Candidate> = found.into_iter().map(|f| f.candidate).collect();
    assert_eq!(ids(&candidates), ["kept-3"]);

    // On the service, a reply that echoes the key in a media URL leaves no trace of it.
    crate::test_logger::clear("gif");
    let h = klipy_harness();
    h.transport.reply(
        200,
        None,
        &klipy_reply(&[
            (
                "raw-key-1",
                format!("https://static.klipy.com/ii/{KEY}/md1.gif"),
            ),
            (
                "api-host-2",
                format!("https://api.klipy.com/api/v1/{KEY}/md1.gif"),
            ),
            (
                "kept-3",
                "https://static.klipy.com/ii/x/md1.gif".to_string(),
            ),
        ]),
    );
    let request = normalize(Some("ship it"), None, None).unwrap();
    let (provider, candidates) = h.service.run(&request, None, None).await.unwrap();
    assert_eq!(ids(&candidates), ["kept-3"]);
    assert_eq!(provider, Provider::Klipy);
    let shown = format!("{candidates:?}");
    assert!(
        !shown.contains(KEY) && !shown.contains("api.klipy.com"),
        "{shown}"
    );
    for line in crate::test_logger::lines("gif") {
        assert!(!line.contains(KEY), "{line}");
    }
}

#[tokio::test]
async fn klipy_lookup_held_slug() {
    let h = klipy_harness();
    h.transport.reply(200, None, KLIPY_SEARCH);
    h.search("ship it").await.unwrap();
    h.transport.reply(200, None, KLIPY_ITEMS);
    let found = h.run(&lookup(&["thumbs-up-12"]), None).await.unwrap();
    assert_eq!(ids(&found), ["thumbs-up-12"]);
    assert_eq!(h.transport.requests(), 2);
    let url = h.transport.urls.lock().unwrap()[1].clone();
    assert_eq!(url.path(), format!("/api/v1/{KEY}/gifs/items"));
    assert_eq!(
        pairs_of(&url),
        [("slugs".to_string(), "thumbs-up-12".to_string())]
    );
}

#[tokio::test]
async fn klipy_lookup_unheld_slug_no_request_no_token() {
    let h = klipy_harness();
    let found = h.run(&lookup(&["hello-hi-662"]), None).await;
    assert_eq!(found, Ok(vec![]));
    assert_eq!(h.transport.requests(), 0);
    assert!(!h.file(bucket::FILE).contains("klipy:"));
}

#[tokio::test]
async fn klipy_lookup_slug_held_at_a_higher_rating() {
    let h = klipy_harness();
    let ceiling = SettingsUpdate {
        ceiling: Some("pg-13".into()),
        ..Default::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), ceiling).unwrap();
    h.transport.reply(200, None, KLIPY_SEARCH);
    let search = normalize(Some("ship it"), None, Some(6)).unwrap();
    h.run(&search, Some("pg-13")).await.unwrap();
    for rating in ["g", "pg"] {
        assert_eq!(
            h.run(&lookup(&["thumbs-up-12"]), Some(rating)).await,
            Ok(vec![]),
            "{rating}"
        );
    }
    assert_eq!(h.transport.requests(), 1);
    h.transport.reply(200, None, KLIPY_ITEMS);
    let found = h
        .run(&lookup(&["thumbs-up-12"]), Some("pg-13"))
        .await
        .unwrap();
    assert_eq!(ids(&found), ["thumbs-up-12"]);
}

#[tokio::test]
async fn klipy_lookup_order_asked() {
    let h = klipy_harness();
    h.transport.reply(200, None, KLIPY_SEARCH);
    h.search("ship it").await.unwrap();
    h.transport.reply(200, None, KLIPY_ITEMS);
    let asked = ["ship-it-77", "never-held-1", "hello-hi-662", "thumbs-up-12"];
    let found = h.run(&lookup(&asked), None).await.unwrap();
    assert_eq!(ids(&found), ["ship-it-77", "hello-hi-662", "thumbs-up-12"]);
    assert!(h.transport.last_pairs().contains(&(
        "slugs".into(),
        "ship-it-77,hello-hi-662,thumbs-up-12".into()
    )));
}

#[tokio::test]
async fn klipy_lookup_expired_hold() {
    let h = klipy_harness();
    h.transport.reply(200, None, KLIPY_SEARCH);
    h.search("ship it").await.unwrap();
    h.advance(61 * 60 * 1000);
    assert_eq!(h.run(&lookup(&["hello-hi-662"]), None).await, Ok(vec![]));
    assert_eq!(h.transport.requests(), 1);
}

#[tokio::test]
async fn klipy_lookup_mixed_provider_id() {
    let h = harness();
    h.transport.reply(200, None, SEARCH);
    let giphy = h.search("ship it").await.unwrap();
    let id = giphy[0].id.clone();
    std::fs::write(h.dir.path().join(settings::FILE), r#"{"provider":"klipy"}"#).unwrap();
    assert_eq!(h.run(&lookup(&[id.as_str()]), None).await, Ok(vec![]));
    assert_eq!(h.transport.requests(), 1);
}

#[tokio::test]
async fn klipy_lookup_never_extends_hold() {
    let h = klipy_harness();
    h.transport.reply(200, None, KLIPY_SEARCH);
    h.search("ship it").await.unwrap();
    h.advance(50 * 60 * 1000);
    h.transport.reply(200, None, KLIPY_ITEMS);
    let found = h.run(&lookup(&["thumbs-up-12"]), None).await.unwrap();
    assert_eq!(ids(&found), ["thumbs-up-12"]);
    let entry = h
        .service
        .analytics
        .held_entry(Provider::Klipy, "thumbs-up-12", h.now())
        .unwrap();
    assert_eq!(
        entry.query.as_deref(),
        Some("ship it"),
        "the share keeps the query"
    );
    assert_eq!(entry.rating, Rating::Pg);
    // The hold still ends an hour after the search.
    h.advance(10 * 60 * 1000);
    assert_eq!(h.run(&lookup(&["thumbs-up-12"]), None).await, Ok(vec![]));
    assert_eq!(h.transport.requests(), 2);
}

#[tokio::test]
async fn klipy_test_key_caps_at_90_own_bucket() {
    let h = klipy_harness();
    for _ in 0..90 {
        h.transport.reply(200, None, KLIPY_EMPTY);
        h.search("ship it").await.unwrap();
    }
    assert_eq!(
        h.search("ship it").await,
        Err(GifError::RateLimited { retry_after: 3600 })
    );
    assert_eq!(h.transport.requests(), 90);
    let fp = fingerprint(&Secret::new(KEY));
    let restarted = bucket::Bucket::new(h.dir.path().join(bucket::FILE));
    assert!(restarted
        .take(&format!("klipy:{fp}"), false, h.now())
        .is_err());
    // GIPHY's bucket for the same key is untouched.
    assert!(restarted
        .take(&format!("giphy:{fp}"), false, h.now())
        .is_ok());
}

#[tokio::test]
async fn klipy_production_key_exempt() {
    let h = klipy_harness();
    let production = SettingsUpdate {
        production: Some(true),
        ..Default::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), production).unwrap();
    for _ in 0..100 {
        h.transport.reply(200, None, KLIPY_EMPTY);
        h.search("ship it").await.unwrap();
    }
    assert_eq!(h.transport.requests(), 100);
    // The mark is KLIPY's alone: GIPHY's searches with the same key stay capped.
    let loaded = settings::load(h.dir.path());
    let fp = fingerprint(&Secret::new(KEY));
    assert!(loaded.is_production(Provider::Klipy, &fp));
    assert!(!loaded.is_production(Provider::Giphy, &fp));
}

// ---- gif-install.json: one entry per provider ----

fn install_json(dir: &std::path::Path) -> serde_json::Value {
    let text = std::fs::read_to_string(dir.join(install::FILE)).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn install_write_keeps_other_provider_entry_562c80() {
    let dir = tempfile::tempdir().unwrap();
    let fp = fingerprint(&Secret::new(KEY));
    std::fs::write(
        dir.path().join(install::FILE),
        serde_json::json!({"klipy": {"customerId": "a-customer-id", "key": fp}}).to_string(),
    )
    .unwrap();
    let epoch = install::install_epoch(dir.path(), Provider::Giphy);
    assert!(install::write_install(dir.path(), Provider::Giphy, &fp, "rid-1", epoch).unwrap());
    let file = install_json(dir.path());
    assert_eq!(file["klipy"]["customerId"], "a-customer-id");
    assert_eq!(file["giphy"]["randomId"], "rid-1");
    assert_eq!(
        install::read_install(dir.path(), Provider::Klipy, &fp).as_deref(),
        Some("a-customer-id")
    );
    assert_eq!(
        install::read_install(dir.path(), Provider::Giphy, &fp).as_deref(),
        Some("rid-1")
    );
}

#[test]
fn key_removal_drops_only_that_providers_entry() {
    let dir = tempfile::tempdir().unwrap();
    let fp = fingerprint(&Secret::new(KEY));
    let epochs = install::install_epochs(dir.path());
    install::write_install(dir.path(), Provider::Giphy, &fp, "rid-1", epochs.giphy).unwrap();
    let customer = install::customer_id(dir.path(), &fp, epochs.klipy).unwrap();
    install::forget_install_for(dir.path(), Provider::Giphy);
    assert_eq!(
        install::install_epochs(dir.path()),
        install::Epochs {
            giphy: epochs.giphy + 1,
            klipy: epochs.klipy,
        },
        "only GIPHY's epoch moves"
    );
    assert_eq!(
        install::read_install(dir.path(), Provider::Giphy, &fp),
        None
    );
    assert_eq!(
        install::read_install(dir.path(), Provider::Klipy, &fp),
        Some(customer)
    );
    install::forget_install_for(dir.path(), Provider::Klipy);
    assert!(
        !dir.path().join(install::FILE).exists(),
        "no entry left, no file"
    );
}

#[test]
fn off_deletes_the_file() {
    let h = harness();
    let fp = fingerprint(&Secret::new(KEY));
    let epochs = install::install_epochs(h.dir.path());
    install::write_install(h.dir.path(), Provider::Giphy, &fp, "rid-1", epochs.giphy).unwrap();
    install::customer_id(h.dir.path(), &fp, epochs.klipy).unwrap();
    let off = SettingsUpdate {
        enabled: Some(false),
        ..Default::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), off).unwrap();
    assert!(!h.dir.path().join(install::FILE).exists());
}

#[test]
fn customer_id_survives_a_giphy_key_save() {
    let h = harness();
    let fp = fingerprint(&Secret::new(KEY));
    let epoch = install::install_epoch(h.dir.path(), Provider::Klipy);
    let customer = install::customer_id(h.dir.path(), &fp, epoch).unwrap();
    save_active(&h.keys(), h.dir.path(), "a-new-giphy-key-0001").unwrap();
    assert_eq!(
        install::read_install(h.dir.path(), Provider::Klipy, &fp),
        Some(customer)
    );
}

#[test]
fn giphy_random_id_survives_klipy_save_and_a_new_klipy_key_gets_a_new_id() {
    let h = klipy_harness();
    let fp = fingerprint(&Secret::new(KEY));
    let epochs = install::install_epochs(h.dir.path());
    install::write_install(h.dir.path(), Provider::Giphy, &fp, "rid-1", epochs.giphy).unwrap();
    let old = install::customer_id(h.dir.path(), &fp, epochs.klipy).unwrap();
    let replacement = "a-new-klipy-key-0001";
    save_active(&h.keys(), h.dir.path(), replacement).unwrap();
    assert_eq!(
        install::read_install(h.dir.path(), Provider::Giphy, &fp).as_deref(),
        Some("rid-1")
    );
    assert_eq!(
        install::read_install(h.dir.path(), Provider::Klipy, &fp),
        None
    );
    let new_fp = fingerprint(&Secret::new(replacement));
    let epoch = install::install_epoch(h.dir.path(), Provider::Klipy);
    let new = install::customer_id(h.dir.path(), &new_fp, epoch).unwrap();
    assert_ne!(new, old);
}

#[tokio::test]
async fn customer_id_is_stable_across_searches() {
    let h = klipy_harness();
    for _ in 0..2 {
        h.transport.reply(200, None, KLIPY_EMPTY);
        h.search("ship it").await.unwrap();
    }
    let sent: Vec<String> = h
        .transport
        .urls
        .lock()
        .unwrap()
        .iter()
        .map(|url| {
            pairs_of(url)
                .into_iter()
                .find(|(k, _)| k == "customer_id")
                .map(|(_, v)| v)
                .unwrap()
        })
        .collect();
    assert_eq!(sent[0], sent[1]);
    assert!(uuid::Uuid::parse_str(&sent[0]).is_ok(), "{}", sent[0]);
    let fp = fingerprint(&Secret::new(KEY));
    assert_eq!(
        install_json(h.dir.path())["klipy"],
        serde_json::json!({"customerId": sent[0], "key": fp})
    );
    assert!(!h.file(install::FILE).contains(KEY));
}

#[tokio::test]
async fn unsaveable_customer_id_fails_search_as_unavailable() {
    let h = klipy_harness();
    // A folder where the file goes: the id can't be saved.
    std::fs::create_dir_all(h.dir.path().join(install::FILE)).unwrap();
    let request = normalize(Some("ship it"), None, None).unwrap();
    assert_eq!(
        h.service.run_in(&request, None, None).await,
        Err(Failed {
            provider: Some(Provider::Klipy),
            error: GifError::ProviderUnavailable,
        })
    );
    assert_eq!(h.transport.requests(), 0);
    assert!(!h.file(bucket::FILE).contains("klipy:"), "no token taken");
}

#[test]
fn concurrent_install_writes_keep_both_entries() {
    let dir = tempfile::tempdir().unwrap();
    let fp = fingerprint(&Secret::new(KEY));
    let epochs = install::install_epochs(dir.path());
    std::thread::scope(|scope| {
        let giphy = scope.spawn(|| {
            for i in 0..50 {
                let id = format!("rid-{i}");
                install::write_install(dir.path(), Provider::Giphy, &fp, &id, epochs.giphy)
                    .unwrap();
            }
        });
        let klipy = scope.spawn(|| {
            for _ in 0..50 {
                install::customer_id(dir.path(), &fp, epochs.klipy).unwrap();
            }
        });
        giphy.join().unwrap();
        klipy.join().unwrap();
    });
    let file = install_json(dir.path());
    assert_eq!(file["giphy"]["randomId"], "rid-49");
    assert!(file["klipy"]["customerId"].is_string());
}

// ---- AC 4: the provider choice and each provider's key ----

const KLIPY_KEY: &str = "a-klipy-key-for-settings-0042";

/// A harness whose GIPHY key and KLIPY key live in their own counting keychain items.
fn two_key_harness() -> (Harness, Arc<Counting>) {
    let klipy = Arc::new(Counting::default());
    klipy.inner.set(ACCOUNT, &Secret::new(KLIPY_KEY)).unwrap();
    let k: Arc<dyn CredentialStore> = klipy.clone();
    let h = harness_with(
        move |giphy| {
            let g: Arc<dyn CredentialStore> = giphy;
            Keys::per_provider(
                move |provider| match provider {
                    Provider::Giphy => g.clone(),
                    Provider::Klipy => k.clone(),
                },
                true,
                Some(ACCOUNT),
                Duration::from_secs(3),
            )
        },
        true,
    );
    (h, klipy)
}

fn choose(provider: &str) -> SettingsUpdate {
    SettingsUpdate {
        enabled: Some(true),
        provider: Some(provider.to_string()),
        ..SettingsUpdate::default()
    }
}

fn turn_off() -> SettingsUpdate {
    SettingsUpdate {
        enabled: Some(false),
        ..SettingsUpdate::default()
    }
}

#[test]
fn klipy_round_trips_and_an_unknown_provider_loads_the_default() {
    let h = harness();
    let view = settings::set_with(&h.keys(), h.dir.path(), choose("klipy")).unwrap();
    assert_eq!(view.provider, Provider::Klipy);
    assert!(h.file(settings::FILE).contains(r#""provider": "klipy""#));
    assert_eq!(settings::load(h.dir.path()).provider, Provider::Klipy);
    std::fs::write(
        h.dir.path().join(settings::FILE),
        r#"{"provider":"tenor","ceiling":"g"}"#,
    )
    .unwrap();
    let loaded = settings::load(h.dir.path());
    assert_eq!(loaded.provider, settings::GifSettings::default().provider);
    assert_eq!(loaded.ceiling, Rating::G, "the other fields still load");
}

#[test]
fn set_refuses_an_unknown_provider_and_changes_nothing() {
    let h = harness();
    for name in ["tenor", "KLIPY", " klipy", "off", ""] {
        let refused = settings::set_with(&h.keys(), h.dir.path(), choose(name)).unwrap_err();
        assert_eq!(refused, "The GIF provider is giphy or klipy.", "{name:?}");
    }
    assert_eq!(
        h.file(settings::FILE),
        GIPHY_SETTINGS,
        "nothing was written"
    );
}

#[tokio::test]
async fn switching_keeps_both_keys_and_their_production_marks() {
    let (h, klipy) = two_key_harness();
    let production = |flag| SettingsUpdate {
        production: Some(flag),
        ..SettingsUpdate::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), production(true)).unwrap();
    settings::set_with(&h.keys(), h.dir.path(), choose("klipy")).unwrap();
    let status = settings::status_with(&h.keys(), h.dir.path());
    assert_eq!(status.status, KeyState::Saved);
    assert_eq!(status.hint.as_deref(), Some("…0042"));
    assert!(!status.production, "KLIPY has its own production mark");
    settings::set_with(&h.keys(), h.dir.path(), production(true)).unwrap();
    settings::set_with(&h.keys(), h.dir.path(), choose("giphy")).unwrap();
    let status = settings::status_with(&h.keys(), h.dir.path());
    assert_eq!(status.status, KeyState::Saved);
    assert!(status.production, "GIPHY's mark stayed");
    assert!(h.store.inner.get(ACCOUNT).unwrap().is_some());
    assert!(klipy.inner.get(ACCOUNT).unwrap().is_some());
    let fp = fingerprint(&Secret::new(KLIPY_KEY));
    assert!(settings::load(h.dir.path()).is_production(Provider::Klipy, &fp));
}

#[tokio::test]
async fn save_status_and_remove_follow_the_loaded_provider() {
    let (h, klipy) = two_key_harness();
    settings::set_with(&h.keys(), h.dir.path(), choose("klipy")).unwrap();
    let saved = save_active(&h.keys(), h.dir.path(), "another-klipy-key-for-tests-77").unwrap();
    assert_eq!(saved.hint.as_deref(), Some("…s-77"));
    assert_eq!(
        klipy.inner.get(ACCOUNT).unwrap().unwrap().expose(),
        "another-klipy-key-for-tests-77"
    );
    assert_eq!(
        h.store.inner.get(ACCOUNT).unwrap().unwrap().expose(),
        KEY,
        "the GIPHY key is untouched"
    );
    // A KLIPY key is checked and named as KLIPY's.
    let refused = save_active(&h.keys(), h.dir.path(), "short").unwrap_err();
    assert!(refused.starts_with("A KLIPY key has at least"), "{refused}");
}

#[tokio::test]
async fn off_keys_row_removes_only_that_provider() {
    let (h, klipy) = two_key_harness();
    // Each key saved in Settings, KLIPY's marked production.
    save_active(&h.keys(), h.dir.path(), KEY).unwrap();
    settings::set_with(&h.keys(), h.dir.path(), choose("klipy")).unwrap();
    save_active(&h.keys(), h.dir.path(), KLIPY_KEY).unwrap();
    let production = SettingsUpdate {
        production: Some(true),
        ..SettingsUpdate::default()
    };
    settings::set_with(&h.keys(), h.dir.path(), production).unwrap();
    settings::set_with(&h.keys(), h.dir.path(), turn_off()).unwrap();
    // Off deleted the install file; the Keys row reads gif.json alone.
    assert!(!install::has_entry(h.dir.path(), Provider::Giphy));
    assert!(!install::has_entry(h.dir.path(), Provider::Klipy));
    let reads = (
        h.store.calls.load(Ordering::SeqCst),
        klipy.calls.load(Ordering::SeqCst),
    );
    let giphy_row = settings::status_of(&h.keys(), h.dir.path(), Provider::Giphy);
    let klipy_row = settings::status_of(&h.keys(), h.dir.path(), Provider::Klipy);
    assert_eq!(
        (
            giphy_row.status,
            giphy_row.hint.clone(),
            giphy_row.production
        ),
        (KeyState::Saved, None, false)
    );
    assert_eq!(
        (klipy_row.status, klipy_row.production),
        (KeyState::Saved, true)
    );
    assert_eq!(
        (
            h.store.calls.load(Ordering::SeqCst),
            klipy.calls.load(Ordering::SeqCst)
        ),
        reads,
        "the Keys row reads no keychain"
    );
    // Removing KLIPY's key clears only KLIPY's key, mark and marker.
    let removed = settings::remove_with(&h.keys(), h.dir.path(), Provider::Klipy).unwrap();
    assert_eq!(removed.status, KeyState::Missing);
    assert!(klipy.inner.get(ACCOUNT).unwrap().is_none());
    assert!(h.store.inner.get(ACCOUNT).unwrap().is_some());
    assert!(!h.file(settings::FILE).contains("klipy:"));
    assert_eq!(settings::load(h.dir.path()).saved_keys, [Provider::Giphy]);
    let giphy_row = settings::status_of(&h.keys(), h.dir.path(), Provider::Giphy);
    assert_eq!(giphy_row.status, KeyState::Saved);
    assert!(!settings::load(h.dir.path()).enabled, "still Off");
}

#[test]
fn a_saved_key_never_used_reads_as_saved_right_after_off() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Counting::default());
    let keys = Keys::new(store.clone(), true, Some(ACCOUNT), Duration::from_secs(3));
    save_active(&keys, dir.path(), KLIPY_KEY).unwrap();
    settings::set_with(&keys, dir.path(), turn_off()).unwrap();
    let reads = store.calls.load(Ordering::SeqCst);
    let row = settings::status_of(&keys, dir.path(), Provider::Klipy);
    assert_eq!(
        (row.status, row.hint, row.production),
        (KeyState::Saved, None, false)
    );
    // A provider switch leaves the marker alone, and GIPHY has no key.
    let giphy = SettingsUpdate {
        provider: Some("giphy".to_string()),
        ..SettingsUpdate::default()
    };
    settings::set_with(&keys, dir.path(), giphy).unwrap();
    let klipy_row = settings::status_of(&keys, dir.path(), Provider::Klipy);
    let giphy_row = settings::status_of(&keys, dir.path(), Provider::Giphy);
    assert_eq!(
        (klipy_row.status, giphy_row.status),
        (KeyState::Saved, KeyState::Missing)
    );
    assert_eq!(
        store.calls.load(Ordering::SeqCst),
        reads,
        "no keychain read"
    );
    // The marker is the provider's name only.
    let file = std::fs::read_to_string(dir.path().join(settings::FILE)).unwrap();
    assert!(!file.contains(KLIPY_KEY), "{file}");
    assert!(
        !file.contains(&fingerprint(&Secret::new(KLIPY_KEY))),
        "{file}"
    );
}

#[test]
fn a_keychain_read_brings_the_saved_key_marker_in_step() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(FakeStore::default());
    // A key saved before the marker existed.
    store.set(ACCOUNT, &Secret::new(KLIPY_KEY)).unwrap();
    let keys = Keys::new(store.clone(), true, Some(ACCOUNT), Duration::from_secs(3));
    assert!(settings::load(dir.path()).saved_keys.is_empty());
    assert_eq!(
        settings::status_with(&keys, dir.path()).status,
        KeyState::Saved
    );
    assert_eq!(settings::load(dir.path()).saved_keys, [Provider::Klipy]);
    // A key removed outside the app.
    CredentialStore::delete(store.as_ref(), ACCOUNT).unwrap();
    assert_eq!(
        settings::status_with(&keys, dir.path()).status,
        KeyState::Missing
    );
    assert!(settings::load(dir.path()).saved_keys.is_empty());
}

/// A keychain whose first read is overtaken by a key remove, as a remove from another window is.
struct RemovedMidRead {
    inner: FakeStore,
    dir: std::path::PathBuf,
    keys: std::sync::OnceLock<Keys>,
    removed: std::sync::atomic::AtomicBool,
}
impl CredentialStore for RemovedMidRead {
    fn get(&self, account: &str) -> Result<Option<Secret>, CredentialError> {
        let before = self.inner.get(account);
        if !self.removed.swap(true, Ordering::SeqCst) {
            let keys = self.keys.get().expect("the keys");
            settings::remove_with(keys, &self.dir, Provider::Klipy).unwrap();
        }
        before
    }
    fn set(&self, account: &str, value: &Secret) -> Result<(), CredentialError> {
        self.inner.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        CredentialStore::delete(&self.inner, account)
    }
}

#[test]
fn a_key_removed_during_a_read_is_not_marked_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(RemovedMidRead {
        inner: FakeStore::default(),
        dir: dir.path().to_path_buf(),
        keys: std::sync::OnceLock::new(),
        removed: std::sync::atomic::AtomicBool::new(false),
    });
    // A key saved before the marker existed, removed while this read is in flight.
    store.inner.set(ACCOUNT, &Secret::new(KLIPY_KEY)).unwrap();
    let keys = Keys::new(store.clone(), true, Some(ACCOUNT), Duration::from_secs(3));
    assert!(store.keys.set(keys.clone()).is_ok());
    let stale = settings::status_with(&keys, dir.path());
    assert_eq!(stale.status, KeyState::Saved);
    assert!(
        settings::load(dir.path()).saved_keys.is_empty(),
        "the remove stands"
    );
    assert_eq!(
        settings::status_with(&keys, dir.path()).status,
        KeyState::Missing
    );
}

#[tokio::test]
async fn search_page_result_names_provider() {
    let h = klipy_harness();
    let stills = Stills::default();
    h.transport.reply(200, None, KLIPY_SEARCH);
    let result = page(&h, &crate::media::Config::default(), &stills).await;
    assert_eq!(result["status"], "ok");
    assert_eq!(result["provider"], "klipy");
    let candidates = result["candidates"].as_array().unwrap();
    assert!(!candidates.is_empty());
    assert!(candidates.iter().all(|c| c["provider"] == "klipy"));
}

#[test]
fn gif_provider_reads_the_settings_alone_with_no_key_read_network_call_or_token() {
    let h = harness();
    let dir = h.dir.path();
    let on = crate::media::Config::default();
    let calls = h.store.calls.load(Ordering::SeqCst);
    let read = |config: &crate::media::Config| page::provider_page(dir, config);
    assert_eq!(
        read(&on),
        serde_json::json!({"status": "ok", "provider": "giphy"})
    );
    std::fs::write(dir.join(settings::FILE), r#"{"provider":"klipy"}"#).unwrap();
    assert_eq!(
        read(&on),
        serde_json::json!({"status": "ok", "provider": "klipy"})
    );
    // No gif.json reads as its default: On, with KLIPY.
    std::fs::remove_file(dir.join(settings::FILE)).unwrap();
    assert_eq!(read(&on)["provider"], "klipy");
    std::fs::write(
        dir.join(settings::FILE),
        r#"{"enabled":false,"provider":"giphy"}"#,
    )
    .unwrap();
    let off = read(&on);
    assert_eq!(off["status"], "error");
    assert_eq!(off["error"], "noProvider");
    assert_eq!(off["message"], GifError::NoProvider.message(None));
    // The team's remote media Off comes first, whatever the settings say.
    let media_off = crate::media::Config {
        remote: crate::media::Remote::Off,
        ..Default::default()
    };
    pin_giphy(dir);
    assert_eq!(read(&media_off)["error"], "mediaOff");
    for result in [read(&on), read(&media_off)] {
        assert!(!result.to_string().contains(KEY), "{result}");
    }
    assert_eq!(
        h.store.calls.load(Ordering::SeqCst),
        calls,
        "no keychain call"
    );
    assert_eq!(h.transport.requests(), 0, "no network call");
    assert!(!dir.join(bucket::FILE).exists(), "no bucket token");
}

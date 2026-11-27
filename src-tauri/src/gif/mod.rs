// SPDX-License-Identifier: MIT
//! GIF search for agents: one provider trait and its GIPHY and KLIPY adapters, the machine-local
//! keys, the search rate limit and the user's settings. A key never leaves the OS keychain except
//! in the provider request itself; no error, log line, file or tool result carries it.
pub(crate) mod analytics;
pub(crate) mod bucket;
pub(crate) mod giphy;
pub(crate) mod install;
pub(crate) mod klipy;
pub(crate) mod page;
pub(crate) mod register;
pub(crate) mod settings;
pub(crate) mod transport;

use crate::commands::credential_store::Secret;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, LazyLock, OnceLock},
};

/// A provider's GIF id: the one pattern `gif_search` lookups and later send checks share.
pub const ID_PATTERN: &str = r"^[A-Za-z0-9_-]{1,128}$";
/// The longest search query, in characters.
pub const MAX_QUERY_CHARS: usize = 100;
/// The most ids one lookup takes.
pub const MAX_IDS: usize = 10;
/// The most candidates one search returns, and the default.
pub const MAX_LIMIT: usize = 10;
pub const DEFAULT_LIMIT: usize = 6;
/// The longest candidate title, in characters.
pub const MAX_TITLE_CHARS: usize = 120;
/// The largest rendition a candidate may point at, and its longest side: the inbox fetch limits.
const MAX_RENDITION_BYTES: u64 = crate::media::MAX_BYTES as u64;
const MAX_SIDE: u32 = 4096;
/// A rendition at least this wide is wide enough: the smallest of those wins.
const WIDE_ENOUGH: u32 = 480;

/// Whether `id` matches [`ID_PATTERN`].
pub fn valid_id(id: &str) -> bool {
    static ID: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(ID_PATTERN).expect("valid id pattern"));
    ID.is_match(id)
}

/// The most a search may show: g, pg or pg-13. `r` has no variant, so nothing can ask for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Rating {
    #[serde(rename = "g")]
    G,
    #[default]
    #[serde(rename = "pg")]
    Pg,
    #[serde(rename = "pg-13")]
    Pg13,
}
impl Rating {
    /// `g`, `pg` or `pg-13`, in any case; anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "g" => Some(Self::G),
            "pg" => Some(Self::Pg),
            "pg-13" => Some(Self::Pg13),
            _ => None,
        }
    }
    /// The rating a search uses: the one asked for when it is known and within `ceiling`, else
    /// the ceiling.
    pub fn clamp(requested: Option<&str>, ceiling: Self) -> Self {
        match requested.and_then(Self::parse) {
            Some(rating) if rating <= ceiling => rating,
            _ => ceiling,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::G => "g",
            Self::Pg => "pg",
            Self::Pg13 => "pg-13",
        }
    }
}

/// A GIF provider, each with its own adapter, key and bucket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Giphy,
    Klipy,
}
impl Provider {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "giphy" => Some(Self::Giphy),
            "klipy" => Some(Self::Klipy),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Giphy => "giphy",
            Self::Klipy => "klipy",
        }
    }
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Giphy => "GIPHY",
            Self::Klipy => "KLIPY",
        }
    }
    /// The only hosts a candidate's URLs may name.
    pub fn hosts(self) -> &'static [&'static str] {
        match self {
            Self::Giphy => crate::media::GIPHY_HOSTS,
            Self::Klipy => crate::media::KLIPY_HOSTS,
        }
    }
    /// The Keychain service holding this provider's key; the account is the OS login name.
    pub fn key_service(self) -> &'static str {
        match self {
            Self::Giphy => "ai.codesense.giphy-api-key",
            Self::Klipy => "ai.codesense.klipy-api-key",
        }
    }
    /// The still rendition a candidate's `previewUrl` prefers.
    pub fn preferred_still(self) -> &'static str {
        match self {
            Self::Giphy => "fixed_width_still",
            Self::Klipy => "sm.jpg",
        }
    }
    /// Whether a lookup sends the rating, so the provider refuses ids above it. KLIPY's lookup
    /// takes no rating: its ids are cut to the ones a rated search returned.
    pub fn rates_lookup(self) -> bool {
        match self {
            Self::Giphy => true,
            Self::Klipy => false,
        }
    }
    /// Whether this provider takes `event`: GIPHY all three, KLIPY a send only.
    pub(crate) fn registers(self, event: register::Event) -> bool {
        match self {
            Self::Giphy => true,
            Self::Klipy => event == register::Event::Sent,
        }
    }
    /// Whether a registration counts against the search cap: KLIPY's test cap counts every
    /// call with the key, a share included; GIPHY's pings are outside it.
    pub(crate) fn registers_in_search_cap(self) -> bool {
        match self {
            Self::Giphy => false,
            Self::Klipy => true,
        }
    }
}

/// One GIF a search found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub provider: Provider,
    pub id: String,
    /// Provider text, cleaned by [`clean_title`].
    pub title: String,
    /// An animated rendition; `width` and `height` are its size.
    pub url: String,
    /// A still of the same GIF, or `url` when there is none.
    pub preview_url: String,
    pub width: u32,
    pub height: u32,
    /// The calling team's media config shows `url` inline without a tap.
    pub auto_loads: bool,
}

/// The longest pingback URL kept.
const MAX_PINGBACK_BYTES: usize = 2048;

/// A result's pingback URLs (GIPHY's `analytics`), each on the provider's hosts over https.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pingbacks {
    pub onload: Option<String>,
    pub onclick: Option<String>,
    pub onsent: Option<String>,
}
impl Pingbacks {
    /// Keep `url` only when it is on `provider`'s hosts over https and at most 2 KB.
    pub fn keep_url(provider: Provider, url: Option<&str>) -> Option<String> {
        url.filter(|u| u.len() <= MAX_PINGBACK_BYTES && on_provider_host(provider, u))
            .map(str::to_string)
    }
    /// `None` when no URL passed.
    pub fn if_any(self) -> Option<Self> {
        (self.onload.is_some() || self.onclick.is_some() || self.onsent.is_some()).then_some(self)
    }
}

/// A candidate with its pingbacks, which [`analytics::Analytics`] keeps.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub candidate: Candidate,
    pub pingbacks: Option<Pingbacks>,
}

/// Why `gif_search` returned no candidates. The text names no key and no request URL: it is
/// fixed per variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GifError {
    /// GIF search is off, or the provider has no key.
    NoProvider,
    /// The key could not be read: a locked or refused keychain, or a read that took too long (an
    /// access prompt waiting on the user).
    KeychainUnavailable,
    /// This computer has no secret store to keep a key in.
    NoSecretStore,
    /// The provider refused the key (401 or 403).
    InvalidKey,
    /// Searches are paused for `retry_after` seconds: the local cap or the provider's 429.
    RateLimited { retry_after: u64 },
    /// A 5xx, a timeout, a network failure or a body that is not the provider's JSON.
    ProviderUnavailable,
    /// The input was refused before any network call, or the provider refused the request.
    BadQuery(&'static str),
    /// The Inbox pane's search only: the team's remote media is off, so nothing is fetched.
    MediaOff,
}
impl GifError {
    /// The camelCase code a tool result carries.
    pub fn code(self) -> &'static str {
        match self {
            Self::NoProvider => "noProvider",
            Self::KeychainUnavailable | Self::NoSecretStore => "keychainUnavailable",
            Self::InvalidKey => "invalidKey",
            Self::RateLimited { .. } => "rateLimited",
            Self::ProviderUnavailable => "providerUnavailable",
            Self::BadQuery(_) => "badQuery",
            Self::MediaOff => "mediaOff",
        }
    }
    /// The tool result for this error, naming no provider.
    pub fn tool_result(self) -> serde_json::Value {
        Failed::from(self).tool_result()
    }

    /// The text for this error with `provider` active when it came; `None` when it came before
    /// the settings loaded (input checks), with search off or with no provider involved, and the
    /// text then says "GIF search".
    pub fn message(self, provider: Option<Provider>) -> String {
        let name = provider.map(Provider::display_name);
        let key = match name {
            Some(name) => format!("{name} key"),
            None => "GIF search key".to_string(),
        };
        match self {
            Self::NoProvider => match name {
                Some(name) => format!(
                    "GIF search has no {name} key. The user can add one in Settings → Messaging."
                ),
                None => "GIF search is off or has no key. The user can turn it on and add a key \
                         in Settings → Messaging."
                    .to_string(),
            },
            Self::KeychainUnavailable => format!(
                "The {key} could not be read from the OS keychain. The user can open Settings → \
                 Messaging, where the key is read while they are there to allow it."
            ),
            Self::NoSecretStore => format!(
                "GIF search can't run on this computer: it has no secret store to keep a {key} in."
            ),
            Self::InvalidKey => format!(
                "{} refused the key. The user can replace it in Settings → Messaging.",
                name.unwrap_or("The GIF search provider")
            ),
            Self::RateLimited { retry_after } => format!(
                "{} search is paused. Try again in {retry_after} seconds.",
                name.unwrap_or("GIF")
            ),
            Self::ProviderUnavailable => format!(
                "{} is unavailable right now. Try again later.",
                name.unwrap_or("GIF search")
            ),
            Self::BadQuery(reason) => match name {
                Some(name) if !reason.contains(name) => {
                    format!("Bad GIF search input: {reason} (the active provider is {name}).")
                }
                _ => format!("Bad GIF search input: {reason}."),
            },
            Self::MediaOff => {
                "Remote media is off for this team, so GIF search can't show anything.".to_string()
            }
        }
    }
}
impl std::fmt::Display for GifError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message(None))
    }
}
impl std::error::Error for GifError {}

/// A search error with the provider active when it came, which its text names; `None` before
/// the settings loaded or with search off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Failed {
    pub provider: Option<Provider>,
    pub error: GifError,
}
impl From<GifError> for Failed {
    fn from(error: GifError) -> Self {
        Self {
            provider: None,
            error,
        }
    }
}
impl Failed {
    /// The tool result: `{status:"error", error, message}`, plus `retryAfter` when rate limited.
    pub(crate) fn tool_result(self) -> serde_json::Value {
        let mut value = serde_json::json!({
            "status": "error",
            "error": self.error.code(),
            "message": self.error.message(self.provider),
        });
        if let GifError::RateLimited { retry_after } = self.error {
            value["retryAfter"] = retry_after.into();
        }
        value
    }
}

/// A checked `gif_search` input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Search { query: String, limit: usize },
    Lookup { ids: Vec<String> },
}

/// Check a `gif_search` input before anything else runs: exactly one of `query` and `ids`; a
/// query of 1 to 100 characters with no control characters; 1 to 10 ids that each match
/// [`ID_PATTERN`]; `limit` clamped to 1 to 10, 6 when absent.
pub fn normalize(
    query: Option<&str>,
    ids: Option<&[String]>,
    limit: Option<i64>,
) -> Result<Request, GifError> {
    match (query, ids) {
        (Some(_), Some(_)) => Err(GifError::BadQuery("pass query or ids, not both")),
        (None, None) => Err(GifError::BadQuery("pass query or ids")),
        (Some(query), None) => {
            if query.chars().any(char::is_control) {
                return Err(GifError::BadQuery("query has control characters"));
            }
            let query = query.trim();
            match query.chars().count() {
                0 => return Err(GifError::BadQuery("query is blank")),
                n if n > MAX_QUERY_CHARS => {
                    return Err(GifError::BadQuery("query is longer than 100 characters"))
                }
                _ => {}
            }
            let limit = limit.map_or(DEFAULT_LIMIT as i64, |l| l.clamp(1, MAX_LIMIT as i64));
            Ok(Request::Search {
                query: query.to_string(),
                limit: limit as usize,
            })
        }
        (None, Some(ids)) => {
            if !(1..=MAX_IDS).contains(&ids.len()) {
                return Err(GifError::BadQuery("ids holds 1 to 10 entries"));
            }
            if ids.iter().any(|id| !valid_id(id)) {
                return Err(GifError::BadQuery("an id is not a provider GIF id"));
            }
            Ok(Request::Lookup { ids: ids.to_vec() })
        }
    }
}

/// Provider text made safe to show and to use as alt text: control and format characters (bidi,
/// zero-width, tags, variation selectors) dropped, whitespace runs collapsed, at most 120
/// characters.
pub fn clean_title(raw: &str) -> String {
    let visible: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|&c| !c.is_control() && !is_format_char(c))
        .collect();
    let words = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    words
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Every format character (general category Cf: soft hyphen, bidi marks, embeddings, overrides
/// and isolates, zero-width marks, the BOM, interlinear annotations, tags), plus the invisible
/// combining grapheme joiner and the variation selectors.
fn is_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E007F}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

/// The rate-limit bucket of a provider and key fingerprint, which searches and pingbacks share.
pub(crate) fn bucket_key(provider: Provider, fingerprint: &str) -> String {
    format!("{}:{fingerprint}", Provider::as_str(provider))
}

/// The first 16 hex digits of the key's SHA-256: what the bucket and the production flag are
/// keyed by, so neither file holds the key.
pub fn fingerprint(key: &Secret) -> String {
    let digest = Sha256::digest(key.expose().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// What a rendition holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Gif,
    Webp,
    Png,
    Jpeg,
    /// mp4, webm or anything else that is not an image.
    Other,
}
impl Format {
    /// From the URL's path extension.
    pub fn of_url(url: &str) -> Self {
        let file = match url.parse::<url::Url>() {
            Ok(u) => u
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_ascii_lowercase),
            Err(_) => None,
        };
        match file
            .as_deref()
            .and_then(|f| f.rsplit_once('.'))
            .map(|(_, ext)| ext)
        {
            Some("gif") => Self::Gif,
            Some("webp") => Self::Webp,
            Some("png") => Self::Png,
            Some("jpg" | "jpeg") => Self::Jpeg,
            _ => Self::Other,
        }
    }
}

/// One rendition of a GIF, as the adapter read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendition {
    /// The provider's name for it, such as GIPHY's `fixed_width_still`.
    pub name: String,
    pub url: String,
    pub format: Format,
    /// A still image (GIPHY `*_still`), never animated.
    pub still: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bytes: Option<u64>,
}
impl Rendition {
    /// Its size and byte count are known and within the inbox fetch limits.
    fn within_limits(&self) -> Option<(u32, u32, u64)> {
        let (width, height, bytes) = (self.width?, self.height?, self.bytes?);
        (width > 0
            && height > 0
            && width <= MAX_SIDE
            && height <= MAX_SIDE
            && bytes <= MAX_RENDITION_BYTES)
            .then_some((width, height, bytes))
    }
}

/// The rendition a candidate's `url` names: animated GIF or WebP within the limits and not a
/// GIPHY `preview*` cut (a few frames), the fewest bytes among those at least 480 px wide, else
/// the widest.
pub fn pick_animated(renditions: &[Rendition]) -> Option<&Rendition> {
    let animated: Vec<_> = renditions
        .iter()
        .filter(|r| !r.still && !r.name.starts_with("preview"))
        .filter(|r| matches!(r.format, Format::Gif | Format::Webp))
        .filter_map(|r| r.within_limits().map(|size| (r, size)))
        .collect();
    animated
        .iter()
        .filter(|(_, (width, _, _))| *width >= WIDE_ENOUGH)
        .min_by_key(|(_, (_, _, bytes))| *bytes)
        .or_else(|| {
            animated
                .iter()
                .max_by(|a, b| a.1 .0.cmp(&b.1 .0).then(b.1 .2.cmp(&a.1 .2)))
        })
        .map(|(r, _)| *r)
}

/// The still a candidate's `previewUrl` names: an image within the limits, the provider's
/// [`Provider::preferred_still`] first, then the smallest other still.
pub fn pick_preview(provider: Provider, renditions: &[Rendition]) -> Option<&Rendition> {
    let preferred = Provider::preferred_still(provider);
    renditions
        .iter()
        .filter(|r| r.still && r.format != Format::Other)
        .filter_map(|r| r.within_limits().map(|(_, _, bytes)| (r, bytes)))
        .min_by_key(|(r, bytes)| (r.name != preferred, *bytes))
        .map(|(r, _)| r)
}

/// KLIPY's API host. It is on KLIPY's host list but serves no media, and its URLs hold the key.
const KLIPY_API_HOST: &str = "api.klipy.com";

/// Whether `url` is https on one of `provider`'s media hosts, with no credentials in it.
pub fn on_provider_host(provider: Provider, url: &str) -> bool {
    crate::media::on_hosts(Provider::hosts(provider), url)
        && !(provider == Provider::Klipy && crate::media::on_hosts(&[KLIPY_API_HOST], url))
}

/// A candidate from one provider result, or `None` when it has no qualifying animated rendition
/// or a URL off the provider's hosts.
pub fn candidate(
    provider: Provider,
    id: &str,
    title: &str,
    renditions: &[Rendition],
) -> Option<Candidate> {
    if !valid_id(id) {
        return None;
    }
    let animated = pick_animated(renditions)?;
    let preview = pick_preview(provider, renditions).map_or(&animated.url, |r| &r.url);
    if !on_provider_host(provider, &animated.url) || !on_provider_host(provider, preview) {
        return None;
    }
    Some(Candidate {
        provider,
        id: id.to_string(),
        title: clean_title(title),
        url: animated.url.clone(),
        preview_url: preview.clone(),
        width: animated.width?,
        height: animated.height?,
        auto_loads: false,
    })
}

/// Mark each candidate the calling team's media config shows inline: `remote: auto` and its
/// `url` host allowed.
pub fn set_auto_loads(candidates: &mut [Candidate], config: &crate::media::Config) {
    for candidate in candidates {
        candidate.auto_loads = match candidate.url.parse::<url::Url>() {
            Ok(url) => url
                .host_str()
                .is_some_and(|host| config.should_auto_fetch(host, true)),
            Err(_) => false,
        };
    }
}

/// A search as its caller sent it, before [`normalize`]: the `gif_search` tool's and the Inbox
/// pane's `gifSearch` verb's shared input.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SearchArgs<'a> {
    pub query: Option<&'a str>,
    pub ids: Option<&'a [String]>,
    pub limit: Option<i64>,
    pub rating: Option<&'a str>,
    pub provider: Option<&'a str>,
}

/// Check `args` and run them on `service`, marking what the team `config` shows inline (none:
/// nothing auto-loads). Every error but the provider's returns before any network call.
pub(crate) async fn search(
    service: &GifService,
    config: Option<&crate::media::Config>,
    args: SearchArgs<'_>,
) -> Result<(Provider, Vec<Candidate>), Failed> {
    let request = normalize(args.query, args.ids, args.limit)?;
    let requested = match args.provider {
        None => None,
        Some(name) => Some(Provider::parse(name).ok_or(GifError::BadQuery("unknown provider"))?),
    };
    let (provider, mut candidates) = service.run_in(&request, requested, args.rating).await?;
    let off = crate::media::Config {
        remote: crate::media::Remote::Off,
        ..Default::default()
    };
    set_auto_loads(&mut candidates, config.unwrap_or(&off));
    Ok((provider, candidates))
}

/// A GIF provider adapter, holding its key.
pub(crate) trait GifProvider: Send + Sync {
    /// Up to `limit` GIFs for `query` at `rating`, in the provider's order.
    fn search_gifs<'a>(
        &'a self,
        query: &'a str,
        rating: Rating,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>>;
    /// The GIFs with these ids that are within `rating`, in the order asked.
    fn lookup_gifs<'a>(
        &'a self,
        ids: &'a [String],
        rating: Rating,
    ) -> BoxFuture<'a, Result<Vec<Found>, GifError>>;
}

/// Milliseconds since the Unix epoch.
pub(crate) type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Makes the adapter for a provider's key and, for KLIPY, the install's `customer_id`; tests
/// stand in a recorded transport.
pub(crate) type Adapters =
    Arc<dyn Fn(Provider, Secret, Option<String>, i64) -> Box<dyn GifProvider> + Send + Sync>;

/// Everything `gif_search` needs: the settings and bucket files, the key, the adapter and the
/// analytics map. One per app, so every search shares the bucket's lock and the key's single read.
pub(crate) struct GifService {
    data_dir: PathBuf,
    pub(crate) keys: settings::Keys,
    pub(crate) bucket: Arc<bucket::Bucket>,
    pub(crate) analytics: analytics::Analytics,
    adapters: Adapters,
    clock: Clock,
}

impl GifService {
    pub(crate) fn new(
        data_dir: PathBuf,
        keys: settings::Keys,
        adapters: Adapters,
        clock: Clock,
    ) -> Self {
        Self {
            bucket: Arc::new(bucket::Bucket::new(data_dir.join(bucket::FILE))),
            data_dir,
            keys,
            analytics: analytics::Analytics::new(),
            adapters,
            clock,
        }
    }

    /// The settings and key folder.
    pub(crate) fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// [`Self::run_in`] without the provider its error came under.
    pub(crate) async fn run(
        &self,
        request: &Request,
        requested: Option<Provider>,
        rating: Option<&str>,
    ) -> Result<(Provider, Vec<Candidate>), GifError> {
        self.run_in(request, requested, rating)
            .await
            .map_err(|failed| failed.error)
    }

    /// Run a checked request: settings, key, bucket, then the provider. Every error but the
    /// provider's returns before any network call, and every error after the settings load names
    /// the active provider. `requested` is the provider the caller named, which must be the
    /// active one. Returns the provider that ran and its candidates, with `auto_loads` unset.
    pub(crate) async fn run_in(
        &self,
        request: &Request,
        requested: Option<Provider>,
        rating: Option<&str>,
    ) -> Result<(Provider, Vec<Candidate>), Failed> {
        // The provider isn't known until the settings are read: both epochs are read first.
        let epochs = install::install_epochs(&self.data_dir);
        let dir = self.data_dir.clone();
        let current = tokio::task::spawn_blocking(move || settings::load(&dir))
            .await
            .map_err(|_| GifError::ProviderUnavailable)?;
        if !current.enabled {
            return Err(GifError::NoProvider.into());
        }
        let provider = current.provider;
        let epoch = install::Epochs::of(epochs, provider);
        let named = |error: GifError| Failed {
            provider: Some(provider),
            error,
        };
        if requested.is_some_and(|p| p != provider) {
            return Err(named(GifError::BadQuery(
                "provider is not the active GIF provider",
            )));
        }
        let key = settings::Keys::read_timed(&self.keys, provider)
            .await
            .map_err(named)?;
        let fingerprint = fingerprint(&key);
        let production = current.is_production(provider, &fingerprint);
        let bucket_key = self::bucket_key(provider, &fingerprint);
        let rating = Rating::clamp(rating, current.ceiling);
        // A lookup that takes no rating asks only for GIFs a search within the hour returned at
        // or under `rating`. With none, nothing is asked and no token is taken.
        let cut;
        let request = match request {
            Request::Lookup { ids } if !Provider::rates_lookup(provider) => {
                let now = (self.clock)();
                analytics::Analytics::start_epoch(&self.analytics, provider, epoch);
                let held: Vec<String> = ids
                    .iter()
                    .filter(|id| {
                        analytics::Analytics::held_entry(&self.analytics, provider, id, now)
                            .is_some_and(|entry| entry.rating <= rating)
                    })
                    .cloned()
                    .collect();
                if held.is_empty() {
                    log::info!(target: "gif", "gif search: no {} search in the last hour returned these ids", provider.display_name());
                    return Ok((provider, Vec::new()));
                }
                cut = Request::Lookup { ids: held };
                &cut
            }
            request => request,
        };
        // KLIPY's searches carry the install's customer_id, read or made before any request; one
        // that can't be saved fails the search, so a share never sends an id the search didn't.
        let customer_id = match provider {
            Provider::Giphy => None,
            Provider::Klipy => {
                let (dir, fp) = (self.data_dir.clone(), fingerprint.clone());
                let made =
                    tokio::task::spawn_blocking(move || install::customer_id(&dir, &fp, epoch))
                        .await;
                match made {
                    Ok(Ok(id)) => Some(id),
                    Ok(Err(e)) => {
                        log::warn!(target: "gif", "gif search: KLIPY's customer id could not be saved: {e}");
                        return Err(named(GifError::ProviderUnavailable));
                    }
                    Err(e) => {
                        log::warn!(target: "gif", "gif search: KLIPY's customer id read stopped: {e}");
                        return Err(named(GifError::ProviderUnavailable));
                    }
                }
            }
        };
        let (bucket, counted, now) = (self.bucket.clone(), bucket_key.clone(), (self.clock)());
        tokio::task::spawn_blocking(move || bucket.take(&counted, production, now))
            .await
            .map_err(|_| named(GifError::ProviderUnavailable))?
            .map_err(named)?;
        let adapter = (self.adapters)(provider, key, customer_id, (self.clock)());
        let result = match request {
            Request::Search { query, limit } => {
                GifProvider::search_gifs(adapter.as_ref(), query, rating, *limit).await
            }
            Request::Lookup { ids } => {
                GifProvider::lookup_gifs(adapter.as_ref(), ids, rating).await
            }
        };
        match result {
            Ok(found) => {
                // Held only when search stayed On with the same key the whole time, so a new
                // install id never registers a GIF found under the old one. A lookup that took no
                // rating is never held, so only a rated search can start or extend a hold.
                let query = match request {
                    Request::Search { query, .. } => Some(query.as_str()),
                    Request::Lookup { .. } => None,
                };
                let holds = query.is_some() || Provider::rates_lookup(provider);
                if holds && install::install_epoch(&self.data_dir, provider) == epoch {
                    analytics::Analytics::start_epoch(&self.analytics, provider, epoch);
                    let now = (self.clock)();
                    self.analytics.record(provider, &found, rating, query, now);
                }
                Ok((provider, found.into_iter().map(|f| f.candidate).collect()))
            }
            Err(GifError::RateLimited { retry_after }) => {
                let (bucket, now) = (self.bucket.clone(), (self.clock)());
                let blocked = tokio::task::spawn_blocking(move || {
                    bucket.back_off(&bucket_key, retry_after, now)
                })
                .await;
                Err(named(GifError::RateLimited {
                    retry_after: blocked.unwrap_or(retry_after.max(1)),
                }))
            }
            Err(error) => Err(named(error)),
        }
    }
}

/// The app's GIF service, made on first use.
pub(crate) fn service<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Arc<GifService>, String> {
    static SERVICE: OnceLock<Arc<GifService>> = OnceLock::new();
    if let Some(service) = SERVICE.get() {
        return Ok(service.clone());
    }
    let dir = settings::data_dir(app)?;
    let transport: Arc<dyn transport::Transport> = Arc::new(transport::Http::new()?);
    let adapters: Adapters = Arc::new(
        move |provider: Provider,
              key: Secret,
              customer_id: Option<String>,
              now: i64|
              -> Box<dyn GifProvider> {
            match provider {
                Provider::Giphy => Box::new(giphy::Giphy::new(key, transport.clone(), now)),
                Provider::Klipy => {
                    Box::new(klipy::Klipy::new(key, customer_id, transport.clone(), now))
                }
            }
        },
    );
    let clock: Clock = Arc::new(crate::weft::inbox::now_ms);
    Ok(SERVICE
        .get_or_init(|| {
            Arc::new(GifService::new(
                dir,
                settings::Keys::system(),
                adapters,
                clock,
            ))
        })
        .clone())
}

#[cfg(test)]
mod tests;

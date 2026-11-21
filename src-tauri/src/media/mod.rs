// SPDX-License-Identifier: MIT
//! Host-fetched inbox images. Frames only see verified, content-addressed bytes.
//! Provider media (GIPHY, KLIPY) is held in memory only, never on disk, as their terms
//! require; everything else keeps the content-addressed disk cache.
pub(crate) mod index;
pub(crate) mod memory;
pub(crate) mod purge;
mod state;
pub(crate) use state::MediaState;
#[cfg(test)]
pub(crate) use state::{FakeFetch, Fetch};

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const CACHE_BYTES: u64 = 256 * 1024 * 1024;
/// Held while the disk cache is written or a memory-only sha's file is deleted, so a
/// store never writes back a sha the index has just made memory-only.
static DISK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// GIPHY's hosts, fixed: not Settings, the selected provider, a key or `inbox.yml`.
pub const GIPHY_HOSTS: &[&str] = &["giphy.com", "*.giphy.com"];
/// KLIPY's hosts, fixed like [`GIPHY_HOSTS`].
pub const KLIPY_HOSTS: &[&str] = &["klipy.com", "*.klipy.com"];
/// Every provider host: [`GIPHY_HOSTS`] and [`KLIPY_HOSTS`].
pub const PROVIDER_HOSTS: &[&str] = &["giphy.com", "*.giphy.com", "klipy.com", "*.klipy.com"];

/// Whether `host` matches `pattern`: exactly, or `*.suffix` for any subdomain of it.
pub(crate) fn host_matches(pattern: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let pattern = pattern.to_ascii_lowercase();
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host.strip_suffix(suffix)
            .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1)
    } else {
        host == pattern
    }
}

/// Provider media: `media_provider` says so or, only when it is missing (an old
/// message), `source_host` is a provider host.
pub(crate) fn is_provider(
    media_provider: Option<MediaProvider>,
    source_host: Option<&str>,
) -> bool {
    match media_provider {
        Some(provider) => provider.is_provider(),
        None => source_host.is_some_and(|h| MediaProvider::of_host(h).is_provider()),
    }
}

/// Whose terms govern an image's bytes, from the host they finally came from.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MediaProvider {
    Giphy,
    Klipy,
    None,
}
impl MediaProvider {
    pub fn of_host(host: &str) -> Self {
        if GIPHY_HOSTS.iter().any(|p| host_matches(p, host)) {
            Self::Giphy
        } else if KLIPY_HOSTS.iter().any(|p| host_matches(p, host)) {
            Self::Klipy
        } else {
            Self::None
        }
    }
    pub fn is_provider(self) -> bool {
        self != Self::None
    }
    /// The hosts this provider's media comes from: [`GIPHY_HOSTS`], [`KLIPY_HOSTS`], or none.
    pub fn host_list(self) -> &'static [&'static str] {
        match self {
            Self::Giphy => GIPHY_HOSTS,
            Self::Klipy => KLIPY_HOSTS,
            Self::None => &[],
        }
    }
}

/// Whether `url` is https on one of `hosts`, with no credentials in it.
pub(crate) fn on_hosts(hosts: &[&str], url: &str) -> bool {
    let Ok(url) = url.parse::<url::Url>() else {
        return false;
    };
    url.scheme() == "https"
        && url.username() == ""
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| hosts.iter().any(|pattern| host_matches(pattern, host)))
}

/// Why a send's provider claim (`provider` with `providerId`) was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimError {
    /// Only one of `provider` and `providerId` was given.
    Unpaired,
    /// `provider` is `none`.
    NotAProvider,
    /// `providerId` is not a provider GIF id.
    BadId,
    /// The URL is not https on that provider's hosts.
    WrongHost,
    /// `provider` came with `path`: a local file has no provider.
    LocalFile,
}
impl std::fmt::Display for ClaimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unpaired => "media.provider and media.providerId go together",
            Self::NotAProvider => "media.provider is giphy or klipy",
            Self::BadId => "media.providerId is not a provider GIF id",
            Self::WrongHost => "media.url is not on that provider's hosts",
            Self::LocalFile => "media.provider is for a url, not a path",
        })
    }
}
impl std::error::Error for ClaimError {}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MediaInput {
    pub url: Option<String>,
    pub path: Option<String>,
    pub alt: String,
    /// The GIF provider `url` came from, `giphy` or `klipy`, as `gif_search` named it.
    /// Set with `providerId` or not at all; it registers the send with the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<MediaProvider>,
    /// The provider's id for the GIF, as `gif_search` returned it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}
impl MediaInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.alt.trim().is_empty() {
            return Err("media.alt is required".into());
        }
        match (&self.url, &self.path) {
            (Some(url), None) => {
                remote_url(url).map_err(|e| e.reason.to_string())?;
            }
            (None, Some(path)) if !path.trim().is_empty() => {}
            _ => return Err("media requires exactly one of url or path".into()),
        }
        Self::provider_claim(self).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The checked provider claim, `None` when there is none: both fields, a provider that
    /// is one, an id of the shared GIF id pattern, and a URL on that provider's own hosts.
    pub fn provider_claim(&self) -> Result<Option<(MediaProvider, &str)>, ClaimError> {
        let (provider, id) = match (self.provider, self.provider_id.as_deref()) {
            (None, None) => return Ok(None),
            (Some(provider), Some(id)) => (provider, id),
            _ => return Err(ClaimError::Unpaired),
        };
        if self.path.is_some() {
            return Err(ClaimError::LocalFile);
        }
        if !MediaProvider::is_provider(provider) {
            return Err(ClaimError::NotAProvider);
        }
        if !crate::gif::valid_id(id) {
            return Err(ClaimError::BadId);
        }
        let url = self.url.as_deref().unwrap_or("");
        if !on_hosts(MediaProvider::host_list(provider), url) {
            return Err(ClaimError::WrongHost);
        }
        Ok(Some((provider, id)))
    }
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Remote {
    #[default]
    Auto,
    Ask,
    Off,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct Config {
    pub remote: Remote,
    pub hosts: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            remote: Remote::Auto,
            hosts: vec!["*.giphy.com".into(), "*.klipy.com".into()],
        }
    }
}
impl Config {
    pub fn load(config_dir: &Path) -> Self {
        #[derive(Deserialize, Default)]
        struct File {
            #[serde(default)]
            media: Config,
        }
        match std::fs::read(config_dir.join("inbox.yml")) {
            Ok(bytes) => serde_yaml::from_slice::<File>(&bytes)
                .map(|f| f.media)
                .unwrap_or_else(|_| Self {
                    remote: Remote::Off,
                    ..Self::default()
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(_) => Self {
                remote: Remote::Off,
                ..Self::default()
            },
        }
    }
    pub fn allows(&self, host: &str) -> bool {
        self.hosts.iter().any(|pattern| host_matches(pattern, host))
    }
    pub(crate) fn should_auto_fetch(&self, host: &str, own: bool) -> bool {
        self.remote == Remote::Auto && own && self.allows(host)
    }
    pub fn apply(&self, attachments: &mut [Attachment]) {
        for a in attachments {
            if a.source_url.is_some() && self.remote == Remote::Off {
                a.state = "blocked".into();
            } else if a.state == "blocked" {
                a.state = "pending".into();
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub alt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_host: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub retryable: bool,
    /// The provider whose host the bytes finally came from (after redirects), written
    /// on every fetch; `none` for other media. Missing only on an old message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_provider: Option<MediaProvider>,
    /// The sender was a session on this machine when it sent: an automatic re-fetch
    /// may use this attachment's URL. Missing reads as false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub own_sender: bool,
    /// The provider the sender said the GIF came from, with its id: what registers the
    /// send and the first view with the provider. Dropped when a fetch ends on another
    /// host than that provider's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<MediaProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// The provider's view ping for this attachment was sent, or never will be: set on
    /// its first view on the sending machine. Missing reads as false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub onload_sent: bool,
}
impl Attachment {
    pub fn remote(url: &str, alt: &str, config: &Config, own: bool) -> Result<Self, Failure> {
        let url = remote_url(url)?;
        let host = url.host_str().unwrap().to_string();
        let mut a = Self::empty(alt);
        a.state = if config.remote == Remote::Off {
            "blocked"
        } else {
            "pending"
        }
        .into();
        a.reason = Some(
            if !own {
                "sender"
            } else if config.remote == Remote::Ask {
                "ask"
            } else {
                "host"
            }
            .into(),
        );
        a.source_host = Some(host);
        a.source_url = Some(url.to_string());
        a.own_sender = own;
        Ok(a)
    }
    fn empty(alt: &str) -> Self {
        Self {
            kind: "image".into(),
            sha256: None,
            mime: None,
            width: None,
            height: None,
            bytes: None,
            alt: crate::shared::secret_scan::redact_secrets(alt),
            source_url: None,
            source_host: None,
            state: "pending".into(),
            reason: None,
            retryable: false,
            media_provider: None,
            own_sender: false,
            provider: None,
            provider_id: None,
            onload_sent: false,
        }
    }
    /// `self` with `input`'s provider claim, once [`MediaInput::validate`] has passed it.
    pub fn claimed(mut self, input: &MediaInput) -> Self {
        if let Ok(Some((provider, id))) = MediaInput::provider_claim(input) {
            self.provider = Some(provider);
            self.provider_id = Some(id.to_string());
        }
        self
    }
    /// Whose attribution the image shows, in every state: the sender's provider claim, else
    /// the provider whose host the bytes came from (which covers redirects), else (an old
    /// message, or one never fetched) the provider whose host the URL names. `None` for
    /// other media.
    pub fn attribution(&self) -> Option<MediaProvider> {
        let provider = match (self.provider, self.media_provider) {
            (Some(provider), _) | (None, Some(provider)) => provider,
            (None, None) => MediaProvider::of_host(self.source_host.as_deref().unwrap_or("")),
        };
        MediaProvider::is_provider(provider).then_some(provider)
    }
    /// Provider media (see [`is_provider`]).
    pub fn is_provider_media(&self) -> bool {
        is_provider(self.media_provider, self.source_host.as_deref())
    }
    /// The verified image `sha` is this attachment's, cached.
    fn set_cached(&mut self, sha: String, mime: &str, width: u32, height: u32, bytes: u64) {
        self.sha256 = Some(sha);
        self.mime = Some(mime.into());
        self.width = Some(width);
        self.height = Some(height);
        self.bytes = Some(bytes);
        self.state = "cached".into();
        self.reason = None;
        self.retryable = false;
    }
    fn failed(mut self, error: Failure) -> Self {
        self.state = "failed".into();
        self.reason = Some(error.reason.into());
        self.retryable = error.retryable;
        self
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Failure {
    pub reason: &'static str,
    pub retryable: bool,
}
fn failure(reason: &'static str) -> Failure {
    Failure {
        reason,
        retryable: false,
    }
}
fn network(_: impl std::fmt::Display) -> Failure {
    Failure {
        reason: "network",
        retryable: true,
    }
}
fn remote_url(url: &str) -> Result<url::Url, Failure> {
    let url = url::Url::parse(url).map_err(|_| failure("https"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure("https"));
    }
    Ok(url)
}

pub fn inspect(data: &[u8]) -> Result<(&'static str, u32, u32), Failure> {
    if data.len() > MAX_BYTES {
        return Err(failure("size"));
    }
    let le16 = |at| u16::from_le_bytes([data[at], data[at + 1]]) as u32;
    let le24 = |at| u32::from_le_bytes([data[at], data[at + 1], data[at + 2], 0]);
    let be32 = |at| u32::from_be_bytes(data[at..at + 4].try_into().unwrap());
    let (mime, w, h) = if data.len() >= 10
        && (data.starts_with(b"GIF89a") || data.starts_with(b"GIF87a"))
    {
        ("image/gif", le16(6), le16(8))
    } else if data.len() >= 24 && data.starts_with(b"\x89PNG\r\n\x1a\n") && &data[12..16] == b"IHDR"
    {
        ("image/png", be32(16), be32(20))
    } else if data.len() >= 30 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        let (w, h) = match &data[12..16] {
            b"VP8X" => (le24(24) + 1, le24(27) + 1),
            b"VP8 " if &data[23..26] == b"\x9d\x01\x2a" => (le16(26) & 0x3fff, le16(28) & 0x3fff),
            b"VP8L" if data[20] == 0x2f => {
                let bits = u32::from_le_bytes(data[21..25].try_into().unwrap());
                ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
            }
            _ => return Err(failure("type")),
        };
        ("image/webp", w, h)
    } else if data.starts_with(b"\xff\xd8\xff") {
        let mut at = 2;
        let mut dimensions = None;
        while at + 4 <= data.len() {
            if data[at] != 0xff {
                break;
            }
            let marker = data[at + 1];
            if marker == 0xff {
                at += 1;
                continue;
            }
            let len = u16::from_be_bytes([data[at + 2], data[at + 3]]) as usize;
            if len < 2 || at + 2 + len > data.len() {
                break;
            }
            if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && len >= 7 {
                dimensions = Some((
                    u16::from_be_bytes([data[at + 7], data[at + 8]]) as u32,
                    u16::from_be_bytes([data[at + 5], data[at + 6]]) as u32,
                ));
                break;
            }
            at += len + 2;
        }
        let (w, h) = dimensions.ok_or_else(|| failure("type"))?;
        ("image/jpeg", w, h)
    } else {
        return Err(failure("type"));
    };
    if w == 0 || h == 0 {
        return Err(failure("type"));
    }
    if w > 4096 || h > 4096 || u64::from(w) * u64::from(h) > 16 * 1024 * 1024 {
        return Err(failure("pixels"));
    }
    Ok((mime, w, h))
}

fn redirect_policy(config: &Config) -> reqwest::redirect::Policy {
    let hosts = config.clone();
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > 3 {
            attempt.error("redirect limit")
        } else if !public_url(attempt.url())
            || attempt.url().scheme() != "https"
            || !attempt.url().host_str().is_some_and(|h| hosts.allows(h))
        {
            attempt.error("redirect host")
        } else {
            attempt.follow()
        }
    })
}
/// The hardened base of every client that reaches a provider or a remote image: rustls, no
/// referrer, no proxy, public addresses only and a `timeout`. Callers add their own user agent,
/// redirect policy and `https_only`.
pub(crate) fn hardened_client_builder(timeout: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .use_rustls_tls()
        .referer(false)
        .no_proxy()
        .dns_resolver(std::sync::Arc::new(PublicDns))
        .timeout(timeout)
}
fn client_builder(config: &Config) -> reqwest::ClientBuilder {
    hardened_client_builder(Duration::from_secs(10))
        .user_agent("ImageFetcher/1.0")
        .redirect(redirect_policy(config))
}
/// A fetched body, the URL it finally came from after redirects, and its
/// `Cache-Control`.
#[derive(Debug)]
pub(crate) struct Downloaded {
    pub bytes: Vec<u8>,
    pub final_url: url::Url,
    pub cache_control: Option<String>,
}
async fn download(url: &str, config: &Config) -> Result<Downloaded, Failure> {
    let url = remote_url(url)?;
    if !public_url(&url) {
        return Err(failure("address"));
    }
    let client = client_builder(config)
        .https_only(true)
        .build()
        .map_err(network)?;
    send(&client, url).await
}
async fn send(client: &reqwest::Client, url: url::Url) -> Result<Downloaded, Failure> {
    let response = client.get(url).send().await.map_err(|e| {
        let mut cause: Option<&dyn std::error::Error> = Some(&e);
        while let Some(error) = cause {
            if error.to_string().contains("media-private-address") {
                return failure("address");
            }
            cause = error.source();
        }
        if e.is_redirect() {
            failure("redirect")
        } else {
            network(e)
        }
    })?;
    read_response(response).await
}
async fn read_response(mut response: reqwest::Response) -> Result<Downloaded, Failure> {
    let final_url = response.url().clone();
    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if !response.status().is_success() {
        return Err(Failure {
            reason: "http",
            retryable: response.status().is_server_error() || response.status().as_u16() == 429,
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(failure("size"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(failure("size"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Downloaded {
        bytes,
        final_url,
        cache_control,
    })
}
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("inbox-media"))
}
/// Whether `sha` names a cache file: 64 lowercase hex digits.
pub(crate) fn valid_sha(sha: &str) -> bool {
    sha.len() == 64
        && sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
/// The cached image `sha` among a message's `attachments`, if it has one: the only
/// image the inbox serves for that message (the `/media/v1` route and the app
/// window's `read_inbox_media` both ask this).
pub(crate) fn cached_attachment<'a>(
    attachments: &'a [Attachment],
    sha: &str,
) -> Option<&'a Attachment> {
    attachments
        .iter()
        .find(|a| a.state == "cached" && a.sha256.as_deref() == Some(sha))
}
pub fn read_cached(dir: &Path, sha: &str) -> Result<Vec<u8>, String> {
    if !valid_sha(sha) {
        return Err("invalid media hash".into());
    }
    // Only a regular file within the fetch cap: the cache is app-owned, but the read
    // stays bounded whatever sits under the hash name. One handle is checked, read and
    // touched, so the file can't be swapped between the check and the read.
    let file = crate::agents::content_reader::open_no_follow(&dir.join(sha))
        .map_err(|_| "media unavailable".to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err("media unavailable".into());
    }
    let bytes = read_limited(&file)?;
    if bytes.len() > MAX_BYTES {
        return Err("media unavailable".into());
    }
    let _ = file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()));
    Ok(bytes)
}
/// Write verified `bytes` as `dir/<sha>`, evicting the oldest files over the cap.
/// The caller holds [`DISK`].
fn write_file(dir: &Path, sha: &str, bytes: &[u8]) -> Result<(), Failure> {
    std::fs::create_dir_all(dir).map_err(network)?;
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(network)?
        .flatten()
        .filter_map(|e| {
            let meta = Result::ok(std::fs::DirEntry::metadata(&e))?;
            meta.is_file().then(|| {
                (
                    std::fs::DirEntry::path(&e),
                    meta.len(),
                    Result::ok(meta.modified()),
                )
            })
        })
        .collect();
    let mut total: u64 = entries.iter().map(|(_, len, _)| len).sum();
    entries.sort_by_key(|(_, _, time)| *time);
    for (path, len, _) in entries {
        if total + bytes.len() as u64 <= CACHE_BYTES {
            break;
        }
        std::fs::remove_file(path).map_err(network)?;
        total -= len;
    }
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(network)?;
    std::io::Write::write_all(&mut temp, bytes).map_err(network)?;
    tempfile::NamedTempFile::persist(temp, dir.join(sha)).map_err(network)?;
    Ok(())
}

pub(crate) async fn config(
    app: &tauri::AppHandle,
    team: &crate::commands::dashboard_launch::LaunchTeam,
) -> Result<Config, String> {
    let ctx =
        crate::commands::route_to_context::derive_context_for(app, &team.org, &team.team).await?;
    let crate::commands::route_to_context::ContextResolution::Ok(ctx) = ctx else {
        return Err("media team unavailable".into());
    };
    let root =
        crate::context_repo::path_to_org_root(&ctx.codesense_home, &ctx.principal(), &team.org)?;
    let dir = crate::context_repo::path_to_team_config_dir(&root, &team.team);
    crate::commands::await_blocking("media.config", move || Ok(Config::load(&dir))).await
}
pub(crate) async fn prepare(
    app: &tauri::AppHandle,
    team: &crate::commands::dashboard_launch::LaunchTeam,
    input: &MediaInput,
    own: bool,
    scope: &crate::context_repo::caller_scope::CallerScope,
    workspace_root: Option<&Path>,
) -> Result<(Attachment, bool), String> {
    input.validate()?;
    let config = config(app, team).await?;
    if let Some(url) = &input.url {
        let a =
            Attachment::remote(url, &input.alt, &config, own).map_err(|e| e.reason.to_string())?;
        let a = Attachment::claimed(a, input);
        let auto = config.should_auto_fetch(a.source_host.as_deref().unwrap(), own);
        return Ok((a, auto));
    }
    let raw = PathBuf::from(input.path.as_ref().unwrap());
    // Relative media checks the sender's own content root first; only a miss there
    // can fall back to the local workspace captured for that sender session.
    let (content_path, relative_path) = if raw.is_absolute() {
        (raw, None)
    } else {
        let root = match scope {
            crate::context_repo::caller_scope::CallerScope::Team(view) => {
                view.own_content().own_path().map(Path::to_path_buf)
            }
            crate::context_repo::caller_scope::CallerScope::Human => {
                let ctx = crate::commands::route_to_context::derive_context_for(
                    app, &team.org, &team.team,
                )
                .await?;
                let crate::commands::route_to_context::ContextResolution::Ok(ctx) = ctx else {
                    return Err("media team unavailable".into());
                };
                let org_root = crate::context_repo::path_to_org_root(
                    &ctx.codesense_home,
                    &ctx.principal(),
                    &team.org,
                )?;
                crate::context_repo::inheritance::team_view(&org_root, &team.org, &team.team)
                    .own_content()
                    .own_path()
                    .map(Path::to_path_buf)
            }
            crate::context_repo::caller_scope::CallerScope::Unknown => None,
        }
        .ok_or_else(|| "media team unavailable".to_string())?;
        (root.join(&raw), Some(raw))
    };
    let media = app_state(app).ok_or("media unavailable")?;
    let alt = input.alt.clone();
    let scope = scope.clone();
    let workspace_root = workspace_root.map(Path::to_path_buf);
    let a = crate::commands::await_blocking("media.local", move || {
        let scoped = prepare_local_for_scope_or_workspace(
            &scope,
            &content_path,
            workspace_root.as_deref(),
            &alt,
            &media,
        );
        match scoped {
            Ok(a) => Ok(a),
            Err(content_error) => {
                if let (Some(relative), Some(workspace_root)) =
                    (relative_path, workspace_root.as_deref())
                {
                    prepare_local_for_scope_or_workspace(
                        &scope,
                        &workspace_root.join(relative),
                        Some(workspace_root),
                        &alt,
                        &media,
                    )
                    .map_err(|_| content_error)
                } else {
                    Err(content_error)
                }
            }
        }
    })
    .await?;
    Ok((a, false))
}

pub(crate) fn prepare_local_for_scope(
    scope: &crate::context_repo::caller_scope::CallerScope,
    path: &std::path::Path,
    alt: &str,
    media: &MediaState,
) -> Result<Attachment, String> {
    let bytes = read_scoped_media(scope, path)?;
    cache_local_media(bytes, alt, media)
}

pub(crate) fn prepare_local_for_scope_or_workspace(
    scope: &crate::context_repo::caller_scope::CallerScope,
    path: &std::path::Path,
    workspace_root: Option<&std::path::Path>,
    alt: &str,
    media: &MediaState,
) -> Result<Attachment, String> {
    if matches!(
        scope,
        crate::context_repo::caller_scope::CallerScope::Unknown
    ) {
        return Err("local media sender is unknown".into());
    }
    if let Ok(a) = prepare_local_for_scope(scope, path, alt, media) {
        return Ok(a);
    }
    let root = workspace_root.ok_or_else(|| "local media is outside sender scope".to_string())?;
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_file = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("local media is outside sender workspace".into());
    }
    let bytes = read_local_media(&canonical_file)?;
    cache_local_media(bytes, alt, media)
}

fn read_scoped_media(
    scope: &crate::context_repo::caller_scope::CallerScope,
    path: &std::path::Path,
) -> Result<Vec<u8>, String> {
    use crate::agents::content_reader::ContentReader;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    match scope {
        crate::context_repo::caller_scope::CallerScope::Human => {}
        crate::context_repo::caller_scope::CallerScope::Team(view) => {
            if crate::context_repo::inheritance::real_content_owner(&path).is_none()
                || !matches!(
                    view.admits_path(&path),
                    crate::context_repo::inheritance::Admit::Own
                        | crate::context_repo::inheritance::Admit::Inherited { .. }
                )
            {
                return Err("local media is outside team content".into());
            }
        }
        crate::context_repo::caller_scope::CallerScope::Unknown => {
            return Err("local media sender is unknown".into());
        }
    }
    read_limited(scope.open(&path).map_err(|e| e.to_string())?)
}

fn read_local_media(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    read_limited(file)
}

fn read_limited(mut reader: impl std::io::Read) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Keep a local image by the memory-only rule: its bytes go to memory, never to disk,
/// when the index holds the same sha memory-only (a provider GIF saved locally).
fn cache_local_media(bytes: Vec<u8>, alt: &str, media: &MediaState) -> Result<Attachment, String> {
    let mut attachment = Attachment::empty(alt);
    attachment.media_provider = Some(MediaProvider::None);
    Ok(match media.keep(bytes, None, &mut attachment) {
        Ok(()) => attachment,
        Err(error) => attachment.failed(Failure {
            retryable: false,
            ..error
        }),
    })
}

/// The app's media state, once [`install`] has run.
pub(crate) fn app_state(app: &tauri::AppHandle) -> Option<std::sync::Arc<MediaState>> {
    app.try_state::<std::sync::Arc<MediaState>>()
        .map(|s| s.inner().clone())
}

/// Hold the media state and, in the background, index every synced team's messages
/// and run the one-time purge.
pub(crate) fn install(app: &tauri::AppHandle) {
    let dir = match cache_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("inbox media: no cache dir: {e}");
            return;
        }
    };
    let state = std::sync::Arc::new(MediaState::new(dir, std::sync::Arc::new(state::Http)));
    // Every serve settles the provider view pings it owes.
    let served = app.clone();
    state.when_served(std::sync::Arc::new(move |sha: &str| {
        crate::gif::register::on_served(&served, sha)
    }));
    app.manage(state.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = startup(&app, &state).await {
            log::warn!("inbox media: provider purge not finished, it runs again next start: {e}");
        }
    });
}

async fn startup(app: &tauri::AppHandle, state: &std::sync::Arc<MediaState>) -> Result<(), String> {
    use crate::commands::agent_inbox::InboxHost;
    let host = crate::commands::agent_inbox::AppInboxHost { app: app.clone() };
    // `synced_teams` indexes each team it has not seen yet before returning it. Until it
    // answers, the index is not ready: listings leave cached images as they are.
    let mut wait = std::time::Duration::from_secs(5);
    let teams = loop {
        match host.synced_teams().await {
            Ok(teams) => break teams,
            Err(e) => {
                log::warn!("inbox media: synced teams unavailable, retrying: {e}");
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(std::time::Duration::from_secs(30));
            }
        }
    };
    // `synced_teams` normally marked the index ready on its first answer already.
    if state.set_ready() {
        host.inbox_changed(&[]);
    }
    let mut stores = Vec::new();
    for team in teams {
        let path = host.team_store(&team).await?;
        stores.push((team, path));
    }
    let data_dir = tauri::Manager::path(app)
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let state = state.clone();
    let purged = crate::commands::await_blocking("media.purge", move || {
        purge::run(&state, &stores, &data_dir)
    })
    .await?;
    if let purge::Purged::Done {
        deleted,
        backfilled,
    } = purged
    {
        log::info!(
            "inbox media: purged {deleted} provider files, backfilled {backfilled} messages"
        );
    }
    Ok(())
}

/// Index each of `teams` the media index hasn't seen yet (a team attached after
/// startup), before any of its media is served.
pub(crate) async fn index_new_teams(
    state: &std::sync::Arc<MediaState>,
    host: &dyn crate::commands::agent_inbox::InboxHost,
    teams: &[crate::commands::dashboard_launch::LaunchTeam],
) {
    for team in teams {
        if state.index.is_team_indexed(&team.org, &team.team) {
            continue;
        }
        // Concurrent first sightings share one scan; a failed scan is tried again later.
        let indexing = state.team_indexing(&team.org, &team.team);
        let indexed = indexing
            .get_or_try_init(|| async {
                let path = host.team_store(team).await?;
                let (state, team) = (state.clone(), team.clone());
                crate::commands::await_blocking("media.index", move || {
                    purge::index_store(&state, &team, &path)
                })
                .await
            })
            .await;
        if let Err(e) = indexed {
            log::warn!("inbox media: could not index a team: {e}");
        }
    }
}

/// Fetch `a` for `team` (send time or a tap), storing it by the final host.
pub(crate) async fn fetch(
    app: &tauri::AppHandle,
    team: &crate::commands::dashboard_launch::LaunchTeam,
    a: Attachment,
    automatic: bool,
) -> Result<Attachment, String> {
    let config = config(app, team).await?;
    let state = app_state(app).ok_or("media unavailable")?;
    state.fetch(&config, a, automatic).await
}

/// Record a message's attachments in the sha index.
pub(crate) async fn note(
    app: &tauri::AppHandle,
    team: &crate::commands::dashboard_launch::LaunchTeam,
    message_id: i64,
    attachments: Vec<Attachment>,
) {
    let Some(state) = app_state(app) else {
        return;
    };
    let owner = index::Owner {
        org: team.org.clone(),
        team: team.team.clone(),
        message_id,
    };
    let at = crate::weft::inbox::now_ms();
    let _ = crate::commands::await_blocking("media.note", move || {
        MediaState::note(&state, &owner, at, &attachments);
        Ok(())
    })
    .await;
}

#[cfg(test)]
mod tests;

pub(crate) fn config_sync<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    team: &crate::commands::dashboard_launch::LaunchTeam,
) -> Config {
    let dir = (|| {
        let home = crate::commands::paths::codesense_home_dir()?;
        let profile = crate::commands::local_profile::active(app).ok()?;
        let root =
            crate::context_repo::path_to_org_root(&home, &profile.principal, &team.org).ok()?;
        Some(crate::context_repo::path_to_team_config_dir(
            &root, &team.team,
        ))
    })();
    dir.map(|dir| Config::load(&dir)).unwrap_or_else(|| Config {
        remote: Remote::Off,
        ..Config::default()
    })
}

pub(crate) fn note_config_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    team_dir: &Path,
    org: &str,
    team: &str,
    path: &Path,
) {
    use tauri::Emitter;
    if path != team_dir.join("config/inbox.yml") {
        return;
    }
    let team = crate::commands::dashboard_launch::LaunchTeam {
        org: org.into(),
        team: team.into(),
    };
    let ids = app
        .try_state::<crate::live_hub::LiveHub>()
        .and_then(|hub| hub.inbox_view(&team).ok())
        .map(|view| {
            view.messages
                .into_iter()
                .filter(|m| !m.attachments.is_empty())
                .map(|m| m.message_id)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let _ = app.emit(
        crate::live_hub::inbox_events::INBOX_EVENT,
        crate::live_hub::inbox_events::InboxEvent::new(
            crate::live_hub::inbox_events::InboxChange::Stored,
            &team,
            ids,
        ),
    );
}

fn public_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b)))
}
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => public_v4(ip),
        std::net::IpAddr::V6(ip) => {
            let s = ip.segments();
            let low32 = std::net::Ipv4Addr::from(((s[6] as u32) << 16) | s[7] as u32);
            // Translation prefixes can reach any IPv4, so they are judged by the
            // embedded address. The NAT64 local-use prefix (RFC 8215) is refused
            // outright because a local translator may map it anywhere.
            let embedded_ok = match (s[0], s[1]) {
                (0x0064, 0xff9b) if s[2..6] == [0, 0, 0, 0] => public_v4(low32),
                (0x0064, 0xff9b) => false,
                (0x2002, _) => public_v4(std::net::Ipv4Addr::from(
                    ((s[1] as u32) << 16) | s[2] as u32,
                )),
                // Teredo and documentation ranges.
                (0x2001, 0x0000) | (0x2001, 0x0db8) => false,
                _ => true,
            };
            embedded_ok
                && ip.to_ipv4().is_none()
                && !(ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || ip.is_multicast()
                    || s[0] & 0xffc0 == 0xfec0)
        }
    }
}
fn public_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => public_ip(ip.into()),
        Some(url::Host::Ipv6(ip)) => public_ip(ip.into()),
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}
async fn public_dns(name: &str) -> Result<Vec<std::net::SocketAddr>, Failure> {
    let ips: Vec<_> = tokio::net::lookup_host((name, 0))
        .await
        .map_err(network)?
        .collect();
    if ips.is_empty() || ips.iter().any(|addr| !public_ip(addr.ip())) {
        return Err(failure("address"));
    }
    Ok(ips)
}
struct PublicDns;
impl reqwest::dns::Resolve for PublicDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_owned();
        Box::pin(async move {
            let ips = public_dns(&name).await.map_err(|failure| {
                let message = if failure.reason == "address" {
                    "media-private-address"
                } else {
                    "media DNS lookup failed"
                };
                Box::new(std::io::Error::other(message)) as Box<dyn std::error::Error + Send + Sync>
            })?;
            Ok(Box::new(ips.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

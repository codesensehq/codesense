// SPDX-License-Identifier: MIT
//! Registering sent provider GIFs, as the providers' terms ask: GIPHY's onsent ping when an
//! agent sends a GIF a search found, and its onload ping the first time the sent GIF is shown.
//!
//! Pings go out only while GIF search is On with a key. They carry a random id GIPHY issues for
//! this install, kept in `gif-install.json` and deleted when search is turned Off or the key is
//! removed, and never the key. They are fire-and-forget, never queued, outside the search rate
//! limit, dropped while a provider backoff runs and capped at [`PINGS_PER_HOUR`] per provider and
//! key. KLIPY's share trigger joins as a second [`Registrar`].
use super::{analytics, bucket, giphy, settings, GifService, Provider};
use crate::commands::credential_store::Secret;
use crate::media::{index::Owner, MediaProvider};
use futures_util::future::BoxFuture;
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

/// The install id file's name in the app data dir.
pub(crate) const FILE: &str = "gif-install.json";
/// Pings past this many in a rolling hour, per provider and key, are dropped.
pub(crate) const PINGS_PER_HOUR: usize = 300;
const HOUR_MS: i64 = 60 * 60 * 1000;
/// How long a sent GIF's onload stays pending, from its send.
pub(crate) const ONLOAD_WINDOW_MS: i64 = HOUR_MS;
const TIMEOUT: Duration = Duration::from_secs(5);
const RANDOM_ID_API: &str = "https://api.giphy.com/v1/randomid";
/// Held while `gif-install.json` is written or deleted.
static INSTALL_FILE: Mutex<()> = std::sync::Mutex::new(());

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One attachment: its message and its place in the message's attachments.
pub(crate) type Slot = (Owner, usize);

/// A stored message's provider-tagged GIF, to register.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Sent {
    pub slot: Slot,
    pub provider: MediaProvider,
    pub provider_id: String,
    pub url: String,
}

/// One ping: a provider pingback URL and the install id it carries.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Ping<'a> {
    pub pingback: &'a str,
    pub install_id: &'a str,
    pub at_ms: i64,
}

/// How a ping went. It names no URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Sent,
    /// No URL could be made from the pingback.
    Unusable,
    /// The provider answered this status.
    Status(u16),
    Failed(giphy::Failure),
}

/// A provider's send and view registration, provider-neutral, so a second provider joins
/// without changing callers.
pub(crate) trait Registrar: Send + Sync {
    /// The provider's send registration.
    fn on_sent<'a>(&'a self, ping: Ping<'a>) -> BoxFuture<'a, Outcome>;
    /// The provider's view registration.
    fn on_load<'a>(&'a self, ping: Ping<'a>) -> BoxFuture<'a, Outcome>;
}

/// `pingback` with the install's `random_id` and the time in ms, which GIPHY asks for, added;
/// any `api_key`, `random_id` or `ts` it held is taken out, so a ping never carries the key.
/// `None` unless it is still https on GIPHY's hosts.
pub(crate) fn pingback_url(pingback: &str, random_id: &str, at_ms: i64) -> Option<url::Url> {
    if !super::on_provider_host(Provider::Giphy, pingback) {
        return None;
    }
    let mut url = match pingback.parse::<url::Url>() {
        Ok(url) => url,
        Err(_) => return None,
    };
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| !matches!(&**name, "api_key" | "random_id" | "ts"))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in &kept {
            query.append_pair(name, value);
        }
        query.append_pair("random_id", random_id);
        query.append_pair("ts", &at_ms.to_string());
    }
    Some(url)
}

/// GIPHY's pingbacks, over the 5 s registration client. The body is not read.
pub(crate) struct GiphyPings {
    transport: Arc<dyn giphy::Transport>,
}
impl GiphyPings {
    pub(crate) fn new(transport: Arc<dyn giphy::Transport>) -> Self {
        Self { transport }
    }
    async fn ping_giphy(&self, ping: Ping<'_>) -> Outcome {
        let Some(url) = pingback_url(ping.pingback, ping.install_id, ping.at_ms) else {
            return Outcome::Unusable;
        };
        match giphy::Transport::get(self.transport.as_ref(), &url).await {
            Ok(reply) if (200..300).contains(&reply.status) => Outcome::Sent,
            Ok(reply) => Outcome::Status(reply.status),
            Err(failure) => Outcome::Failed(failure),
        }
    }
}
impl Registrar for GiphyPings {
    fn on_sent<'a>(&'a self, ping: Ping<'a>) -> BoxFuture<'a, Outcome> {
        Box::pin(self.ping_giphy(ping))
    }
    fn on_load<'a>(&'a self, ping: Ping<'a>) -> BoxFuture<'a, Outcome> {
        Box::pin(self.ping_giphy(ping))
    }
}

/// The 5 s transport pings and the random id call use: the shared hardened client.
pub(crate) fn ping_client() -> Result<giphy::Http, String> {
    giphy::Http::on(crate::media::hardened_client_builder(TIMEOUT).https_only(true))
}

/// The random id GIPHY issued for this install with the key whose fingerprint is `fp`, if
/// `gif-install.json` holds one.
fn read_install(dir: &Path, provider: Provider, fp: &str) -> Option<String> {
    let bytes = Result::ok(std::fs::read(dir.join(FILE)))?;
    let file: serde_json::Value = Result::ok(serde_json::from_slice(&bytes))?;
    let entry = file.get(Provider::as_str(provider))?;
    let id = serde_json::Value::as_str(entry.get("randomId")?)?;
    let key = serde_json::Value::as_str(entry.get("key")?)?;
    (key == fp && super::valid_id(id)).then(|| id.to_string())
}

/// Save `id` as the install's random id for the key `fp`: a temp file readable by this user
/// only, renamed over the file.
fn write_install(dir: &Path, provider: Provider, fp: &str, id: &str) -> std::io::Result<()> {
    let _guard = lock(&INSTALL_FILE);
    let mut body = serde_json::Map::new();
    body.insert(
        Provider::as_str(provider).to_string(),
        serde_json::json!({"randomId": id, "key": fp}),
    );
    std::fs::create_dir_all(dir)?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    std::io::Write::write_all(&mut temp, &serde_json::to_vec_pretty(&body)?)?;
    codesense_platform::fs::set_owner_only(tempfile::NamedTempFile::path(&temp))?;
    tempfile::NamedTempFile::persist(temp, dir.join(FILE)).map_err(|e| e.error)?;
    Ok(())
}

/// Delete `gif-install.json`, so nothing that identifies the install stays: GIF search was
/// turned Off or the key removed or replaced. A failure is logged.
pub(crate) fn forget_install(dir: &Path) {
    let _guard = lock(&INSTALL_FILE);
    match std::fs::remove_file(dir.join(FILE)) {
        Err(e) if std::io::Error::kind(&e) != std::io::ErrorKind::NotFound => {
            log::warn!(target: "gif", "gif registration: the install id could not be deleted: {e}");
        }
        _ => {}
    }
}

/// The id in GIPHY's random id response, when it matches the GIF id pattern.
fn parse_random_id(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = Result::ok(serde_json::from_slice(body))?;
    let id = serde_json::Value::as_str(value.get("data")?.get("random_id")?)?;
    super::valid_id(id).then(|| id.to_string())
}

/// A view ping waiting for its GIF's first serve: armed by the send with the onload URL, given
/// the sha when the fetch finishes (either may come first), held an hour from the send.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Pending {
    pub onload: Option<String>,
    pub sha: Option<String>,
    pub expires: i64,
}

/// Registration for the app: the GIF service's settings, keys, bucket and analytics, the
/// provider registrar, and what it holds in memory (pending onloads, sent GIFs, the hourly
/// ping count).
pub(crate) struct Registration {
    service: Arc<GifService>,
    registrar: Arc<dyn Registrar>,
    transport: Arc<dyn giphy::Transport>,
    clock: super::Clock,
    onloads: Mutex<HashMap<Slot, Pending>>,
    /// (GIF id, message) of each onsent, until an hour after it.
    sent: Mutex<HashMap<(String, Owner), i64>>,
    /// Each bucket key's pings in the last hour, oldest first.
    pings: Mutex<HashMap<String, VecDeque<i64>>>,
    /// Held while the random id is read or made, so concurrent sends make one.
    creating: tokio::sync::Mutex<()>,
}

impl Registration {
    pub(crate) fn new(
        service: Arc<GifService>,
        transport: Arc<dyn giphy::Transport>,
        clock: super::Clock,
    ) -> Self {
        Self {
            service,
            registrar: Arc::new(GiphyPings::new(transport.clone())),
            transport,
            clock,
            onloads: std::sync::Mutex::new(HashMap::new()),
            sent: std::sync::Mutex::new(HashMap::new()),
            pings: std::sync::Mutex::new(HashMap::new()),
            creating: tokio::sync::Mutex::new(()),
        }
    }

    /// The provider's key and its fingerprint, while GIF search is On with that provider and
    /// a key; else `None`, logged.
    async fn active_key(&self, provider: Provider) -> Option<(Secret, String)> {
        let dir = self.service.data_dir().to_path_buf();
        let current = match tokio::task::spawn_blocking(move || settings::load(&dir)).await {
            Ok(current) => current,
            Err(_) => return None,
        };
        if !current.enabled || current.provider != provider {
            log::info!(target: "gif", "gif registration: GIF search is off; no ping");
            return None;
        }
        match settings::Keys::read_timed(&self.service.keys, provider).await {
            Ok(key) => {
                let fp = super::fingerprint(&key);
                Some((key, fp))
            }
            Err(error) => {
                log::info!(target: "gif", "gif registration: no usable key ({}); no ping", error.code());
                None
            }
        }
    }

    /// The install's random id for this key: the saved one, else one made by GIPHY's random id
    /// call (outside the search bucket) and saved, while search is still On with the same key.
    /// `None`, logged, when it can't be had: pings wait until it exists.
    async fn install_id(&self, provider: Provider, key: &Secret, fp: &str) -> Option<String> {
        let _one = self.creating.lock().await;
        let dir = self.service.data_dir().to_path_buf();
        let (read_dir, read_fp) = (dir.clone(), fp.to_string());
        let saved =
            tokio::task::spawn_blocking(move || read_install(&read_dir, provider, &read_fp)).await;
        if let Ok(Some(id)) = saved {
            return Some(id);
        }
        let mut url: url::Url = RANDOM_ID_API.parse().expect("the GIPHY random id URL");
        url.query_pairs_mut().append_pair("api_key", key.expose());
        let id = match giphy::Transport::get(self.transport.as_ref(), &url).await {
            Ok(reply) if (200..300).contains(&reply.status) => parse_random_id(&reply.body),
            Ok(reply) => {
                log::warn!(target: "gif", "gif registration: GIPHY's random id call answered HTTP {}", reply.status);
                return None;
            }
            Err(failure) => {
                log::warn!(target: "gif", "gif registration: GIPHY's random id call failed ({failure:?})");
                return None;
            }
        };
        let Some(id) = id else {
            log::warn!(target: "gif", "gif registration: GIPHY's random id is not an id; refused");
            return None;
        };
        // Search may have been turned Off, or the key changed, while the call ran.
        match self.active_key(provider).await {
            Some((_, now_fp)) if now_fp == fp => {}
            _ => return None,
        }
        let (write_fp, write_id) = (fp.to_string(), id.clone());
        match tokio::task::spawn_blocking(move || {
            write_install(&dir, provider, &write_fp, &write_id)
        })
        .await
        {
            Ok(Ok(())) => Some(id),
            _ => {
                log::warn!(target: "gif", "gif registration: the install id could not be saved");
                None
            }
        }
    }

    /// Count one ping against `key`'s hour, or say the hour's pings are spent.
    fn spend_ping(&self, key: &str, now: i64) -> bool {
        let mut pings = lock(&self.pings);
        let times = pings.entry(key.to_string()).or_default();
        while VecDeque::front(times).is_some_and(|at| *at <= now - HOUR_MS) {
            times.pop_front();
        }
        if times.len() >= PINGS_PER_HOUR {
            return false;
        }
        times.push_back(now);
        true
    }

    /// Send one ping now, unless the provider's backoff is running or the hour's pings for
    /// this key are spent (dropped, logged). A 429 is logged only: it never sets the search
    /// backoff.
    async fn send_ping(
        &self,
        provider: Provider,
        fp: &str,
        onload: bool,
        pingback: &str,
        id: &str,
    ) {
        let key = super::bucket_key(provider, fp);
        let now = (self.clock)();
        let (rate, counted) = (self.service.bucket.clone(), key.clone());
        let backoff = tokio::task::spawn_blocking(move || {
            bucket::Bucket::backoff_until(&rate, &counted, now)
        })
        .await;
        let event = if onload { "onload" } else { "onsent" };
        if !matches!(backoff, Ok(None)) {
            log::info!(target: "gif", "gif registration: {event} dropped during a GIPHY backoff");
            return;
        }
        if !self.spend_ping(&key, now) {
            log::warn!(target: "gif", "gif registration: {event} dropped; {PINGS_PER_HOUR} pings this hour");
            return;
        }
        let ping = Ping {
            pingback,
            install_id: id,
            at_ms: now,
        };
        let outcome = if onload {
            Registrar::on_load(self.registrar.as_ref(), ping).await
        } else {
            Registrar::on_sent(self.registrar.as_ref(), ping).await
        };
        match outcome {
            Outcome::Sent => {}
            Outcome::Status(429) => {
                log::warn!(target: "gif", "gif registration: GIPHY rate limited an {event} (HTTP 429)")
            }
            other => {
                log::warn!(target: "gif", "gif registration: {event} not registered ({other:?})")
            }
        }
    }

    /// The first onsent of GIF `id` in `message`, or an hour after the last.
    fn first_send(&self, id: &str, message: &Owner, now: i64) -> bool {
        let mut sent = lock(&self.sent);
        HashMap::retain(&mut sent, |_, expires| *expires > now);
        let key = (id.to_string(), message.clone());
        if sent.contains_key(&key) {
            return false;
        }
        sent.insert(key, now + HOUR_MS);
        true
    }

    /// Change `slot`'s pending onload, dropping every expired entry first.
    fn with_pending(&self, slot: &Slot, now: i64, change: impl FnOnce(&mut Pending)) {
        let mut onloads = lock(&self.onloads);
        HashMap::retain(&mut onloads, |_, p| p.expires > now);
        let pending = onloads.entry(slot.clone()).or_insert_with(|| Pending {
            onload: None,
            sha: None,
            expires: now + ONLOAD_WINDOW_MS,
        });
        change(pending);
    }

    /// Register a stored message's provider GIF: its onload is armed, an hour from now, and its
    /// onsent sent, both only for a GIF a search returned with the URL that was sent. Each skip
    /// is logged: GIF search Off, no key, no analytics entry, an id not bound to the sent URL,
    /// a second send of the GIF in the message, no onsent URL, no install id.
    pub(crate) async fn register_send(&self, sent: Sent) {
        if sent.provider != MediaProvider::Giphy {
            log::info!(target: "gif", "gif registration: {:?} sends are not registered yet", sent.provider);
            return;
        }
        let provider = Provider::Giphy;
        let Some((key, fp)) = self.active_key(provider).await else {
            return;
        };
        let now = (self.clock)();
        let held = &self.service.analytics;
        let Some(entry) = analytics::Analytics::held_entry(held, provider, &sent.provider_id, now)
        else {
            log::info!(target: "gif", "gif registration: no search returned this GIF in the last hour; no ping");
            return;
        };
        if !analytics::Entry::binds(&entry, &sent.url) {
            log::warn!(target: "gif", "gif registration: the GIF id was sent with another GIF's URL; not registered");
            return;
        }
        if let Some(onload) = entry.pingbacks.onload.clone() {
            let expires = now + ONLOAD_WINDOW_MS;
            self.with_pending(&sent.slot, now, |p| {
                p.onload = Some(onload);
                p.expires = expires;
            });
        }
        if !self.first_send(&sent.provider_id, &sent.slot.0, now) {
            log::info!(target: "gif", "gif registration: this GIF's send in the message is registered already");
            return;
        }
        let Some(onsent) = entry.pingbacks.onsent.as_deref() else {
            log::info!(target: "gif", "gif registration: the search gave no onsent URL; no ping");
            return;
        };
        let Some(id) = self.install_id(provider, &key, &fp).await else {
            return;
        };
        self.send_ping(provider, &fp, false, onsent, &id).await;
    }

    /// A stored message's media fetch finished: a GIPHY-tagged attachment's pending onload gets
    /// its sha; one that lost its tag (redirected away) or has no sha loses its pending onload.
    pub(crate) fn note_fetched(&self, slot: &Slot, sha: Option<&str>, tagged: bool) {
        let now = (self.clock)();
        match sha.filter(|_| tagged) {
            Some(sha) => self.with_pending(slot, now, |p| p.sha = Some(sha.to_string())),
            None => {
                lock(&self.onloads).remove(slot);
            }
        }
    }

    /// Take every pending onload armed for `sha`, so only this serve fires them.
    pub(crate) fn take_onloads(&self, sha: &str) -> Vec<(Slot, Pending)> {
        let mut onloads = lock(&self.onloads);
        let slots: Vec<Slot> = onloads
            .iter()
            .filter(|(_, p)| p.sha.as_deref() == Some(sha) && p.onload.is_some())
            .map(|(slot, _)| slot.clone())
            .collect();
        slots
            .into_iter()
            .filter_map(|slot| onloads.remove(&slot).map(|p| (slot, p)))
            .collect()
    }

    /// Settle a serve: `claimed` are the attachments whose view ping the sha index gave this
    /// serve, `taken` the pending onloads this serve took. Each claimed one with a pending
    /// onload within its hour is pinged; the rest are only marked (an expired entry, or one
    /// lost to a restart before the first view), logged. Returns the attachments to mark.
    pub(crate) async fn settle_serve(
        &self,
        claimed: Vec<Slot>,
        mut taken: Vec<(Slot, Pending)>,
    ) -> Vec<Slot> {
        let now = (self.clock)();
        let mut due = Vec::new();
        for slot in &claimed {
            let at = Iterator::position(&mut taken.iter(), |(s, _)| s == slot);
            let pending = at.map(|at| taken.swap_remove(at).1);
            match pending {
                Some(Pending {
                    onload: Some(onload),
                    expires,
                    ..
                }) if expires > now => due.push(onload),
                Some(_) => {
                    log::info!(target: "gif", "gif registration: an onload expired before the first view; marked")
                }
                None => {
                    log::info!(target: "gif", "gif registration: no pending onload (sent before a restart, or unbound); marked")
                }
            }
        }
        if !Vec::is_empty(&due) {
            if let Some((key, fp)) = self.active_key(Provider::Giphy).await {
                if let Some(id) = self.install_id(Provider::Giphy, &key, &fp).await {
                    for onload in &due {
                        self.send_ping(Provider::Giphy, &fp, true, onload, &id)
                            .await;
                    }
                }
            }
        }
        claimed
    }
}

/// The app's registration, made on first use with the GIF service.
pub(crate) fn registration<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Arc<Registration>, String> {
    static REGISTRATION: OnceLock<Arc<Registration>> = OnceLock::new();
    if let Some(registration) = REGISTRATION.get() {
        return Ok(registration.clone());
    }
    let service = super::service(app)?;
    let transport: Arc<dyn giphy::Transport> = Arc::new(ping_client()?);
    let clock: super::Clock = Arc::new(crate::weft::inbox::now_ms);
    Ok(REGISTRATION
        .get_or_init(|| Arc::new(Registration::new(service, transport, clock)))
        .clone())
}

/// Register a sent GIF in the background: the send never waits on it.
pub(crate) fn on_send(app: &tauri::AppHandle, sent: Sent) {
    let registration = match registration(app) {
        Ok(registration) => registration,
        Err(e) => {
            log::warn!(target: "gif", "gif registration: unavailable: {e}");
            return;
        }
    };
    tauri::async_runtime::spawn(async move { registration.register_send(sent).await });
}

/// A stored message's media fetch finished (see [`Registration::note_fetched`]).
pub(crate) fn on_fetched(app: &tauri::AppHandle, slot: &Slot, a: &crate::media::Attachment) {
    if let Ok(registration) = registration(app) {
        let tagged = a.provider == Some(MediaProvider::Giphy);
        registration.note_fetched(slot, a.sha256.as_deref(), tagged);
    }
}

/// An image was served: take the pending onloads armed for its sha, claim the view pings the
/// sha index says it settles, then ping and mark them in the background.
pub(crate) fn on_served(app: &tauri::AppHandle, sha: &str) {
    let (Ok(registration), Some(media)) = (registration(app), crate::media::app_state(app)) else {
        return;
    };
    let taken = registration.take_onloads(sha);
    let claimed = crate::media::index::ShaIndex::claim_onloads(&media.index, sha);
    if Vec::is_empty(&claimed) && Vec::is_empty(&taken) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let marks = registration.settle_serve(claimed, taken).await;
        let host: Arc<dyn crate::commands::agent_inbox::InboxHost> =
            crate::commands::agent_inbox::AppInboxHost::port(app);
        crate::commands::agent_inbox::mark_onloads_sent(&host, marks).await;
    });
}

#[cfg(test)]
mod tests;

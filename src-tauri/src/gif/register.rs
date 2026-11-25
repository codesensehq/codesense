// SPDX-License-Identifier: MIT
//! Registering sent provider GIFs, as the providers' terms ask: GIPHY's onsent ping when an
//! agent sends a GIF a search found, its onload ping the first time the sent GIF is shown, and
//! its onclick ping when the person picks a GIF in the Inbox pane's picker.
//!
//! Pings go out only while GIF search is On with a key. They carry a random id GIPHY issues for
//! this install, kept in `gif-install.json` and deleted when search is turned Off or the key is
//! removed, and never the key. They are fire-and-forget, never queued, outside the search rate
//! limit, dropped while a provider backoff runs and capped at [`PINGS_PER_HOUR`] per provider and
//! key. KLIPY's share trigger joins as a second [`Registrar`].
#[cfg(test)]
use super::install::{forget_install, FILE};
use super::install::{install_epoch, read_install, write_install};
use super::{analytics, bucket, settings, transport, GifError, GifService, Provider};
use crate::commands::credential_store::Secret;
use crate::media::{index::Owner, MediaProvider};
use futures_util::future::BoxFuture;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

/// Pings past this many in a rolling hour, per provider and key, are dropped.
pub(crate) const PINGS_PER_HOUR: usize = 300;
const HOUR_MS: i64 = 60 * 60 * 1000;
/// How long a sent GIF's onload stays pending, from its send.
pub(crate) const ONLOAD_WINDOW_MS: i64 = HOUR_MS;
const TIMEOUT: Duration = Duration::from_secs(5);
const RANDOM_ID_API: &str = "https://api.giphy.com/v1/randomid";
/// After a failed random id call, or a random id that could not be saved, the next waits this
/// long. Held in memory, so it starts over with each app run.
pub(crate) const RANDOM_ID_RETRY_MS: i64 = 15 * 60 * 1000;
/// After a failed keychain read for a serve, the next serve waits this long to read it again.
pub(crate) const KEY_RETRY_MS: i64 = 15 * 60 * 1000;

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
    Failed(transport::Failure),
}

/// Which registration a ping is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    Sent,
    Load,
    Click,
}
impl Event {
    fn name(self) -> &'static str {
        match self {
            Event::Sent => "onsent",
            Event::Load => "onload",
            Event::Click => "onclick",
        }
    }
}

/// A provider's send, view and pick registration, provider-neutral, so a second provider
/// joins without changing callers.
pub(crate) trait Registrar: Send + Sync {
    /// Register `event` with the provider.
    fn register<'a>(&'a self, event: Event, ping: Ping<'a>) -> BoxFuture<'a, Outcome>;
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
    transport: Arc<dyn transport::Transport>,
}
impl GiphyPings {
    pub(crate) fn new(transport: Arc<dyn transport::Transport>) -> Self {
        Self { transport }
    }
    async fn ping_giphy(&self, ping: Ping<'_>) -> Outcome {
        let Some(url) = pingback_url(ping.pingback, ping.install_id, ping.at_ms) else {
            return Outcome::Unusable;
        };
        match transport::Transport::get(self.transport.as_ref(), &url).await {
            Ok(reply) if (200..300).contains(&reply.status) => Outcome::Sent,
            Ok(reply) => Outcome::Status(reply.status),
            Err(failure) => Outcome::Failed(failure),
        }
    }
}
impl Registrar for GiphyPings {
    /// Every event is the pingback GIPHY gave for it.
    fn register<'a>(&'a self, _: Event, ping: Ping<'a>) -> BoxFuture<'a, Outcome> {
        Box::pin(self.ping_giphy(ping))
    }
}

/// The 5 s transport pings and the random id call use: the shared hardened client.
pub(crate) fn ping_client() -> Result<transport::Http, String> {
    transport::Http::on(crate::media::hardened_client_builder(TIMEOUT).https_only(true))
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
    /// The send is still being registered: an onload may yet be armed.
    pub waiting: bool,
}

/// What [`Registration::admit`] let through: the held search entry of a send or a pick, or
/// none for a serve's view pings.
struct Admitted {
    entry: Option<analytics::Entry>,
}

/// The only provider with a view ping: a serve's pending onloads are all GIPHY's.
const ONLOAD_PROVIDER: Provider = Provider::Giphy;

/// The provider of a stored message's tag, when it is one GIF search knows.
fn provider_of(tag: MediaProvider) -> Option<Provider> {
    match tag {
        MediaProvider::Giphy => Some(Provider::Giphy),
        MediaProvider::Klipy | MediaProvider::None => None,
    }
}

/// Why no key is at hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NoKey {
    /// GIF search is Off, or has no key or no secret store: nothing will be sent.
    Off,
    /// The key could not be read just now (a locked keychain, a prompt): try again later.
    Unavailable,
}

/// What a serve settled: the attachments to mark `onloadSent`, and those whose view ping
/// stays pending for a later serve (their claim is given back).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Settled {
    pub marks: Vec<Slot>,
    pub retry: Vec<Slot>,
}

/// Registration for the app: the GIF service's settings, keys, bucket and analytics, the
/// provider registrar, and what it holds in memory (pending onloads, sent GIFs, the hourly
/// ping count).
pub(crate) struct Registration {
    service: Arc<GifService>,
    registrar: Arc<dyn Registrar>,
    transport: Arc<dyn transport::Transport>,
    clock: super::Clock,
    onloads: Mutex<HashMap<Slot, Pending>>,
    /// (GIF id, message) of each onsent, until an hour after it.
    sent: Mutex<HashMap<(String, Owner), i64>>,
    /// Each bucket key's pings in the last hour, oldest first.
    pings: Mutex<HashMap<String, VecDeque<i64>>>,
    /// Held while the random id is read or made, so concurrent sends make one.
    creating: tokio::sync::Mutex<()>,
    /// No random id call before this (ms): set by a failed one.
    random_retry_at: Mutex<i64>,
    /// No keychain read for a serve before this (ms): set by a read that failed.
    key_retry_at: Mutex<i64>,
    /// The install epoch what is held here belongs to.
    epoch: Mutex<u64>,
}

impl Registration {
    pub(crate) fn new(
        service: Arc<GifService>,
        transport: Arc<dyn transport::Transport>,
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
            random_retry_at: std::sync::Mutex::new(0),
            key_retry_at: std::sync::Mutex::new(0),
            epoch: std::sync::Mutex::new(0),
        }
    }

    /// Let go of the pending onloads, sent GIFs and search entries held for an earlier install
    /// epoch, so nothing sent with an old id is sent again with a new one.
    /// Returns the epoch now followed. A new epoch (a new key, or search back On) also ends
    /// the waits a failed random id call or keychain read set.
    fn follow_epoch(&self) -> u64 {
        let now = install_epoch(self.service.data_dir());
        let mut seen = lock(&self.epoch);
        if *seen != now {
            *seen = now;
            lock(&self.onloads).clear();
            lock(&self.sent).clear();
            *lock(&self.random_retry_at) = 0;
            *lock(&self.key_retry_at) = 0;
        }
        analytics::Analytics::start_epoch(&self.service.analytics, now);
        now
    }

    /// Whether the install epoch is still `epoch`: nothing turned search Off, or removed or
    /// replaced the key, since work that began under it.
    fn still_in(&self, epoch: u64) -> bool {
        install_epoch(self.service.data_dir()) == epoch
    }

    /// Whether the provider has no backoff running for `key`.
    async fn provider_open(&self, key: &str, now: i64) -> bool {
        let (rate, counted) = (self.service.bucket.clone(), key.to_string());
        let backoff = tokio::task::spawn_blocking(move || {
            bucket::Bucket::backoff_until(&rate, &counted, now)
        })
        .await;
        match backoff {
            Ok(until) => until.is_none(),
            Err(e) => {
                log::warn!(target: "gif", "gif registration: the backoff read stopped: {e}");
                false
            }
        }
    }

    /// The provider's key and its fingerprint, while GIF search is On with that provider and
    /// a key; else `None`, logged.
    async fn active_key(&self, provider: Provider) -> Result<(Secret, String, u64), NoKey> {
        let dir = self.service.data_dir().to_path_buf();
        let epoch = install_epoch(&dir);
        let current = match tokio::task::spawn_blocking(move || settings::load(&dir)).await {
            Ok(current) => current,
            Err(e) => {
                log::warn!(target: "gif", "gif registration: the settings read stopped: {e}");
                return Err(NoKey::Unavailable);
            }
        };
        if !current.enabled || current.provider != provider {
            log::info!(target: "gif", "gif registration: GIF search is off; no ping");
            return Err(NoKey::Off);
        }
        match settings::Keys::read_timed(&self.service.keys, provider).await {
            Ok(key) => {
                let fp = super::fingerprint(&key);
                Ok((key, fp, epoch))
            }
            Err(error @ (GifError::NoProvider | GifError::NoSecretStore)) => {
                log::info!(target: "gif", "gif registration: no key ({}); no ping", error.code());
                Err(NoKey::Off)
            }
            Err(error) => {
                log::info!(target: "gif", "gif registration: the key can't be read now ({})", error.code());
                Err(NoKey::Unavailable)
            }
        }
    }

    /// The install's random id for this key: the saved one, else one made by GIPHY's random id
    /// call (outside the search bucket) and saved, while search is still On with the same key.
    /// `None`, logged, when it can't be had: pings wait until it exists.
    async fn install_id(
        &self,
        provider: Provider,
        key: &Secret,
        fp: &str,
        epoch: u64,
    ) -> Option<String> {
        let _one = self.creating.lock().await;
        let dir = self.service.data_dir().to_path_buf();
        let (read_dir, read_fp) = (dir.clone(), fp.to_string());
        let saved =
            tokio::task::spawn_blocking(move || read_install(&read_dir, provider, &read_fp)).await;
        match saved {
            Ok(Some(id)) => return Some(id),
            Ok(None) => {}
            Err(e) => {
                log::warn!(target: "gif", "gif registration: the install id read stopped: {e}")
            }
        }
        // The call carries the key, so it is bounded like a ping: not during a backoff, within
        // the hour's pings, and not again within RANDOM_ID_RETRY_MS of a failure.
        let now = (self.clock)();
        let bucket_key = super::bucket_key(provider, fp);
        if now < *lock(&self.random_retry_at) {
            log::info!(target: "gif", "gif registration: waiting to ask GIPHY for an install id again");
            return None;
        }
        if !self.provider_open(&bucket_key, now).await {
            log::info!(target: "gif", "gif registration: no install id call during a GIPHY backoff");
            return None;
        }
        if !self.spend_ping(&bucket_key, now) {
            log::warn!(target: "gif", "gif registration: no install id call; {PINGS_PER_HOUR} calls this hour");
            return None;
        }
        let mut url: url::Url = RANDOM_ID_API.parse().expect("the GIPHY random id URL");
        url.query_pairs_mut().append_pair("api_key", key.expose());
        let id = match transport::Transport::get(self.transport.as_ref(), &url).await {
            Ok(reply) if (200..300).contains(&reply.status) => parse_random_id(&reply.body),
            Ok(reply) => {
                log::warn!(target: "gif", "gif registration: GIPHY's random id call answered HTTP {}", reply.status);
                None
            }
            Err(failure) => {
                log::warn!(target: "gif", "gif registration: GIPHY's random id call failed ({failure:?})");
                None
            }
        };
        let Some(id) = id else {
            self.wait_for_random_id(now);
            return None;
        };
        // Saved only if search was not turned Off, nor the key removed or replaced, meanwhile.
        let (write_fp, write_id) = (fp.to_string(), id.clone());
        match tokio::task::spawn_blocking(move || {
            write_install(&dir, provider, &write_fp, &write_id, epoch)
        })
        .await
        {
            Ok(Ok(true)) => Some(id),
            Ok(Ok(false)) => {
                log::info!(target: "gif", "gif registration: search was turned off or the key changed; id not saved");
                None
            }
            Ok(Err(e)) => {
                log::warn!(target: "gif", "gif registration: the install id could not be saved: {e}");
                self.wait_for_random_id(now);
                None
            }
            Err(e) => {
                log::warn!(target: "gif", "gif registration: the install id write stopped: {e}");
                self.wait_for_random_id(now);
                None
            }
        }
    }

    /// No random id call again before [`RANDOM_ID_RETRY_MS`] from `now`.
    fn wait_for_random_id(&self, now: i64) {
        *lock(&self.random_retry_at) = now + RANDOM_ID_RETRY_MS;
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
    async fn send_ping(&self, provider: Provider, fp: &str, kind: Event, pingback: &str, id: &str) {
        let key = super::bucket_key(provider, fp);
        let now = (self.clock)();
        let event = kind.name();
        if !self.provider_open(&key, now).await {
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
        let outcome = Registrar::register(self.registrar.as_ref(), kind, ping).await;
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

    /// The local checks a registration passes before any keychain read, so one that can't
    /// register never reads it: `provider` registers `event`, and for a send or a pick (`gif`,
    /// the GIF id and a send's URL) a search within the last hour returned the GIF, with a send's
    /// URL one it returned. `None`, logged, when one fails.
    fn admit(
        &self,
        provider: Provider,
        event: Event,
        gif: Option<(&str, Option<&str>)>,
        now: i64,
    ) -> Option<Admitted> {
        let name = event.name();
        if !Provider::registers(provider, event) {
            log::info!(target: "gif", "gif registration: {} takes no {name}; not registered", Provider::display_name(provider));
            return None;
        }
        let Some((id, url)) = gif else {
            return Some(Admitted { entry: None });
        };
        let held = &self.service.analytics;
        let Some(entry) = analytics::Analytics::held_entry(held, provider, id, now) else {
            log::info!(target: "gif", "gif registration: no search returned this GIF in the last hour; no {name}");
            return None;
        };
        if url.is_some_and(|url| !analytics::Entry::binds(&entry, url)) {
            log::warn!(target: "gif", "gif registration: the GIF id was sent with another GIF's URL; not registered");
            return None;
        }
        Some(Admitted { entry: Some(entry) })
    }

    /// The key checks, after [`Self::admit`]: GIF search is On with `provider` and a key, and
    /// the install epoch is still `epoch`, the one the work began in. A moved epoch (search
    /// turned Off and On, or the key replaced, while the key was read) is [`NoKey::Off`]: what
    /// was held belongs to the old install id.
    async fn authorize(
        &self,
        provider: Provider,
        event: Event,
        epoch: u64,
    ) -> Result<(Secret, String), NoKey> {
        let (key, fp, read_in) = self.active_key(provider).await?;
        if read_in != epoch || !self.still_in(epoch) {
            let name = event.name();
            log::info!(target: "gif", "gif registration: the install id changed before the {name}; not registered");
            return Err(NoKey::Off);
        }
        Ok((key, fp))
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
            waiting: false,
        });
        change(pending);
    }

    /// Put taken pending onloads back, for a later serve.
    /// An entry made for the slot meanwhile (its send armed it while the serve settled) is
    /// merged with, never overwritten: what it learned wins, and the put-back fills the gaps.
    fn put_back(&self, pending: Vec<(Slot, Pending)>) {
        let mut onloads = lock(&self.onloads);
        for (slot, p) in pending {
            let merged = match onloads.remove(&slot) {
                Some(newer) => Pending {
                    onload: newer.onload.or(p.onload),
                    sha: newer.sha.or(p.sha),
                    expires: newer.expires.max(p.expires),
                    waiting: newer.waiting,
                },
                None => p,
            };
            onloads.insert(slot, merged);
        }
    }

    /// A send of `slot` is about to be registered: until it is, a serve keeps its view ping
    /// pending instead of settling it.
    pub(crate) fn expect_send(&self, slot: &Slot) {
        self.follow_epoch();
        let now = (self.clock)();
        self.with_pending(slot, now, |p| p.waiting = true);
    }

    /// Register a stored message's provider GIF: its onload is armed, an hour from now, and its
    /// onsent sent, both only for a GIF a search returned with the URL that was sent. Each skip
    /// is logged: GIF search Off, no key, no analytics entry, an id not bound to the sent URL,
    /// a second send of the GIF in the message, no onsent URL, no install id.
    pub(crate) async fn register_send(&self, sent: Sent) {
        let slot = sent.slot.clone();
        self.register_inner(sent).await;
        // Registered: a serve now settles the slot, firing an armed onload or marking one never
        // armed. Kept so a serve settling meanwhile merges with it instead of waiting again.
        let now = (self.clock)();
        self.with_pending(&slot, now, |p| p.waiting = false);
    }

    async fn register_inner(&self, sent: Sent) {
        let Some(provider) = provider_of(sent.provider) else {
            log::info!(target: "gif", "gif registration: {:?} sends are not registered", sent.provider);
            return;
        };
        let epoch = self.follow_epoch();
        let now = (self.clock)();
        let gif = Some((sent.provider_id.as_str(), Some(sent.url.as_str())));
        let Some(Admitted { entry: Some(entry) }) = self.admit(provider, Event::Sent, gif, now)
        else {
            return;
        };
        let Ok((key, fp)) = self.authorize(provider, Event::Sent, epoch).await else {
            return;
        };
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
        let Some(id) = self.install_id(provider, &key, &fp, epoch).await else {
            return;
        };
        if self.still_in(epoch) {
            self.send_ping(provider, &fp, Event::Sent, onsent, &id)
                .await;
        }
    }

    /// The person picked GIF `id` in the Inbox pane's picker: its onclick goes out, once per
    /// pick, for a GIF a search returned in the last hour. Like a send's onsent it needs search
    /// On with a key and the install id, and counts against the hour's pings. Each skip is
    /// logged: not GIPHY, no search entry, no onclick URL, search Off or no key, the install id
    /// changed meanwhile, no install id.
    pub(crate) async fn register_click(&self, provider: Provider, id: &str) {
        let epoch = self.follow_epoch();
        let now = (self.clock)();
        let gif = Some((id, None));
        let Some(Admitted { entry: Some(entry) }) = self.admit(provider, Event::Click, gif, now)
        else {
            return;
        };
        let Some(onclick) = entry.pingbacks.onclick.as_deref() else {
            log::info!(target: "gif", "gif registration: the search gave no onclick URL; no ping");
            return;
        };
        let Ok((key, fp)) = self.authorize(provider, Event::Click, epoch).await else {
            return;
        };
        let Some(install) = self.install_id(provider, &key, &fp, epoch).await else {
            return;
        };
        if self.still_in(epoch) {
            self.send_ping(provider, &fp, Event::Click, onclick, &install)
                .await;
        }
    }

    /// A stored message's media fetch finished: a GIPHY-tagged attachment's pending onload gets
    /// its sha. One that lost its tag (redirected away) loses its pending onload; a failed fetch
    /// keeps it, so a later Retry still fires it.
    pub(crate) fn note_fetched(&self, slot: &Slot, sha: Option<&str>, tagged: bool) {
        self.follow_epoch();
        let now = (self.clock)();
        match (tagged, sha) {
            (false, _) => {
                lock(&self.onloads).remove(slot);
            }
            (true, Some(sha)) => self.with_pending(slot, now, |p| p.sha = Some(sha.to_string())),
            (true, None) => {}
        }
    }

    /// Take every pending onload of `sha`, so only this serve settles them.
    pub(crate) fn take_onloads(&self, sha: &str) -> Vec<(Slot, Pending)> {
        self.follow_epoch();
        let mut onloads = lock(&self.onloads);
        let slots: Vec<Slot> = onloads
            .iter()
            .filter(|(_, p)| p.sha.as_deref() == Some(sha))
            .map(|(slot, _)| slot.clone())
            .collect();
        slots
            .into_iter()
            .filter_map(|slot| onloads.remove(&slot).map(|p| (slot, p)))
            .collect()
    }

    /// Settle a serve. `claimed` are the attachments whose view ping the sha index gave this
    /// serve, `taken` the pending onloads it took. A claimed one with an armed onload within its
    /// hour is pinged and marked. It is marked without a ping when its onload expired, was never
    /// armed (an unbound send, or one sent before a restart), or GIF search is Off. It stays
    /// pending, claim given back, while its send is still being registered or when the key or
    /// the install id can't be had just now. A taken one the index didn't claim goes back.
    pub(crate) async fn settle_serve(
        &self,
        claimed: Vec<Slot>,
        mut taken: Vec<(Slot, Pending)>,
    ) -> Settled {
        // The epoch the taken entries belong to, read before any work.
        let started = *lock(&self.epoch);
        let now = (self.clock)();
        let mut settled = Settled {
            marks: Vec::new(),
            retry: Vec::new(),
        };
        let mut due: Vec<(Slot, Pending)> = Vec::new();
        let mut back: Vec<(Slot, Pending)> = Vec::new();
        for slot in claimed {
            let at = Iterator::position(&mut taken.iter(), |(s, _)| *s == slot);
            match at.map(|at| taken.swap_remove(at).1) {
                Some(p) if p.waiting && p.onload.is_none() => {
                    settled.retry.push(slot.clone());
                    back.push((slot, p));
                }
                Some(p) if p.onload.is_some() && p.expires > now => due.push((slot, p)),
                Some(p) if p.onload.is_some() => {
                    log::info!(target: "gif", "gif registration: an onload expired before the first view; marked");
                    settled.marks.push(slot);
                }
                _ => {
                    log::info!(target: "gif", "gif registration: no armed onload (unbound, or sent before a restart); marked");
                    settled.marks.push(slot);
                }
            }
        }
        if !Vec::is_empty(&taken) {
            log::info!(target: "gif", "gif registration: {} pending onloads not yet indexed; kept", taken.len());
            Vec::append(&mut back, &mut taken);
        }
        let provider = ONLOAD_PROVIDER;
        if !Vec::is_empty(&due) && self.admit(provider, Event::Load, None, now).is_none() {
            settled
                .marks
                .extend(Vec::drain(&mut due, ..).map(|(slot, _)| slot));
        }
        if !Vec::is_empty(&due) {
            // After a failed keychain read, serves wait before reading it again, so a denied
            // access prompt is not raised by every view; their onloads stay pending meanwhile.
            let waiting_for_key = now < *lock(&self.key_retry_at);
            let active = if waiting_for_key {
                Err(NoKey::Unavailable)
            } else {
                // Taken under an earlier epoch (search turned Off meanwhile) is Off: marked.
                self.authorize(provider, Event::Load, started).await
            };
            match active {
                Err(NoKey::Off) => {
                    settled
                        .marks
                        .extend(Vec::drain(&mut due, ..).map(|(slot, _)| slot));
                }
                Err(NoKey::Unavailable) => {
                    if !waiting_for_key {
                        *lock(&self.key_retry_at) = now + KEY_RETRY_MS;
                    }
                }
                Ok((key, fp)) => {
                    if let Some(id) = self.install_id(provider, &key, &fp, started).await {
                        let current = self.still_in(started);
                        for (slot, p) in Vec::drain(&mut due, ..) {
                            match &p.onload {
                                Some(onload) if current => {
                                    self.send_ping(provider, &fp, Event::Load, onload, &id)
                                        .await
                                }
                                _ => {}
                            }
                            settled.marks.push(slot);
                        }
                    }
                }
            }
            // What is still due could not be sent now: it waits for a later serve.
            for (slot, p) in due {
                settled.retry.push(slot.clone());
                back.push((slot, p));
            }
        }
        self.put_back(back);
        settled
    }
}

/// A stored message's provider-tagged GIF, as registration takes it. Only a send from a
/// session on this machine registers, as only its view does.
pub(crate) fn sent_of(media: &crate::commands::agent_inbox::StoredMedia) -> Option<Sent> {
    let a = &media.attachment;
    if !a.own_sender {
        log::info!(target: "gif", "gif registration: not sent from this machine; not registered");
        return None;
    }
    Some(Sent {
        slot: (
            owner_of(&media.team, media.chat.as_deref(), media.message_id),
            media.slot,
        ),
        provider: a.provider?,
        provider_id: a.provider_id.clone()?,
        url: a.source_url.clone()?,
    })
}

/// The index owner of message `message_id`: in `team`'s inbox, or in the chat of
/// workspace `chat`.
pub(crate) fn owner_of(
    team: &crate::commands::dashboard_launch::LaunchTeam,
    chat: Option<&str>,
    message_id: i64,
) -> Owner {
    Owner {
        org: team.org.clone(),
        team: team.team.clone(),
        message_id,
        chat: chat.map(str::to_string),
    }
}

/// Register a stored message's GIF in the background: the send never waits on it.
pub(crate) fn send_in_background(
    registration: &Arc<Registration>,
    media: &crate::commands::agent_inbox::StoredMedia,
) {
    let Some(sent) = sent_of(media) else {
        return;
    };
    registration.expect_send(&sent.slot);
    let registration = registration.clone();
    tauri::async_runtime::spawn(async move { registration.register_send(sent).await });
}

/// Register a pick in the background: the picker never waits on it.
pub(crate) fn click_in_background(
    registration: &Arc<Registration>,
    provider: Provider,
    id: String,
) {
    let registration = registration.clone();
    tauri::async_runtime::spawn(async move { registration.register_click(provider, &id).await });
}

/// A stored message's media fetch finished (see [`Registration::note_fetched`]).
pub(crate) fn fetched(
    registration: &Registration,
    team: &crate::commands::dashboard_launch::LaunchTeam,
    message_id: i64,
    slot: usize,
    a: &crate::media::Attachment,
) {
    fetched_by(registration, owner_of(team, None, message_id), slot, a);
}

/// [`fetched`] for any owner, a workspace chat message's included.
pub(crate) fn fetched_by(
    registration: &Registration,
    owner: Owner,
    slot: usize,
    a: &crate::media::Attachment,
) {
    let tagged = a.provider == Some(MediaProvider::Giphy);
    registration.note_fetched(&(owner, slot), a.sha256.as_deref(), tagged);
}

/// The serve hook: each serve takes the pending onloads of its sha and claims the view pings
/// the sha index says it settles, then pings, gives back what must wait and marks the rest in
/// the background.
pub(crate) fn serve_hook(
    registration_of: impl Fn() -> Option<Arc<Registration>> + Send + Sync + 'static,
    media: std::sync::Weak<crate::media::MediaState>,
    host: impl Fn() -> Arc<dyn crate::commands::agent_inbox::InboxHost> + Send + Sync + 'static,
) -> crate::media::ServeHook {
    let host = Arc::new(host);
    Arc::new(move |sha: &str| {
        let (Some(registration), Some(state)) = (registration_of(), media.upgrade()) else {
            return;
        };
        let taken = registration.take_onloads(sha);
        let claimed = crate::media::index::ShaIndex::claim_onloads(&state.index, sha);
        if Vec::is_empty(&claimed) && Vec::is_empty(&taken) {
            return;
        }
        let (host, sha) = (host(), sha.to_string());
        tauri::async_runtime::spawn(async move {
            let settled = registration.settle_serve(claimed, taken).await;
            crate::media::index::ShaIndex::release_onloads(&state.index, &sha, &settled.retry);
            crate::commands::agent_inbox::mark_onloads_sent(&host, settled.marks).await;
        });
    })
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
    let transport: Arc<dyn transport::Transport> = Arc::new(ping_client()?);
    let clock: super::Clock = Arc::new(crate::weft::inbox::now_ms);
    Ok(REGISTRATION
        .get_or_init(|| Arc::new(Registration::new(service, transport, clock)))
        .clone())
}

#[cfg(test)]
pub(crate) mod tests;

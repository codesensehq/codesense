// SPDX-License-Identifier: MIT
//! Where fetched image bytes live, and how a reader gets them back. Provider media
//! (GIPHY, KLIPY) is held in memory only and fetched again on a miss; everything else
//! keeps the content-addressed disk cache.
use super::{
    index::{Owner, ShaIndex},
    memory::{Lifetime, MemoryStore},
    Attachment, Config, Downloaded, Failure, MediaProvider, Remote,
};
use axum::body::Bytes;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

/// Gets a URL's bytes. Production is `media::download`; tests stand in a local server.
pub(crate) trait Fetch: Send + Sync {
    fn get<'a>(
        &'a self,
        url: &'a str,
        config: &'a Config,
    ) -> BoxFuture<'a, Result<Downloaded, Failure>>;
}

/// The network fetch, with every check `download` makes.
pub(crate) struct Http;
impl Fetch for Http {
    fn get<'a>(
        &'a self,
        url: &'a str,
        config: &'a Config,
    ) -> BoxFuture<'a, Result<Downloaded, Failure>> {
        Box::pin(super::download(url, config))
    }
}

/// An admitted automatic re-fetch: the URL and the team config it is fetched under.
#[derive(Clone)]
pub(crate) struct Source {
    pub url: String,
    pub config: Config,
}

/// A re-fetch that failed this session.
#[derive(Clone, Copy, Debug)]
struct Failed {
    reason: &'static str,
    permanent: bool,
    attempts: u32,
}

type Refetch = Shared<BoxFuture<'static, Result<Bytes, Failure>>>;

/// The longest any reader waits for the startup index, counted from install: after
/// that, reads decide without it.
pub(crate) const READY_WAIT: Duration = Duration::from_secs(10);

pub(crate) struct MediaState {
    dir: PathBuf,
    pub(crate) memory: MemoryStore,
    pub(crate) index: ShaIndex,
    failures: Mutex<HashMap<String, Failed>>,
    inflight: Mutex<HashMap<String, Refetch>>,
    fetcher: Arc<dyn Fetch>,
    ready: tokio::sync::watch::Sender<bool>,
    /// When this state was made, which starts the [`READY_WAIT`] window.
    started: tokio::time::Instant,
    /// Teams being indexed on their first sighting, so concurrent readers share one scan.
    #[allow(clippy::type_complexity)]
    indexing: Mutex<HashMap<(String, String), Arc<tokio::sync::OnceCell<()>>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl MediaState {
    /// A state over the disk cache `dir`, not ready until [`Self::set_ready`].
    pub(crate) fn new(dir: PathBuf, fetcher: Arc<dyn Fetch>) -> Self {
        Self {
            dir,
            memory: MemoryStore::default(),
            index: ShaIndex::new(),
            failures: Mutex::default(),
            inflight: Mutex::default(),
            fetcher,
            ready: tokio::sync::watch::channel(false).0,
            started: tokio::time::Instant::now(),
            indexing: Mutex::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(dir: PathBuf, fetcher: Arc<dyn Fetch>) -> Arc<Self> {
        let state = Arc::new(Self::new(dir, fetcher));
        state.set_ready();
        state
    }

    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// The startup index is built: readers and writers may decide storage.
    /// Returns whether this call made it ready (the first one does).
    pub(crate) fn set_ready(&self) -> bool {
        !self.ready.send_replace(true)
    }

    pub(crate) fn is_ready(&self) -> bool {
        *self.ready.borrow()
    }

    async fn ready(&self) {
        if self.is_ready() {
            return;
        }
        let left = READY_WAIT.saturating_sub(self.started.elapsed());
        if left.is_zero() {
            return;
        }
        let mut ready = self.ready.subscribe();
        if tokio::time::timeout(left, ready.wait_for(|r| *r))
            .await
            .is_err()
        {
            log::warn!("inbox media: the media index is still building; deciding without it");
        }
    }

    /// The one memory-only rule: `sha` is served from memory only, and never written to
    /// disk, when the index holds any provider reference to it, or when `attachment`
    /// itself is provider media (before the index has it).
    pub(crate) fn is_memory_only(&self, sha: &str, attachment: Option<&Attachment>) -> bool {
        self.index.is_memory_only(sha) || attachment.is_some_and(Attachment::is_provider_media)
    }

    /// The one-shot indexing of `team`, shared by concurrent first sightings.
    pub(crate) fn team_indexing(&self, org: &str, team: &str) -> Arc<tokio::sync::OnceCell<()>> {
        lock(&self.indexing)
            .entry((org.to_string(), team.to_string()))
            .or_default()
            .clone()
    }

    /// Record the attachments of one message in the index. A sha this makes
    /// memory-only loses its disk copy at once.
    pub(crate) fn note(&self, owner: &Owner, at: i64, attachments: &[Attachment]) {
        for sha in self.index.set_message(owner, at, attachments) {
            if let Err(e) = self.remove_file(&sha) {
                log::warn!("inbox media: could not drop a memory-only disk copy: {e}");
            }
        }
    }

    /// Delete the disk copy of `sha`, if any. Deleting under the disk lock keeps a
    /// concurrent store from writing it back after the index made it memory-only.
    pub(crate) fn remove_file(&self, sha: &str) -> std::io::Result<()> {
        if !super::valid_sha(sha) {
            return Ok(());
        }
        let _guard = lock(&super::DISK);
        match std::fs::remove_file(self.dir.join(sha)) {
            Err(e) if std::io::Error::kind(&e) != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// The automatic re-fetch `config` admits for `sha`, or the reason there is none:
    /// `off` when remote media is off, `sender` without a URL sent from this machine,
    /// `ask` when the team asks first, `host` when the team doesn't list the URL's host.
    pub(crate) fn admission(&self, config: &Config, sha: &str) -> Result<Source, &'static str> {
        if config.remote == Remote::Off {
            return Err("off");
        }
        let url = self.index.refetch_url(sha).ok_or("sender")?;
        if config.remote == Remote::Ask {
            return Err("ask");
        }
        let host = Result::ok(Url::parse(&url))
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default();
        if !config.should_auto_fetch(&host, true) {
            return Err("host");
        }
        Ok(Source {
            url,
            config: config.clone(),
        })
    }

    fn may_refetch(&self, sha: &str) -> bool {
        lock(&self.failures)
            .get(sha)
            .is_none_or(|f| !f.permanent && f.attempts < 2)
    }

    fn failed(&self, sha: &str, error: Failure) {
        let mut failures = lock(&self.failures);
        let entry = failures.entry(sha.to_string()).or_insert(Failed {
            reason: error.reason,
            permanent: false,
            attempts: 0,
        });
        entry.reason = error.reason;
        entry.permanent = !error.retryable;
        entry.attempts += 1;
    }

    /// `attachments` as `config` and this machine present them. `config` applies first
    /// (remote media off: the link card). Then a `cached` memory-only attachment stays
    /// `cached` while it is in memory or can be fetched again, shows `failed` once its
    /// re-fetch failed, and shows tap-to-load (with the reason) when no automatic
    /// re-fetch is admitted. Other shas keep the disk check. Until the startup index is
    /// built, `cached` attachments are left as they are.
    pub(crate) fn present(&self, config: &Config, attachments: &mut [Attachment]) {
        config.apply(attachments);
        if !self.is_ready() {
            return;
        }
        let now = Instant::now();
        for a in attachments {
            let Some(sha) = a.sha256.clone() else {
                continue;
            };
            if a.state != "cached" {
                continue;
            }
            if !self.is_memory_only(&sha, Some(&*a)) {
                if !self.dir.join(&sha).is_file() {
                    a.state = "failed".into();
                    a.reason = Some("cache".into());
                    a.retryable = a.source_url.is_some();
                }
                continue;
            }
            if self.memory.contains(&sha, now) {
                continue;
            }
            if let Some(f) = lock(&self.failures).get(&sha).copied() {
                if f.permanent || f.attempts >= 2 {
                    a.state = "failed".into();
                    a.reason = Some(f.reason.into());
                    a.retryable = a.source_url.is_some();
                    continue;
                }
            }
            if let Err(reason) = self.admission(config, &sha) {
                a.state = "pending".into();
                a.reason = Some(reason.into());
                a.retryable = false;
            }
        }
    }

    /// The bytes of a confirmed `attachment` for a reader under `config`: memory, then
    /// the disk cache (not for a memory-only sha), then an admitted re-fetch.
    pub(crate) async fn read(
        self: &Arc<Self>,
        config: &Config,
        attachment: &Attachment,
    ) -> Result<Bytes, String> {
        let sha = attachment.sha256.as_deref().ok_or("media unavailable")?;
        self.ready().await;
        let source = Result::ok(self.admission(config, sha));
        self.fetch_or_cached(sha, Some(attachment), source).await
    }

    /// The bytes of `sha`: from memory, then (only for a sha that is not memory-only)
    /// from disk, then fetched again from `source` when one was admitted. Concurrent
    /// misses on one sha share a single fetch.
    pub(crate) async fn fetch_or_cached(
        self: &Arc<Self>,
        sha: &str,
        attachment: Option<&Attachment>,
        source: Option<Source>,
    ) -> Result<Bytes, String> {
        if !super::valid_sha(sha) {
            return Err("invalid media hash".into());
        }
        self.ready().await;
        if !self.is_memory_only(sha, attachment) {
            let dir = self.dir.clone();
            let sha = sha.to_string();
            return crate::commands::await_blocking("media.read", move || {
                super::read_cached(&dir, &sha)
            })
            .await
            .map(Bytes::from);
        }
        if let Some(bytes) = self.memory.get(sha, Instant::now()) {
            return Ok(bytes);
        }
        let source = source.ok_or("media unavailable")?;
        let refetch = {
            let mut inflight = lock(&self.inflight);
            if let Some(refetch) = inflight.get(sha) {
                refetch.clone()
            } else {
                if !self.may_refetch(sha) {
                    return Err("media unavailable".into());
                }
                let state = self.clone();
                let key = sha.to_string();
                let refetch = async move {
                    let result = state.refetch(&key, &source).await;
                    lock(&state.inflight).remove(&key);
                    result
                }
                .boxed()
                .shared();
                inflight.insert(sha.to_string(), refetch.clone());
                refetch
            }
        };
        refetch.await.map_err(|e| e.reason.to_string())
    }

    async fn refetch(&self, sha: &str, source: &Source) -> Result<Bytes, Failure> {
        let result = async {
            let got = self.fetcher.get(&source.url, &source.config).await?;
            if format!("{:x}", Sha256::digest(&got.bytes)) != sha {
                return Err(super::failure("changed"));
            }
            super::inspect(&got.bytes)?;
            Ok(got)
        }
        .await;
        match result {
            Ok(got) => {
                let bytes = Bytes::from(got.bytes);
                let lifetime = Lifetime::from_cache_control(got.cache_control.as_deref());
                self.memory
                    .insert(sha, bytes.clone(), lifetime, Instant::now());
                lock(&self.failures).remove(sha);
                Ok(bytes)
            }
            Err(e) => {
                log::warn!("inbox media: re-fetch failed: {}", e.reason);
                self.failed(sha, e);
                Err(e)
            }
        }
    }

    /// Fetch `a`'s source URL and keep the bytes by the final host: a provider host, or
    /// a sha the index already holds memory-only, goes to memory; anything else to the
    /// disk cache. Every fetch path (send, tap-to-load) comes through here.
    pub(crate) async fn fetch(
        self: &Arc<Self>,
        config: &Config,
        mut a: Attachment,
        automatic: bool,
    ) -> Result<Attachment, String> {
        if config.remote == Remote::Off {
            a.state = "blocked".into();
            return Ok(a);
        }
        if automatic && !config.should_auto_fetch(a.source_host.as_deref().unwrap_or(""), true) {
            a.state = "pending".into();
            a.reason = Some(
                if config.remote == Remote::Ask {
                    "ask"
                } else {
                    "host"
                }
                .into(),
            );
            return Ok(a);
        }
        let url = a.source_url.clone().ok_or("media source missing")?;
        self.ready().await;
        let got = match self.fetcher.get(&url, config).await {
            Ok(got) => got,
            Err(e) => return Ok(a.failed(e)),
        };
        a.media_provider = Some(MediaProvider::of_host(
            got.final_url.host_str().unwrap_or(""),
        ));
        let state = self.clone();
        crate::commands::await_blocking("media.cache", move || {
            let Downloaded {
                bytes,
                cache_control,
                ..
            } = got;
            Ok(match state.keep(bytes, cache_control.as_deref(), &mut a) {
                Ok(()) => a,
                Err(e) => a.failed(e),
            })
        })
        .await
    }

    /// Keep verified `bytes` as `a`'s image by the memory-only rule: in memory, never on
    /// disk, when `a` is provider media or the index holds the sha memory-only (for as
    /// long as `cache_control` allows); else in the disk cache. The rule is checked and
    /// the bytes written under the disk lock. Blocking: call it off the async runtime.
    pub(crate) fn keep(
        &self,
        bytes: Vec<u8>,
        cache_control: Option<&str>,
        a: &mut Attachment,
    ) -> Result<(), Failure> {
        let (mime, w, h) = super::inspect(&bytes)?;
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let len = bytes.len() as u64;
        {
            let _guard = lock(&super::DISK);
            if self.is_memory_only(&sha, Some(&*a)) {
                // A non-provider copy of the same bytes cached earlier goes too.
                let _ = std::fs::remove_file(self.dir.join(&sha));
                let lifetime = Lifetime::from_cache_control(cache_control);
                self.memory
                    .insert(&sha, Bytes::from(bytes), lifetime, Instant::now());
            } else {
                super::write_file(&self.dir, &sha, &bytes)?;
            }
        }
        lock(&self.failures).remove(&sha);
        a.set_cached(sha, mime, w, h, len);
        Ok(())
    }
}

/// A stand-in network for tests: canned answers by URL, every call recorded.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeFetch {
    #[allow(clippy::type_complexity)]
    routes: Mutex<HashMap<String, Result<(Vec<u8>, String, Option<String>), Failure>>>,
    calls: Mutex<Vec<String>>,
    delay: Mutex<Option<Duration>>,
}

#[cfg(test)]
impl FakeFetch {
    /// `url` answers `bytes`, as if finally fetched from `final_url`.
    pub(crate) fn serve(
        &self,
        url: &str,
        bytes: &[u8],
        final_url: &str,
        cache_control: Option<&str>,
    ) {
        lock(&self.routes).insert(
            url.into(),
            Ok((
                bytes.to_vec(),
                final_url.into(),
                cache_control.map(String::from),
            )),
        );
    }
    pub(crate) fn fail(&self, url: &str, failure: Failure) {
        lock(&self.routes).insert(url.into(), Err(failure));
    }
    /// Every answer waits this long first, so concurrent askers overlap.
    pub(crate) fn slow(&self, delay: Duration) {
        *lock(&self.delay) = Some(delay);
    }
    pub(crate) fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }
}

#[cfg(test)]
impl Fetch for FakeFetch {
    fn get<'a>(
        &'a self,
        url: &'a str,
        _config: &'a Config,
    ) -> BoxFuture<'a, Result<Downloaded, Failure>> {
        Box::pin(async move {
            lock(&self.calls).push(url.to_string());
            let delay = *lock(&self.delay);
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            let answer = lock(&self.routes).get(url).cloned();
            match answer {
                Some(Ok((bytes, final_url, cache_control))) => Ok(Downloaded {
                    bytes,
                    final_url: url::Url::parse(&final_url).unwrap(),
                    cache_control,
                }),
                Some(Err(failure)) => Err(failure),
                None => Err(super::failure("http")),
            }
        })
    }
}

// SPDX-License-Identifier: MIT
//! Provider media held in memory only: a bounded store keyed by sha256 that evicts the
//! least recently used entries, each kept for as long as the provider's `Cache-Control`
//! allows. Nothing here touches the disk.
use axum::body::Bytes;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

/// The most provider media held at once.
pub const MEMORY_BYTES: usize = 64 * 1024 * 1024;
/// Kept this long when the provider sends no `max-age`.
pub const DEFAULT_TTL: Duration = Duration::from_secs(60 * 60);
/// A provider's `max-age` is honoured up to this.
pub const MAX_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// `no-store` bytes stay only for the render that asked: this long after the last read.
pub const PIN: Duration = Duration::from_secs(60);

/// How long bytes may stay, from the response's `Cache-Control`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifetime {
    /// Dropped this long after they were stored.
    For(Duration),
    /// `no-store` or `max-age=0`: dropped [`PIN`] after the last read.
    Pinned,
}

impl Lifetime {
    pub fn from_cache_control(header: Option<&str>) -> Self {
        let Some(header) = header else {
            return Self::For(DEFAULT_TTL);
        };
        let mut max_age = None;
        for directive in header.split(',') {
            let (name, value) = match directive.split_once('=') {
                Some((name, value)) => (name.trim(), Some(value.trim().trim_matches('"'))),
                None => (directive.trim(), None),
            };
            if name.eq_ignore_ascii_case("no-store") {
                return Self::Pinned;
            }
            if name.eq_ignore_ascii_case("max-age") {
                match value.and_then(|v| Result::ok(v.parse::<u64>())) {
                    Some(0) => return Self::Pinned,
                    Some(seconds) => max_age = Some(seconds),
                    None => {}
                }
            }
        }
        Self::For(max_age.map_or(DEFAULT_TTL, |s| Duration::from_secs(s).min(MAX_TTL)))
    }
}

struct Entry {
    bytes: Bytes,
    lifetime: Lifetime,
    stored: Instant,
    used: Instant,
}

impl Entry {
    fn expired(&self, now: Instant) -> bool {
        match self.lifetime {
            Lifetime::For(ttl) => now.saturating_duration_since(self.stored) >= ttl,
            Lifetime::Pinned => now.saturating_duration_since(self.used) >= PIN,
        }
    }
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    total: usize,
}

impl Inner {
    fn remove(&mut self, sha: &str) {
        if let Some(entry) = self.entries.remove(sha) {
            self.total -= entry.bytes.len();
        }
    }
    fn drop_expired(&mut self, now: Instant) {
        let expired: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, e)| e.expired(now))
            .map(|(sha, _)| sha.clone())
            .collect();
        for sha in expired {
            self.remove(&sha);
        }
    }
}

/// The in-memory store. Every method takes the current instant, so tests drive the clock.
pub struct MemoryStore {
    cap: usize,
    inner: Mutex<Inner>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::with_cap(MEMORY_BYTES)
    }
}

impl MemoryStore {
    pub fn with_cap(cap: usize) -> Self {
        Self {
            cap,
            inner: Mutex::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The bytes of `sha`, if held and not expired. A read counts as a use.
    pub fn get(&self, sha: &str, now: Instant) -> Option<Bytes> {
        let mut inner = self.lock();
        if Entry::expired(inner.entries.get(sha)?, now) {
            inner.remove(sha);
            return None;
        }
        let entry = inner.entries.get_mut(sha)?;
        entry.used = now;
        Some(entry.bytes.clone())
    }

    /// Whether `sha` is held and not expired, without counting as a use.
    pub fn contains(&self, sha: &str, now: Instant) -> bool {
        self.lock()
            .entries
            .get(sha)
            .is_some_and(|entry| !Entry::expired(entry, now))
    }

    /// Hold `bytes` under `sha`, evicting expired then least recently used entries first.
    pub fn insert(&self, sha: &str, bytes: Bytes, lifetime: Lifetime, now: Instant) {
        if bytes.len() > self.cap {
            return;
        }
        let mut inner = self.lock();
        inner.remove(sha);
        inner.drop_expired(now);
        while inner.total + bytes.len() > self.cap {
            let Some(oldest) = inner
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(sha, _)| sha.clone())
            else {
                break;
            };
            inner.remove(&oldest);
        }
        inner.total += bytes.len();
        inner.entries.insert(
            sha.to_string(),
            Entry {
                bytes,
                lifetime,
                stored: now,
                used: now,
            },
        );
    }

    /// The bytes held now.
    #[cfg(test)]
    pub fn total(&self) -> usize {
        self.lock().total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(n: usize) -> Bytes {
        Bytes::from(vec![7u8; n])
    }

    #[test]
    fn the_default_store_is_bounded_at_64_mib() {
        assert_eq!(MemoryStore::default().cap, 64 * 1024 * 1024);
    }

    #[test]
    fn the_store_never_exceeds_its_cap_and_evicts_the_least_recently_used() {
        let store = MemoryStore::with_cap(100);
        let t0 = Instant::now();
        store.insert("a", bytes(40), Lifetime::For(DEFAULT_TTL), t0);
        store.insert(
            "b",
            bytes(40),
            Lifetime::For(DEFAULT_TTL),
            t0 + Duration::from_secs(1),
        );
        // Reading `a` makes `b` the least recently used.
        assert!(store.get("a", t0 + Duration::from_secs(2)).is_some());
        store.insert(
            "c",
            bytes(40),
            Lifetime::For(DEFAULT_TTL),
            t0 + Duration::from_secs(3),
        );
        assert!(store.total() <= 100);
        let now = t0 + Duration::from_secs(4);
        assert!(store.contains("a", now));
        assert!(!store.contains("b", now));
        assert!(store.contains("c", now));
        // Larger than the whole store: never held.
        store.insert("huge", bytes(101), Lifetime::For(DEFAULT_TTL), now);
        assert!(!store.contains("huge", now));
        assert!(store.total() <= 100);
    }

    #[test]
    fn lifetimes_follow_the_providers_cache_control() {
        let hour = Duration::from_secs(3600);
        assert_eq!(Lifetime::from_cache_control(None), Lifetime::For(hour));
        assert_eq!(
            Lifetime::from_cache_control(Some("public")),
            Lifetime::For(hour)
        );
        assert_eq!(
            Lifetime::from_cache_control(Some("public, max-age=600")),
            Lifetime::For(Duration::from_secs(600))
        );
        assert_eq!(
            Lifetime::from_cache_control(Some("max-age=31536000")),
            Lifetime::For(MAX_TTL)
        );
        assert_eq!(
            Lifetime::from_cache_control(Some("max-age=600, No-Store")),
            Lifetime::Pinned
        );
        assert_eq!(
            Lifetime::from_cache_control(Some("max-age=0")),
            Lifetime::Pinned
        );
    }

    #[test]
    fn ttl_entries_expire_on_the_mock_clock() {
        let store = MemoryStore::with_cap(1000);
        let t0 = Instant::now();
        let missing = Lifetime::from_cache_control(None);
        store.insert("a", bytes(1), missing, t0);
        assert!(store
            .get("a", t0 + DEFAULT_TTL - Duration::from_secs(1))
            .is_some());
        assert!(store.get("a", t0 + DEFAULT_TTL).is_none());
        assert_eq!(store.total(), 0);
        let capped = Lifetime::from_cache_control(Some("max-age=999999"));
        store.insert("b", bytes(1), capped, t0);
        assert!(store.contains("b", t0 + MAX_TTL - Duration::from_secs(1)));
        assert!(!store.contains("b", t0 + MAX_TTL));
    }

    #[test]
    fn no_store_bytes_are_pinned_for_the_render_then_dropped() {
        let store = MemoryStore::with_cap(1000);
        let t0 = Instant::now();
        store.insert("a", bytes(1), Lifetime::Pinned, t0);
        // Each read within the pin window slides it.
        let mut at = t0;
        for _ in 0..5 {
            at += Duration::from_secs(50);
            assert!(store.get("a", at).is_some());
        }
        // Nothing read it for the window: gone.
        assert!(store.get("a", at + PIN).is_none());
        assert_eq!(store.total(), 0);
    }
}

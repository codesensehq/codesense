// SPDX-License-Identifier: MIT
//! The search rate limit: a bucket of 90 searches an hour per provider and key fingerprint
//! (beta keys allow 100), and the backoff a provider 429 asks for. It lives in the app data dir,
//! read and written under one lock and replaced atomically, so a restart keeps the count and
//! concurrent searches never lose one. Only fingerprints are written, never a key.
use super::GifError;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

/// The state file's name in the app data dir.
pub(crate) const FILE: &str = "gif-rate.json";
/// Searches a non-production key may make in an hour.
pub(crate) const CAPACITY: f64 = 90.0;
const HOUR_MS: f64 = 3_600_000.0;
/// The longest a backoff lasts, and a 429's backoff when it gives no `Retry-After`.
pub(crate) const MAX_BACKOFF_SECS: u64 = 24 * 60 * 60;
pub(crate) const DEFAULT_BACKOFF_SECS: u64 = 15 * 60;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateEntry {
    tokens: f64,
    refilled_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backoff_until_ms: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct RateState {
    #[serde(default)]
    buckets: BTreeMap<String, RateEntry>,
}
impl RateState {
    fn empty() -> Self {
        Self {
            buckets: BTreeMap::new(),
        }
    }
}

pub(crate) struct Bucket {
    path: PathBuf,
    lock: Mutex<()>,
}

fn lock(m: &Mutex<()>) -> MutexGuard<'_, ()> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Seconds from `now_ms` until `until_ms`, rounded up.
fn secs_until(until_ms: i64, now_ms: i64) -> u64 {
    ((until_ms - now_ms).max(0) as u64).div_ceil(1000)
}

impl Bucket {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    /// The saved state, and whether the file was unreadable (each bucket then starts empty). A
    /// missing file is not.
    fn load(&self) -> (RateState, bool) {
        match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(state) => (state, false),
                Err(_) => (RateState::empty(), true),
            },
            Err(e) if std::io::Error::kind(&e) == std::io::ErrorKind::NotFound => {
                (RateState::empty(), false)
            }
            Err(_) => (RateState::empty(), true),
        }
    }

    /// `key`'s bucket refilled to `now_ms`: full when it is new, empty after a corrupt file or a
    /// refill time in the future, and a backoff cut to at most 24 h from now.
    fn entry(state: &mut RateState, key: &str, corrupt: bool, now_ms: i64) -> RateEntry {
        let start = |tokens| RateEntry {
            tokens,
            refilled_at_ms: now_ms,
            backoff_until_ms: None,
        };
        let mut entry = match state.buckets.remove(key) {
            Some(entry) => entry,
            None if corrupt => start(0.0),
            None => start(CAPACITY),
        };
        if !entry.tokens.is_finite() || entry.tokens < 0.0 || entry.refilled_at_ms > now_ms {
            entry.tokens = 0.0;
            entry.refilled_at_ms = now_ms;
        }
        let refill = (now_ms - entry.refilled_at_ms) as f64 * CAPACITY / HOUR_MS;
        entry.tokens = (entry.tokens + refill).min(CAPACITY);
        entry.refilled_at_ms = now_ms;
        entry.backoff_until_ms = entry
            .backoff_until_ms
            .filter(|until| *until > now_ms)
            .map(|until| until.min(now_ms + MAX_BACKOFF_SECS as i64 * 1000));
        entry
    }

    /// Count one search against `key`, or say how long to wait: during a backoff, or when a
    /// non-production key has no search left. A production key has no local cap.
    pub(crate) fn take(&self, key: &str, production: bool, now_ms: i64) -> Result<(), GifError> {
        let _guard = lock(&self.lock);
        let (mut state, corrupt) = self.load();
        let mut entry = Self::entry(&mut state, key, corrupt, now_ms);
        let outcome = if let Some(until) = entry.backoff_until_ms {
            Err(GifError::RateLimited {
                retry_after: secs_until(until, now_ms).max(1),
            })
        } else if production {
            Ok(())
        } else if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            Ok(())
        } else {
            let wait_ms = (1.0 - entry.tokens) * HOUR_MS / CAPACITY;
            Err(GifError::RateLimited {
                retry_after: ((wait_ms / 1000.0).ceil() as u64).max(1),
            })
        };
        state.buckets.insert(key.to_string(), entry);
        self.save(&state);
        outcome
    }

    /// Block `key`'s searches for `retry_after` seconds (at most 24 h) after a provider 429, and
    /// return the seconds it blocks for.
    pub(crate) fn back_off(&self, key: &str, retry_after: u64, now_ms: i64) -> u64 {
        let _guard = lock(&self.lock);
        let (mut state, corrupt) = self.load();
        let mut entry = Self::entry(&mut state, key, corrupt, now_ms);
        let secs = retry_after.min(MAX_BACKOFF_SECS);
        entry.backoff_until_ms = (secs > 0).then(|| now_ms + secs as i64 * 1000);
        state.buckets.insert(key.to_string(), entry);
        self.save(&state);
        secs
    }

    /// Replace the file atomically (a temp file renamed over it). A failed write is logged; the
    /// search goes on.
    fn save(&self, state: &RateState) {
        let write = || -> std::io::Result<()> {
            let bytes = serde_json::to_vec(state)?;
            codesense_platform::fs::atomic_replace(&self.path, &bytes)?;
            Ok(())
        };
        if let Err(e) = write() {
            log::warn!(target: "gif", "gif search: the rate limit could not be saved: {e}");
        }
    }
}

/// A 429's backoff in seconds from its `Retry-After`: delta-seconds or an HTTP-date, clamped to
/// 0 to 24 h; 15 minutes when it is absent or unreadable.
pub(crate) fn retry_after_secs(value: Option<&str>, now_ms: i64) -> u64 {
    let value = match value.map(str::trim) {
        None | Some("") => return DEFAULT_BACKOFF_SECS,
        Some(value) => value,
    };
    if !value.contains(|c: char| !c.is_ascii_digit()) {
        return value
            .parse::<u64>()
            .unwrap_or(MAX_BACKOFF_SECS)
            .min(MAX_BACKOFF_SECS);
    }
    match chrono::DateTime::parse_from_rfc2822(value) {
        Ok(date) => secs_until(date.timestamp_millis(), now_ms).min(MAX_BACKOFF_SECS),
        Err(_) => DEFAULT_BACKOFF_SECS,
    }
}

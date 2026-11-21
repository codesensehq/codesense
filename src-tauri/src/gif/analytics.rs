// SPDX-License-Identifier: MIT
//! The pingback URLs each search returned (GIPHY's `analytics`), with the GIF's URLs, held in
//! memory for an hour by provider and GIF id, so a later send of that GIF can register it. At
//! most [`MAX_ENTRIES`] are held; the oldest go first.
use super::{Found, Pingbacks, Provider};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

/// How long an entry is held.
pub(crate) const TTL_MS: i64 = 60 * 60 * 1000;
/// The most entries held.
pub(crate) const MAX_ENTRIES: usize = 2000;

type Key = (Provider, String);

/// What a search returned for one GIF: the URLs a send of it must use to register, and its
/// pingbacks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub url: String,
    pub preview_url: String,
    pub pingbacks: Pingbacks,
}
impl Entry {
    /// `url` is one this search returned for the GIF, so a send of it is this GIF.
    pub(crate) fn binds(&self, url: &str) -> bool {
        self.url == url || self.preview_url == url
    }
}

struct Held {
    entries: HashMap<Key, (i64, Entry)>,
    /// Keys in the order they were recorded, oldest first; a key recorded again moves to the end.
    order: VecDeque<Key>,
    /// The install epoch the entries belong to.
    epoch: u64,
}

pub(crate) struct Analytics {
    held: Mutex<Held>,
}

impl Analytics {
    pub(crate) fn new() -> Self {
        Self {
            held: std::sync::Mutex::new(Held {
                entries: HashMap::new(),
                order: VecDeque::new(),
                epoch: 0,
            }),
        }
    }

    /// Drop every entry held for an earlier install epoch (search was turned Off, or the key
    /// removed or replaced), so a new install id never registers a GIF found under the old one.
    pub(crate) fn start_epoch(&self, epoch: u64) {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        if held.epoch != epoch {
            held.epoch = epoch;
            held.entries.clear();
            held.order.clear();
        }
    }

    /// Hold each found GIF's pingbacks until an hour from `now_ms`, dropping expired entries and
    /// then the oldest past the cap.
    pub(crate) fn record(&self, provider: Provider, found: &[Found], now_ms: i64) {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let Held { entries, order, .. } = &mut *held;
        for f in found {
            if let Some(pingbacks) = &f.pingbacks {
                let key = (provider, f.candidate.id.clone());
                let entry = Entry {
                    url: f.candidate.url.clone(),
                    preview_url: f.candidate.preview_url.clone(),
                    pingbacks: pingbacks.clone(),
                };
                if entries
                    .insert(key.clone(), (now_ms + TTL_MS, entry))
                    .is_some()
                {
                    VecDeque::retain(order, |k| *k != key);
                }
                order.push_back(key);
            }
        }
        while let Some(oldest) = order.front() {
            let expired = entries
                .get(oldest)
                .is_none_or(|(expires, _)| *expires <= now_ms);
            if !expired && order.len() <= MAX_ENTRIES {
                break;
            }
            if let Some(key) = order.pop_front() {
                entries.remove(&key);
            }
        }
    }

    /// What a search within the last hour returned for this GIF.
    pub(crate) fn held_entry(&self, provider: Provider, id: &str, now_ms: i64) -> Option<Entry> {
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        match held.entries.get(&(provider, id.to_string())) {
            Some((expires, entry)) if *expires > now_ms => Some(entry.clone()),
            _ => None,
        }
    }

    /// The pingbacks a search within the last hour returned for this GIF.
    #[cfg(test)]
    pub(crate) fn pingbacks_for(
        &self,
        provider: Provider,
        id: &str,
        now_ms: i64,
    ) -> Option<Pingbacks> {
        self.held_entry(provider, id, now_ms).map(|e| e.pingbacks)
    }

    #[cfg(test)]
    pub(crate) fn held_count(&self) -> usize {
        self.held.lock().unwrap().entries.len()
    }
}

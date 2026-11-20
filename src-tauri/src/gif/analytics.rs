// SPDX-License-Identifier: MIT
//! The pingback URLs each search returned (GIPHY's `analytics`), held in memory for an hour by
//! provider and GIF id, so a later send of that GIF can register it. At most [`MAX_ENTRIES`] are
//! held; the oldest go first.
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

struct Held {
    entries: HashMap<Key, (i64, Pingbacks)>,
    /// Keys in the order they were recorded, oldest first; a key recorded again moves to the end.
    order: VecDeque<Key>,
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
            }),
        }
    }

    /// Hold each found GIF's pingbacks until an hour from `now_ms`, dropping expired entries and
    /// then the oldest past the cap.
    pub(crate) fn record(&self, provider: Provider, found: &[Found], now_ms: i64) {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let Held { entries, order } = &mut *held;
        for f in found {
            if let Some(pingbacks) = &f.pingbacks {
                let key = (provider, f.candidate.id.clone());
                if entries
                    .insert(key.clone(), (now_ms + TTL_MS, pingbacks.clone()))
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

    /// The pingbacks a search within the last hour returned for this GIF.
    // Read by the send path that registers a provider GIF; tests read it now.
    #[allow(dead_code)]
    pub(crate) fn pingbacks_for(
        &self,
        provider: Provider,
        id: &str,
        now_ms: i64,
    ) -> Option<Pingbacks> {
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        match held.entries.get(&(provider, id.to_string())) {
            Some((expires, pingbacks)) if *expires > now_ms => Some(pingbacks.clone()),
            _ => None,
        }
    }

    #[cfg(test)]
    pub(crate) fn held_count(&self) -> usize {
        self.held.lock().unwrap().entries.len()
    }
}

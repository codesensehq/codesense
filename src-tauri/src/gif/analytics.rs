// SPDX-License-Identifier: MIT
//! The provider analytics data each search returned (GIPHY's pingback URLs), held in memory for
//! an hour by provider and GIF id, so a later send of that GIF can register it.
use super::{Found, Provider};
use std::{collections::HashMap, sync::Mutex};

/// How long an entry is held.
pub(crate) const TTL_MS: i64 = 60 * 60 * 1000;

pub(crate) struct Analytics {
    entries: Mutex<HashMap<(Provider, String), (i64, serde_json::Value)>>,
}

impl Analytics {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Hold each found GIF's analytics data until an hour from `now_ms`, and drop expired ones.
    pub(crate) fn record(&self, provider: Provider, found: &[Found], now_ms: i64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let live = std::mem::take(&mut *entries)
            .into_iter()
            .filter(|(_, (expires, _))| *expires > now_ms);
        *entries = live.collect();
        for f in found {
            if let Some(data) = &f.analytics {
                entries.insert(
                    (provider, f.candidate.id.clone()),
                    (now_ms + TTL_MS, data.clone()),
                );
            }
        }
    }

    /// The analytics data a search within the last hour returned for this GIF.
    // Read by the send path that registers a provider GIF; tests read it now.
    #[allow(dead_code)]
    pub(crate) fn get(
        &self,
        provider: Provider,
        id: &str,
        now_ms: i64,
    ) -> Option<serde_json::Value> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries
            .get(&(provider, id.to_string()))
            .filter(|(expires, _)| *expires > now_ms)
            .map(|(_, data)| data.clone())
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

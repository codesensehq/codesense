// SPDX-License-Identifier: MIT
//! Kept answers for the config reads hot paths repeat: the synced teams, a team's role
//! configs and its media policy. Each entry is kept with the stamp (size and modified
//! time) of every file and folder its read depends on, taken before the read.
//!
//! The rules are [`team_resolution_cache`](super::team_resolution_cache)'s. A read
//! within [`MAX_AGE`] of an entry's last check is answered from memory, with no file
//! I/O. The first read after that window re-stamps the entry, which costs only stats,
//! and reloads it only when the stamp moved. The app events in [`INVALIDATING_EVENTS`]
//! drop every entry, and each cache's own writer drops its entries (`role_save`, a
//! noted `config/inbox.yml`). A change no event reports shows within [`MAX_AGE`].
//!
//! The caches are process-wide statics. App setup arms them ([`arm`], called beside
//! `team_resolution_cache::listen`). Until then every read loads, so unit tests that
//! never start the app see their own file edits at once.
//!
//! [`INVALIDATING_EVENTS`]: super::team_resolution_cache::INVALIDATING_EVENTS

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Instant, SystemTime};

use super::team_resolution_cache::MAX_AGE;

static ARMED: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
thread_local! {
    static ARMED_HERE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Turn the caches on for the app. Called once from app setup.
pub(crate) fn arm() {
    ARMED.store(true, Ordering::Relaxed);
}

/// Turn the caches on for reads made on this test's thread, until the guard drops, so
/// other tests keep reading through.
#[cfg(test)]
#[must_use]
pub(crate) fn arm_this_thread() -> ArmedHere {
    ARMED_HERE.with(|armed| armed.set(true));
    ArmedHere
}

#[cfg(test)]
pub(crate) struct ArmedHere;

#[cfg(test)]
impl Drop for ArmedHere {
    fn drop(&mut self) {
        ARMED_HERE.with(|armed| armed.set(false));
    }
}

fn armed() -> bool {
    #[cfg(test)]
    if ARMED_HERE.with(std::cell::Cell::get) {
        return true;
    }
    ARMED.load(Ordering::Relaxed)
}

/// Drop every config cache's entries. Called on each of the invalidating events.
pub(crate) fn invalidate_all() {
    super::route_to_context::SYNCED_CONTEXTS.invalidate();
    crate::queue_roles::ROLE_CONFIGS.invalidate();
    crate::media::CONFIGS.invalidate();
}

/// One file or folder as stat'ed. A missing one stamps as `None`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    dir: bool,
}

pub(crate) fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = Result::ok(std::fs::metadata(path))?;
    Some(FileStamp {
        len: meta.len(),
        // A path call, so the explicit-sync guard resolves it (see `team_resolution_cache`).
        modified: Result::ok(meta.modified()),
        dir: meta.is_dir(),
    })
}

/// The folder's own stamp and each entry's, by name. A folder that can't be listed
/// stamps as empty.
pub(crate) fn dir_stamp(dir: &Path) -> (Option<FileStamp>, Vec<(OsString, Option<FileStamp>)>) {
    let mut entries: Vec<_> = Result::ok(std::fs::read_dir(dir))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| (entry.file_name(), file_stamp(&entry.path())))
        .collect();
    entries.sort();
    (file_stamp(dir), entries)
}

struct Entry<S, V> {
    value: V,
    stamp: S,
    /// When the stamp was last found unchanged; `None` re-stamps on the next read.
    checked: Option<Instant>,
}

struct Inner<K, S, V> {
    /// Bumped by every invalidation, so a load that raced one doesn't store.
    generation: u64,
    entries: BTreeMap<K, Entry<S, V>>,
    #[cfg(test)]
    reads: BTreeMap<K, Reads>,
}

/// What reads of one key did, for tests.
#[cfg(test)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Reads {
    pub stamps: usize,
    pub loads: usize,
}

/// One kept read: `K` names what was read, `S` is its stamp, `V` the answer.
pub(crate) struct ConfigCache<K, S, V> {
    inner: Mutex<Inner<K, S, V>>,
}

impl<K: Ord + Clone, S: PartialEq + Clone, V: Clone> ConfigCache<K, S, V> {
    pub(crate) const fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                generation: 0,
                entries: BTreeMap::new(),
                #[cfg(test)]
                reads: BTreeMap::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<K, S, V>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drop every entry; the next read of each key loads it again. Unarmed, reads
    /// keep nothing, so there is nothing to drop (and a test's writes on one thread
    /// leave another thread's armed entries alone).
    pub(crate) fn invalidate(&self) {
        if !armed() {
            return;
        }
        let mut inner = self.lock();
        inner.generation += 1;
        inner.entries.clear();
    }

    /// `key`'s answer: kept, or `load`ed. `stamp` stats what `load` reads; it runs
    /// before each load and once per [`MAX_AGE`] window for a kept entry. A failed load
    /// is not kept. Blocking: callers on the async runtime run it on the blocking pool.
    pub(crate) fn get<E>(
        &self,
        key: &K,
        stamp: impl Fn() -> S,
        load: impl FnOnce() -> Result<V, E>,
    ) -> Result<V, E> {
        if !armed() {
            return load();
        }
        let now = Instant::now();
        let (generation, kept) = {
            let inner = self.lock();
            match inner.entries.get(key) {
                Some(e) if e.checked.is_some_and(|at| now.duration_since(at) < MAX_AGE) => {
                    return Ok(e.value.clone());
                }
                Some(e) => (inner.generation, Some((e.stamp.clone(), e.value.clone()))),
                None => (inner.generation, None),
            }
        };
        #[cfg(test)]
        {
            self.lock().reads.entry(key.clone()).or_default().stamps += 1;
        }
        let fresh = stamp();
        if let Some((_, value)) = kept.filter(|(before, _)| *before == fresh) {
            let mut inner = self.lock();
            // An invalidation during the stat may mean the kept answer is wrong: load.
            if inner.generation == generation {
                if let Some(e) = inner.entries.get_mut(key) {
                    e.checked = Some(now);
                }
                return Ok(value);
            }
        }
        #[cfg(test)]
        {
            self.lock().reads.entry(key.clone()).or_default().loads += 1;
        }
        let value = load()?;
        let mut inner = self.lock();
        if inner.generation == generation {
            inner.entries.insert(
                key.clone(),
                Entry {
                    value: value.clone(),
                    stamp: fresh,
                    checked: Some(now),
                },
            );
        }
        Ok(value)
    }

    /// What reads of `key` did so far.
    #[cfg(test)]
    pub(crate) fn reads(&self, key: &K) -> Reads {
        self.lock().reads.get(key).copied().unwrap_or_default()
    }

    /// Close every entry's window, as [`MAX_AGE`] passing would.
    #[cfg(test)]
    pub(crate) fn expire(&self) {
        for e in self.lock().entries.values_mut() {
            e.checked = None;
        }
    }
}

#[cfg(test)]
mod tests;

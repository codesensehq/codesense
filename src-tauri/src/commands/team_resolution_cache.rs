// SPDX-License-Identifier: MIT
//! A cache of `(principal, org, team) → ContextResolution` for the inbox and roles
//! reads, which resolve each team they touch on every pass. Without it every read
//! parses the org's registry files and stats the team's content folder on the
//! blocking pool.
//!
//! A hit is a map lookup: no blocking-pool task and no file I/O. `Ok` and `NotSynced`
//! are kept until something moves; `Unauthorized` is kept only until the next
//! re-stamp, since a failed registry read gives the same answer. Entries are dropped
//! by the app events that report a registry, attachment or git change. Changes no
//! event reports (a hand edit, a folder made in a terminal, a pull in an org whose git
//! isn't watched) are caught by one re-stamp per [`MAX_AGE`] window: the first read
//! after the window stats every cached team's registry files and content folder in a
//! single blocking task and drops the entries whose stamp moved, and the reads after
//! it are hits again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use tauri::AppHandle;

use super::route_to_context::{resolve_ambient, resolve_local, ContextResolution};
use crate::domain::Principal;

/// The app events after which a cached resolution may be wrong: a registry edit made
/// in the app, an org attached or detached, and git moving a context repo (a pull,
/// checkout or merge that rewrote `teams.yml` or a content folder). Content edits
/// (`context-index-changed`) are left out: they can't move the registry, and a
/// content folder appearing or going is caught by the stamp within [`MAX_AGE`].
pub(crate) const INVALIDATING_EVENTS: &[&str] = &[
    crate::commands::registry_local::ORG_REGISTRY_CHANGED_EVENT,
    crate::commands::context_attachments::CONTEXT_ATTACHMENTS_CHANGED_EVENT,
    crate::commands::context_git_watch::CONTEXT_GIT_MOVED_EVENT,
];

/// The re-stamp window: the longest a change no event reports goes unseen. Steady
/// state costs one blocking task per window, however many teams are cached.
pub(crate) const MAX_AGE: Duration = Duration::from_secs(2);

/// The registry files a resolution is read from (see `domain::load_org`).
const REGISTRY_FILES: [&str; 3] = ["org.yml", "people.yml", "teams.yml"];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    user_id: u64,
    org: String,
    team: String,
}

/// One registry file as stat'ed: its size and modified time.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
}

/// What a resolution depends on: the org's registry files (`None` when absent) and
/// whether the team's content folder exists.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Stamp {
    registry: Vec<Option<FileStamp>>,
    content_dir: bool,
}

/// Stat what [`resolve_local`] reads for `(org, team)`. An org slug it would refuse
/// stamps as empty: that answer is `Unauthorized` whatever is on disk.
fn stamp(home: &Path, user_id: u64, org: &str, team: &str) -> Stamp {
    if crate::context_repo::org_slug::validate_org_slug(org).is_some() {
        return Stamp::default();
    }
    let Ok(org_root) = crate::context_repo::path_to_org_root(home, &Principal::from(user_id), org)
    else {
        return Stamp::default();
    };
    let registry = REGISTRY_FILES
        .iter()
        .map(|name| {
            let Ok(meta) = std::fs::metadata(org_root.join(name)) else {
                return None;
            };
            // A path call: the explicit-sync guard can't tell `.ok()` on an
            // inferred value from the crate's own `ok` methods.
            Some(FileStamp {
                len: meta.len(),
                modified: Result::ok(meta.modified()),
            })
        })
        .collect();
    // `team` is the caller's: it names a folder only as one plain path segment. Any
    // other name matches no registry team, so its folder can't change the answer.
    let one_segment = !matches!(team, "" | "." | "..") && !team.contains(['/', '\\']);
    let content_dir =
        one_segment && crate::context_repo::path_to_team_content_dir(&org_root, team).is_dir();
    Stamp {
        registry,
        content_dir,
    }
}

/// What a fill reads under the CodeSense `home`. The app reads the disk; tests count
/// the reads.
pub(crate) trait Disk: Send + Sync + 'static {
    fn stamp(&self, home: &Path, user_id: u64, org: &str, team: &str) -> Stamp;
    fn resolve(&self, home: &Path, user_id: u64, org: &str, team: &str) -> ContextResolution;
}

/// The disk.
pub(crate) struct LocalDisk;

impl Disk for LocalDisk {
    fn stamp(&self, home: &Path, user_id: u64, org: &str, team: &str) -> Stamp {
        stamp(home, user_id, org, team)
    }
    fn resolve(&self, home: &Path, user_id: u64, org: &str, team: &str) -> ContextResolution {
        resolve_local(
            home.to_path_buf(),
            user_id,
            org.to_string(),
            team.to_string(),
        )
    }
}

/// Where the cache reads the time; tests move it by hand.
pub(crate) type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

struct Entry {
    resolution: ContextResolution,
    stamp: Stamp,
    home: PathBuf,
}

struct Inner {
    /// Bumped by every invalidation, so a fill or re-stamp that raced one doesn't store.
    generation: u64,
    entries: HashMap<Key, Entry>,
    /// When the current re-stamp window opened.
    window: Instant,
    /// A re-stamp is running; no other starts until it ends and opens the next window.
    restamping: bool,
    /// Bumped by every window claim, so a fill that straddles one doesn't store: the
    /// re-stamp it straddled didn't see it.
    claims: u64,
}

/// One entry as a re-stamp sees it: `None` for an `Unauthorized` entry, which is
/// dropped without a stat (a failed registry read gives the same answer, so it is
/// never kept past a window; that also bounds entries for names callers made up).
type Restamp = (Key, PathBuf, Option<Stamp>);

/// The app's resolution cache, managed as Tauri state.
#[derive(Clone)]
pub(crate) struct TeamResolutionCache {
    inner: Arc<Mutex<Inner>>,
    disk: Arc<dyn Disk>,
    clock: Clock,
    #[cfg(test)]
    restamps: Arc<std::sync::atomic::AtomicUsize>,
}

/// Ends a re-stamp, even one that panicked, and opens the next window.
struct RestampEnd<'a>(&'a TeamResolutionCache);

impl Drop for RestampEnd<'_> {
    fn drop(&mut self) {
        let now = (self.0.clock)();
        let mut inner = self.0.lock();
        inner.restamping = false;
        inner.window = now;
    }
}

impl Default for TeamResolutionCache {
    fn default() -> Self {
        Self::with_disk(Arc::new(LocalDisk), Arc::new(Instant::now))
    }
}

impl TeamResolutionCache {
    pub(crate) fn with_disk(disk: Arc<dyn Disk>, clock: Clock) -> Self {
        let window = clock();
        Self {
            inner: Arc::new(Mutex::new(Inner {
                generation: 0,
                entries: HashMap::new(),
                window,
                restamping: false,
                claims: 0,
            })),
            disk,
            clock,
            #[cfg(test)]
            restamps: Arc::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drop every entry; the next read of each team resolves it again.
    pub(crate) fn invalidate(&self) {
        let mut inner = self.lock();
        inner.generation += 1;
        inner.entries.clear();
    }

    /// Resolve `(org, team)` for `user_id` under `home`. A cached entry is answered from
    /// memory. The first read after the window closes re-stamps every entry first; a
    /// missing entry is filled. Both run on the blocking pool.
    pub(crate) async fn resolve(
        &self,
        home: PathBuf,
        user_id: u64,
        org: &str,
        team: &str,
    ) -> Result<ContextResolution, String> {
        let key = Key {
            user_id,
            org: org.to_string(),
            team: team.to_string(),
        };
        if let Some((generation, batch)) = self.claim_window() {
            let cache = self.clone();
            super::await_blocking("team_resolution_restamp", move || {
                cache.restamp(generation, batch);
                Ok(())
            })
            .await?;
        }
        let hit = self.lock().entries.get(&key).map(|e| e.resolution.clone());
        if let Some(hit) = hit {
            return Ok(hit);
        }
        let cache = self.clone();
        super::await_blocking("team_resolution_fill", move || Ok(cache.fill(home, key))).await
    }

    /// When the window has closed and no re-stamp is running, claim it and take the
    /// entries to re-stamp. Reads that arrive while the re-stamp runs answer from the
    /// entries as they are.
    fn claim_window(&self) -> Option<(u64, Vec<Restamp>)> {
        let now = (self.clock)();
        let mut inner = self.lock();
        if inner.restamping || now.saturating_duration_since(inner.window) < MAX_AGE {
            return None;
        }
        inner.claims += 1;
        // A path call, so the explicit-sync guard resolves it (see `stamp`).
        if HashMap::is_empty(&inner.entries) {
            inner.window = now;
            return None;
        }
        inner.restamping = true;
        let batch = inner
            .entries
            .iter()
            .map(|(key, e)| {
                let stamp = (!matches!(e.resolution, ContextResolution::Unauthorized))
                    .then(|| e.stamp.clone());
                (key.clone(), e.home.clone(), stamp)
            })
            .collect();
        Some((inner.generation, batch))
    }

    /// Stat every entry in `batch` and drop those whose stamp moved. Blocking.
    fn restamp(&self, generation: u64, batch: Vec<Restamp>) {
        let _end = RestampEnd(self);
        #[cfg(test)]
        self.restamps
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let moved: Vec<(Key, Option<Stamp>)> = batch
            .into_iter()
            .filter_map(|(key, home, before)| {
                let unchanged = before.as_ref().is_some_and(|before| {
                    *before == self.disk.stamp(&home, key.user_id, &key.org, &key.team)
                });
                (!unchanged).then_some((key, before))
            })
            .collect();
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        for (key, before) in moved {
            // Leave an entry a fill replaced since the batch was taken.
            let same = inner.entries.get(&key).is_some_and(|e| match &before {
                Some(before) => e.stamp == *before,
                None => matches!(e.resolution, ContextResolution::Unauthorized),
            });
            if same {
                inner.entries.remove(&key);
            }
        }
    }

    /// Stamp the team's files and resolve it. Blocking.
    fn fill(&self, home: PathBuf, key: Key) -> ContextResolution {
        let started = {
            let inner = self.lock();
            (inner.generation, inner.claims)
        };
        let stamp = self.disk.stamp(&home, key.user_id, &key.org, &key.team);
        let resolution = self.disk.resolve(&home, key.user_id, &key.org, &key.team);
        let mut inner = self.lock();
        // An invalidation during the read may mean it saw the old files, and a window
        // claimed during it re-stamped without this entry: answer, but don't keep it.
        if (inner.generation, inner.claims) == started {
            inner.entries.insert(
                key,
                Entry {
                    resolution: resolution.clone(),
                    stamp,
                    home,
                },
            );
        }
        resolution
    }
}

/// [`derive_context_for`](super::route_to_context::derive_context_for), answered from
/// the app's cache.
pub(crate) async fn derive_context_cached<R: tauri::Runtime>(
    app: &AppHandle<R>,
    org: &str,
    team: &str,
) -> Result<ContextResolution, String> {
    use tauri::Manager;
    let cache: &TeamResolutionCache = app
        .try_state::<TeamResolutionCache>()
        .ok_or("team resolution cache unavailable")?
        .inner();
    let (home, user_id) = resolve_ambient(app).await?;
    cache.resolve(home, user_id, org, team).await
}

/// Drop the app's cached resolutions on each of [`INVALIDATING_EVENTS`].
pub(crate) fn listen<R: tauri::Runtime>(app: &AppHandle<R>) {
    use tauri::{Listener, Manager};
    let Some(cache) = app.try_state::<TeamResolutionCache>() else {
        return;
    };
    for event in INVALIDATING_EVENTS {
        let cache: TeamResolutionCache = cache.inner().clone();
        app.listen(*event, move |_| cache.invalidate());
    }
}

#[cfg(test)]
mod tests;

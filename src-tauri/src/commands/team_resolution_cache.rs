// SPDX-License-Identifier: MIT
//! A cache of `(principal, org, team) → ContextResolution` for the inbox and roles
//! reads, which resolve each team they touch on every pass. Without it every read
//! parses the org's registry files and stats the team's content folder on the
//! blocking pool.
//!
//! A hit is a map lookup: no blocking-pool task and no file I/O. Every result is kept,
//! `Unauthorized` and `NotSynced` included. Entries are dropped by the app events that
//! report a registry, attachment, index or git change. An entry no event has dropped
//! is trusted for [`MAX_AGE`]; after that the next read stats the registry files and
//! the content folder and parses the registry again only when that stamp moved, so a
//! change no event reports (a hand edit, a folder made in a terminal) still shows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use tauri::AppHandle;

use super::route_to_context::{resolve_ambient, resolve_local, ContextResolution};
use crate::domain::Principal;

/// The app events after which a cached resolution may be wrong: a registry edit made
/// in the app, an org attached or detached, an indexed content change, and git moving
/// a context repo (a pull, checkout or merge that rewrote `teams.yml` or a content
/// folder).
pub(crate) const INVALIDATING_EVENTS: &[&str] = &[
    crate::commands::registry_local::ORG_REGISTRY_CHANGED_EVENT,
    "context-attachments-changed",
    crate::context_query::service::CHANGE_EVENT,
    crate::commands::context_git_watch::CONTEXT_GIT_MOVED_EVENT,
];

/// How long an entry is trusted without being re-stamped.
pub(crate) const MAX_AGE: Duration = Duration::from_secs(30);

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
            let meta = std::fs::metadata(org_root.join(name)).ok()?;
            Some(FileStamp {
                len: meta.len(),
                modified: meta.modified().ok(),
            })
        })
        .collect();
    // `team` is the caller's: it names a folder only as one plain path segment. Any
    // other name matches no registry team, so its folder can't change the answer.
    let one_segment =
        !team.is_empty() && team != "." && team != ".." && !team.contains(['/', '\\']);
    let content_dir =
        one_segment && crate::context_repo::path_to_team_content_dir(&org_root, team).is_dir();
    Stamp {
        registry,
        content_dir,
    }
}

/// What a fill reads. The app reads the disk; tests count the reads.
pub(crate) trait Disk: Send + 'static {
    fn stamp(&self, user_id: u64, org: &str, team: &str) -> Stamp;
    fn resolve(&self, user_id: u64, org: &str, team: &str) -> ContextResolution;
}

/// The disk under the CodeSense home.
pub(crate) struct LocalDisk {
    pub home: PathBuf,
}

impl Disk for LocalDisk {
    fn stamp(&self, user_id: u64, org: &str, team: &str) -> Stamp {
        stamp(&self.home, user_id, org, team)
    }
    fn resolve(&self, user_id: u64, org: &str, team: &str) -> ContextResolution {
        resolve_local(
            self.home.clone(),
            user_id,
            org.to_string(),
            team.to_string(),
        )
    }
}

struct Entry {
    resolution: ContextResolution,
    stamp: Stamp,
    checked_at: Instant,
}

#[derive(Default)]
struct Inner {
    /// Bumped by every invalidation, so a fill that raced one doesn't store.
    generation: u64,
    entries: HashMap<Key, Entry>,
}

/// The app's resolution cache, managed as Tauri state.
#[derive(Clone)]
pub(crate) struct TeamResolutionCache {
    inner: Arc<Mutex<Inner>>,
    max_age: Duration,
}

impl Default for TeamResolutionCache {
    fn default() -> Self {
        Self::with_max_age(MAX_AGE)
    }
}

impl TeamResolutionCache {
    pub(crate) fn with_max_age(max_age: Duration) -> Self {
        Self {
            inner: Arc::default(),
            max_age,
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

    /// A trusted entry's resolution, from memory only.
    fn fresh(&self, key: &Key) -> Option<ContextResolution> {
        let inner = self.lock();
        let entry = inner.entries.get(key)?;
        (entry.checked_at.elapsed() < self.max_age).then(|| entry.resolution.clone())
    }

    /// Resolve `(org, team)` for `user_id`: a trusted entry is answered from memory;
    /// anything else is filled from `disk` on the blocking pool.
    pub(crate) async fn resolve(
        &self,
        disk: impl Disk,
        user_id: u64,
        org: &str,
        team: &str,
    ) -> Result<ContextResolution, String> {
        let key = Key {
            user_id,
            org: org.to_string(),
            team: team.to_string(),
        };
        if let Some(hit) = self.fresh(&key) {
            return Ok(hit);
        }
        let cache = self.clone();
        // The same label as `derive_context_for`, so its blocking rate counts fills.
        super::await_blocking("derive_context_for", move || Ok(cache.fill(&disk, key))).await
    }

    /// Stamp the team's files, reuse the entry's resolution when the stamp hasn't
    /// moved, and resolve again when it has (or there is no entry). Blocking.
    fn fill(&self, disk: &impl Disk, key: Key) -> ContextResolution {
        let (generation, previous) = {
            let inner = self.lock();
            let previous = inner
                .entries
                .get(&key)
                .map(|e| (e.stamp.clone(), e.resolution.clone()));
            (inner.generation, previous)
        };
        let stamp = disk.stamp(key.user_id, &key.org, &key.team);
        let resolution = match previous {
            Some((before, resolution)) if before == stamp => resolution,
            _ => disk.resolve(key.user_id, &key.org, &key.team),
        };
        let mut inner = self.lock();
        // An invalidation during the read may mean it saw the old files: answer, but
        // don't keep it.
        if inner.generation == generation {
            inner.entries.insert(
                key,
                Entry {
                    resolution: resolution.clone(),
                    stamp,
                    checked_at: Instant::now(),
                },
            );
        }
        resolution
    }
}

/// [`derive_context_for`](super::route_to_context::derive_context_for), answered from
/// the app's cache when it is installed.
pub(crate) async fn derive_context_cached<R: tauri::Runtime>(
    app: &AppHandle<R>,
    org: &str,
    team: &str,
) -> Result<ContextResolution, String> {
    use tauri::Manager;
    let Some(cache) = app.try_state::<TeamResolutionCache>() else {
        return super::route_to_context::derive_context_for(app, org, team).await;
    };
    let (home, user_id) = resolve_ambient(app).await?;
    cache.resolve(LocalDisk { home }, user_id, org, team).await
}

/// Drop the app's cached resolutions on each of [`INVALIDATING_EVENTS`].
pub(crate) fn listen<R: tauri::Runtime>(app: &AppHandle<R>) {
    use tauri::{Listener, Manager};
    let Some(cache) = app.try_state::<TeamResolutionCache>() else {
        return;
    };
    for event in INVALIDATING_EVENTS {
        let cache = cache.inner().clone();
        app.listen(*event, move |_| cache.invalidate());
    }
}

#[cfg(test)]
mod tests;

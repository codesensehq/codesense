// SPDX-License-Identifier: MIT
//! A cache of `(principal, org, team) → ContextResolution` for the inbox and roles
//! reads, which resolve each team they touch on every pass. Without it every read
//! parses the org's registry files and stats the team's content folder on the
//! blocking pool.
//!
//! A hit is a map lookup: no blocking-pool task and no file I/O. Every result is kept,
//! `Unauthorized` and `NotSynced` included. Entries are dropped by the app events that
//! report a registry, attachment or git change. An entry no event has dropped is
//! trusted for [`MAX_AGE`]; after that the next read stats the registry files and the
//! content folder and parses the registry again only when that stamp moved, so a
//! change no event reports (a hand edit, a folder made in a terminal, a pull in an
//! org whose git isn't watched) shows within [`MAX_AGE`].

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

/// How long an entry is trusted without being re-stamped: the longest a change no
/// event reports goes unseen. One re-stamp per team per window stays far below the
/// per-call rate this cache replaces.
pub(crate) const MAX_AGE: Duration = Duration::from_secs(2);

/// Past this many entries, a fill drops the expired ones. Callers can name any team,
/// so the map would otherwise grow until the next event.
const PRUNE_ABOVE: usize = 256;

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
    checked_at: Instant,
}

#[derive(Default)]
struct Inner {
    /// Bumped by every invalidation, so a fill that raced one doesn't store.
    generation: u64,
    entries: HashMap<Key, Entry>,
}

fn trusted(entry: &Entry, now: Instant) -> bool {
    now.saturating_duration_since(entry.checked_at) < MAX_AGE
}

/// The app's resolution cache, managed as Tauri state.
#[derive(Clone)]
pub(crate) struct TeamResolutionCache {
    inner: Arc<Mutex<Inner>>,
    disk: Arc<dyn Disk>,
    clock: Clock,
}

impl Default for TeamResolutionCache {
    fn default() -> Self {
        Self::with(Arc::new(LocalDisk), Arc::new(Instant::now))
    }
}

impl TeamResolutionCache {
    pub(crate) fn with(disk: Arc<dyn Disk>, clock: Clock) -> Self {
        Self {
            inner: Arc::default(),
            disk,
            clock,
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
        let now = (self.clock)();
        let inner = self.lock();
        let entry = inner.entries.get(key)?;
        trusted(entry, now).then(|| entry.resolution.clone())
    }

    /// Resolve `(org, team)` for `user_id` under `home`: a trusted entry is answered
    /// from memory; anything else is filled from the disk on the blocking pool.
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
        if let Some(hit) = self.fresh(&key) {
            return Ok(hit);
        }
        let cache = self.clone();
        // The same label as `derive_context_for`, so its blocking rate counts fills.
        super::await_blocking("derive_context_for", move || Ok(cache.fill(&home, key))).await
    }

    /// Stamp the team's files, reuse the entry's resolution when the stamp hasn't
    /// moved, and resolve again when it has (or there is no entry). Blocking.
    fn fill(&self, home: &Path, key: Key) -> ContextResolution {
        let (generation, previous) = {
            let inner = self.lock();
            let previous = inner
                .entries
                .get(&key)
                .map(|e| (e.stamp.clone(), e.resolution.clone()));
            (inner.generation, previous)
        };
        let stamp = self.disk.stamp(home, key.user_id, &key.org, &key.team);
        let resolution = match previous {
            // `Unauthorized` is also what a failed registry read gives, so it is
            // always read again rather than kept on an unchanged stamp.
            Some((before, resolution))
                if before == stamp && !matches!(resolution, ContextResolution::Unauthorized) =>
            {
                resolution
            }
            _ => self.disk.resolve(home, key.user_id, &key.org, &key.team),
        };
        let now = (self.clock)();
        let mut inner = self.lock();
        // An invalidation during the read may mean it saw the old files: answer, but
        // don't keep it.
        if inner.generation == generation {
            if inner.entries.len() >= PRUNE_ABOVE {
                inner.entries.retain(|_, e| trusted(e, now));
            }
            inner.entries.insert(
                key,
                Entry {
                    resolution: resolution.clone(),
                    stamp,
                    checked_at: now,
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
    let cache = app
        .try_state::<TeamResolutionCache>()
        .ok_or("team resolution cache unavailable")?;
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
        let cache = cache.inner().clone();
        app.listen(*event, move |_| cache.invalidate());
    }
}

#[cfg(test)]
mod tests;

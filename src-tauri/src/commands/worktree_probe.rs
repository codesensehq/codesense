// SPDX-License-Identifier: MIT
//! Bounded, cached git reads for the worktree listing.
//!
//! The Worktrees panel reads a branch, a dirty flag and the parent clone for every worktree, and
//! the clones' worktree lists. Each read used to be an unbounded `git` child, so one worktree
//! under a cargo build could hold the whole listing for minutes. A read here runs as
//! `git --no-optional-locks …` (a status that only looks never takes the index lock a build's own
//! git needs) through the shared spawn-and-timeout primitive, and a read that outlives its timeout
//! is killed, its own child only, and reported as [`Git::TimedOut`].
//!
//! These helpers are the listing's only. The teardown gate, the run-launch branch check and the
//! clone watch set read git through the unbounded originals in `worktree.rs`, because a slow
//! answer there must not read as "no branch", "clean" or "not a clone".
//!
//! [`ProbeCache`] keeps what a listing read, so a listing where nothing changed spawns no git at
//! all. An entry is good while its stamp (the mtimes and sizes of the gitdir files that change
//! when the answer does) is what it was; it is dropped by [`ProbeCache::invalidate`], which the
//! existing worktree file watch calls for a changed file (an edit to a tracked file does not touch
//! the index, so the stamp alone would miss it) and the existing clone `worktrees/` watch calls
//! for a worktree added or removed. The worktree facts also expire after [`MAX_AGE`], so a
//! worktree no watch covers (one with no editor open) lags by at most that long; the clone lookup
//! and the clones' worktree lists never expire, because their stamps cover everything that
//! changes them. A read that timed out is never kept, and neither is one an invalidation
//! overtook while it ran. Concurrent readers of one path share one read: the others wait for the
//! first and take its value, kept or not, so a worktree whose git hangs costs one timeout, not
//! one per waiter (a read an invalidation overtook is not shared, and a waiter then reads again).

use crate::shared::proc_capture::{spawn_capture, CaptureRequest};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// How long one probe may run before it is killed and its fact is reported as unknown.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A status's output is only tested for being empty, and a worktree list is a few lines a
/// worktree; a huge untracked tree must not fill memory.
const MAX_OUTPUT: usize = 1024 * 1024;
/// How long a worktree's facts are trusted without a changed stamp or a file event.
const MAX_AGE: Duration = Duration::from_secs(60);

/// The dirty check. Untracked files count as dirty (`normal` is git's default, spelled out so a
/// user's `status.showUntrackedFiles=no` cannot hide them); a submodule's own state does not,
/// which also spares the status a walk into every submodule.
pub(crate) const STATUS_ARGS: [&str; 4] = [
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--ignore-submodules",
];

/// What one bounded git read came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Git {
    /// Exit zero, with its stdout.
    Out(String),
    /// A spawn failure or a non-zero exit.
    Failed,
    /// Killed at its timeout.
    TimedOut,
}

impl Git {
    pub(crate) fn out(self) -> Option<String> {
        match self {
            Git::Out(text) => Some(text),
            Git::Failed | Git::TimedOut => None,
        }
    }
}

/// Run `git --no-optional-locks <args>` in `dir`, bounded by [`PROBE_TIMEOUT`].
pub(crate) fn git(dir: &Path, args: &[&str]) -> Git {
    let (bin, timeout) = binary_and_timeout(dir);
    git_with(&bin, dir, args, timeout)
}

#[cfg(not(test))]
fn binary_and_timeout(_dir: &Path) -> (String, Duration) {
    (super::worktree::git_bin(), PROBE_TIMEOUT)
}

pub(crate) fn git_with(bin: &str, dir: &Path, args: &[&str], timeout: Duration) -> Git {
    #[cfg(test)]
    test_hooks::record_spawn(dir, args);
    let mut argv = vec!["--no-optional-locks".to_owned()];
    argv.extend(args.iter().map(|arg| (*arg).to_owned()));
    let request = CaptureRequest {
        program: PathBuf::from(bin),
        args: argv,
        cwd: Some(dir.to_path_buf()),
        env: Vec::new(),
        env_remove: Vec::new(),
        stdin: None,
        timeout,
        // Our own child only: never a pattern, never a process group.
        process_group: false,
        pid_sink: None,
        output_sink: None,
        last_drain_ms: None,
        cancel: None,
        max_output_bytes: Some(MAX_OUTPUT),
    };
    match spawn_capture(request) {
        Ok(out) if out.timed_out => Git::TimedOut,
        Ok(out) if out.status.is_some_and(|status| status.success()) => {
            // Lossy: a file name that is not UTF-8 must not turn the dirtiest worktree into
            // "unknown".
            Git::Out(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(_) | Err(_) => Git::Failed,
    }
}

/// The facts the listing shows for one worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitFacts {
    pub branch: Option<String>,
    pub dirty: Option<bool>,
    pub repo_path: Option<PathBuf>,
}

/// Read a worktree's facts: one status, and one `rev-parse` that answers both the branch and the
/// parent clone. The second element says whether the answer is complete enough to keep (no probe
/// timed out and the status gave an answer).
fn probe_facts(worktree: &Path) -> (GitFacts, bool) {
    let status = git(worktree, &STATUS_ARGS);
    let dirty = match &status {
        Git::Out(text) => Some(!text.trim().is_empty()),
        Git::Failed | Git::TimedOut => None,
    };
    let rev = git(
        worktree,
        &[
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
            "--path-format=absolute",
            "--git-common-dir",
        ],
    );
    let mut timed_out = status == Git::TimedOut || rev == Git::TimedOut;
    let (branch, common) = match rev {
        Git::Out(text) => {
            let mut lines = text.lines();
            let branch = lines.next().map(str::trim).unwrap_or_default().to_owned();
            let common = lines.next().map(|line| PathBuf::from(line.trim()));
            let branch = (!branch.is_empty() && branch != "HEAD").then_some(branch);
            (branch, common)
        }
        // A repo with no commit has no HEAD to abbreviate, but still has a parent clone.
        Git::Failed => {
            let common = git(
                worktree,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            );
            timed_out |= common == Git::TimedOut;
            (None, common.out().map(|text| PathBuf::from(text.trim())))
        }
        Git::TimedOut => (None, None),
    };
    // `<main>/.git` → `<main>`.
    let repo_path = common.and_then(|dir| dir.parent().map(Path::to_path_buf));
    let facts = GitFacts {
        branch,
        dirty,
        repo_path,
    };
    let keep = !timed_out && facts.dirty.is_some();
    (facts, keep)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct FileStamp(Option<(SystemTime, u64)>);

fn file_stamp(path: &Path) -> FileStamp {
    FileStamp(
        std::fs::metadata(path)
            .ok()
            .and_then(|meta| Some((meta.modified().ok()?, meta.len()))),
    )
}

fn hash_of(parts: &[FileStamp]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut hasher);
    hasher.finish()
}

/// The directory holding a worktree's `HEAD` and `index`: `.git` itself for a main checkout,
/// the `gitdir:` a linked worktree's `.git` file names otherwise.
fn gitdir_of(worktree: &Path) -> Option<PathBuf> {
    let dot_git = worktree.join(".git");
    if std::fs::metadata(&dot_git).ok()?.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = PathBuf::from(text.lines().next()?.strip_prefix("gitdir:")?.trim());
    Some(if target.is_absolute() {
        target
    } else {
        worktree.join(target)
    })
}

/// What changes when a worktree's branch, dirty flag or index does.
fn facts_stamp(worktree: &Path) -> Option<u64> {
    let gitdir = gitdir_of(worktree)?;
    Some(hash_of(&[
        file_stamp(&gitdir.join("HEAD")),
        file_stamp(&gitdir.join("index")),
    ]))
}

/// What changes when a worktree's parent clone does: its `.git` entry.
fn clone_stamp(worktree: &Path) -> Option<u64> {
    let stamp = file_stamp(&worktree.join(".git"));
    stamp.0.map(|_| hash_of(&[stamp]))
}

/// What changes when a clone's worktree list does: the clone's `HEAD`, the `worktrees/` dir (an
/// entry added or removed) and every entry's `HEAD` (a branch checked out in a linked worktree).
fn porcelain_stamp(clone: &Path) -> Option<u64> {
    let git_dir = clone.join(".git");
    if !git_dir.is_dir() {
        return None;
    }
    let admin = git_dir.join("worktrees");
    let mut parts = vec![file_stamp(&git_dir.join("HEAD")), file_stamp(&admin)];
    if let Ok(entries) = std::fs::read_dir(&admin) {
        let mut names: Vec<PathBuf> = entries.filter_map(|e| Some(e.ok()?.path())).collect();
        names.sort();
        parts.extend(names.iter().map(|dir| file_stamp(&dir.join("HEAD"))));
    }
    Some(hash_of(&parts))
}

/// A path as the cache keys it: resolved, so the watch's path and the listing's agree.
pub(crate) fn cache_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The top level of the worktree containing `path`: the nearest ancestor with a `.git`. An editor
/// inset can be opened on a subfolder, and the listing keys by the top level.
pub(crate) fn worktree_top(path: &Path) -> PathBuf {
    path.ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(path)
        .to_path_buf()
}

struct Entry<V> {
    stamp: u64,
    at: Instant,
    value: V,
}

struct Inner<V> {
    entries: HashMap<PathBuf, Entry<V>>,
    /// Bumped by every invalidation, so a read that started before one is not kept after it.
    generations: HashMap<PathBuf, u64>,
    /// Paths with a read running now: the read's number and how many readers wait on it.
    in_flight: HashMap<PathBuf, InFlight>,
    /// A finished read's value for the readers that waited on it, by the read's number, until
    /// the last of them takes it.
    handoffs: HashMap<u64, Handoff<V>>,
    next_flight: u64,
}

struct InFlight {
    id: u64,
    waiters: usize,
}

struct Handoff<V> {
    stamp: Option<u64>,
    value: V,
    waiters: usize,
}

impl<V: Clone> Inner<V> {
    /// A waiter on read `id` takes its value: `None` if the read left none (it panicked, or an
    /// invalidation overtook it) or ran under another stamp (what it read has since changed).
    fn take_handoff(&mut self, id: u64, stamp: Option<u64>) -> Option<V> {
        let handoff = self.handoffs.get_mut(&id)?;
        handoff.waiters -= 1;
        let value = (handoff.stamp == stamp).then(|| handoff.value.clone());
        if handoff.waiters == 0 {
            self.handoffs.remove(&id);
        }
        value
    }
}

pub(crate) struct ProbeCache<V> {
    inner: Mutex<Inner<V>>,
    /// Signalled whenever an in-flight read ends.
    done: Condvar,
    /// How long an entry is trusted; `None` trusts it until its stamp changes.
    max_age: Option<Duration>,
}

impl<V> Default for ProbeCache<V> {
    fn default() -> Self {
        Self::new(None)
    }
}

/// Ends a path's in-flight read when dropped, even if the probe panics (its waiters then find
/// no handoff and read for themselves).
struct Flight<'a, V> {
    cache: &'a ProbeCache<V>,
    path: PathBuf,
    id: u64,
}

impl<V> Drop for Flight<'_, V> {
    fn drop(&mut self) {
        let mut inner = self.cache.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner
            .in_flight
            .get(&self.path)
            .is_some_and(|f| f.id == self.id)
        {
            inner.in_flight.remove(&self.path);
        }
        drop(inner);
        self.cache.done.notify_all();
    }
}

impl<V> ProbeCache<V> {
    pub(crate) fn new(max_age: Option<Duration>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                generations: HashMap::new(),
                in_flight: HashMap::new(),
                handoffs: HashMap::new(),
                next_flight: 0,
            }),
            done: Condvar::new(),
            max_age,
        }
    }
}

impl<V: Clone> ProbeCache<V> {
    /// The cached value for `path` while `stamp` holds, else `probe()`, which returns the value
    /// and whether it may be kept. A path with no stamp is never kept. If another thread is
    /// already reading `path`, this waits for it and takes its value whether or not it was kept
    /// (a timed-out read is not kept, and its waiters must not each wait out a timeout of their
    /// own); it reads itself only if that read left no value for it (it panicked, an invalidation
    /// overtook it, or it ran under another stamp).
    pub(crate) fn get_at(
        &self,
        path: &Path,
        stamp: Option<u64>,
        now: Instant,
        probe: impl FnOnce() -> (V, bool),
    ) -> V {
        let resolved = cache_key(path);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let generation = loop {
            if let Some(stamp) = stamp {
                if let Some(entry) = inner.entries.get(&resolved) {
                    let fresh = self
                        .max_age
                        .is_none_or(|max| now.saturating_duration_since(entry.at) < max);
                    if entry.stamp == stamp && fresh {
                        return entry.value.clone();
                    }
                }
            }
            let Some(flight) = inner.in_flight.get_mut(&resolved) else {
                break inner.generations.get(&resolved).copied().unwrap_or(0);
            };
            flight.waiters += 1;
            let id = flight.id;
            inner = self
                .done
                .wait_while(inner, |inner| {
                    inner.in_flight.get(&resolved).is_some_and(|f| f.id == id)
                })
                .unwrap_or_else(|e| e.into_inner());
            if let Some(value) = inner.take_handoff(id, stamp) {
                return value;
            }
        };
        let id = inner.next_flight;
        inner.next_flight += 1;
        inner
            .in_flight
            .insert(resolved.clone(), InFlight { id, waiters: 0 });
        drop(inner);
        let flight = Flight {
            cache: self,
            path: resolved,
            id,
        };
        // No lock across the probe: other worktrees read while this one runs.
        let (value, keep) = probe();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let current = inner.generations.get(&flight.path).copied().unwrap_or(0) == generation;
        if let (true, true, Some(stamp)) = (current, keep, stamp) {
            inner.entries.insert(
                flight.path.clone(),
                Entry {
                    stamp,
                    at: now,
                    value: value.clone(),
                },
            );
        }
        // End the flight here, under the same lock, so a waiter that wakes finds the handoff.
        if let Some(ended) = inner.in_flight.remove(&flight.path) {
            if current && ended.waiters > 0 {
                inner.handoffs.insert(
                    id,
                    Handoff {
                        stamp,
                        value: value.clone(),
                        waiters: ended.waiters,
                    },
                );
            }
        }
        drop(inner);
        drop(flight);
        value
    }

    /// Forget a path (the [`cache_key`] of a worktree top level) because something under it
    /// changed.
    pub(crate) fn invalidate(&self, path: &Path) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.remove(path);
        *inner.generations.entry(path.to_path_buf()).or_default() += 1;
    }

    /// Forget everything.
    pub(crate) fn invalidate_all(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let paths: Vec<PathBuf> = inner.entries.drain().map(|(path, _)| path).collect();
        for path in paths {
            *inner.generations.entry(path).or_default() += 1;
        }
    }
}

fn facts_cache() -> &'static ProbeCache<GitFacts> {
    static CACHE: OnceLock<ProbeCache<GitFacts>> = OnceLock::new();
    CACHE.get_or_init(|| ProbeCache::new(Some(MAX_AGE)))
}

fn clone_cache() -> &'static ProbeCache<Option<PathBuf>> {
    static CACHE: OnceLock<ProbeCache<Option<PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn porcelain_cache() -> &'static ProbeCache<Option<String>> {
    static CACHE: OnceLock<ProbeCache<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[cfg(not(test))]
fn clock(_path: &Path) -> Instant {
    Instant::now()
}

/// The listing's facts for `worktree`.
pub(crate) fn listing_facts(worktree: &Path) -> GitFacts {
    facts_cache().get_at(worktree, facts_stamp(worktree), clock(worktree), || {
        probe_facts(worktree)
    })
}

/// The clone a worktree belongs to: its common git dir's parent.
pub(crate) fn listing_clone_of(worktree: &Path) -> Option<PathBuf> {
    clone_cache().get_at(worktree, clone_stamp(worktree), clock(worktree), || {
        let read = git(
            worktree,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        let keep = read != Git::TimedOut;
        let clone = read
            .out()
            .and_then(|text| PathBuf::from(text.trim()).parent().map(Path::to_path_buf));
        (clone, keep)
    })
}

/// `git worktree list --porcelain` for a clone.
pub(crate) fn listing_porcelain(clone: &Path) -> Option<String> {
    porcelain_cache().get_at(clone, porcelain_stamp(clone), clock(clone), || {
        let read = git(clone, &["worktree", "list", "--porcelain"]);
        let keep = read != Git::TimedOut;
        (read.out(), keep)
    })
}

/// A file under the worktree at `key` ([`cache_key`] of [`worktree_top`]) changed.
pub(crate) fn invalidate_worktree(key: &Path) {
    facts_cache().invalidate(key);
}

/// A worktree was added to or removed from some clone.
pub(crate) fn invalidate_clones() {
    porcelain_cache().invalidate_all();
}

/// Run `work` on every item with at most `limit` running at once.
pub(crate) fn for_each_bounded<T: Sync>(items: &[T], limit: usize, work: impl Fn(&T) + Sync) {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let workers = limit.max(1).min(items.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                match items.get(index) {
                    Some(item) => work(item),
                    None => break,
                }
            });
        }
    });
}

#[cfg(test)]
pub(crate) mod test_hooks {
    //! Lets a test count the git a listing spawns under its own temp dir, and run its worktrees
    //! against a fake git with a short timeout, without touching any other test's probes.
    use super::*;

    struct Override {
        prefix: PathBuf,
        bin: String,
        timeout: Duration,
    }

    static SPAWNS: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());
    static SKEWS: Mutex<Vec<(PathBuf, Duration)>> = Mutex::new(Vec::new());
    static OVERRIDES: Mutex<Vec<Override>> = Mutex::new(Vec::new());

    pub(crate) fn record_spawn(dir: &Path, args: &[&str]) {
        SPAWNS
            .lock()
            .unwrap()
            .push((cache_key(dir), args.join(" ")));
    }

    /// The git processes started in a directory under `prefix`, as their arguments.
    pub(crate) fn spawned_under(prefix: &Path) -> Vec<String> {
        let prefix = cache_key(prefix);
        let spawns = SPAWNS.lock().unwrap();
        spawns
            .iter()
            .filter(|(dir, _)| dir.starts_with(&prefix))
            .map(|(_, args)| args.clone())
            .collect()
    }

    /// How many git processes were started in a directory under `prefix`.
    pub(crate) fn spawns_under(prefix: &Path) -> usize {
        spawned_under(prefix).len()
    }

    /// Cache reads under `prefix` see the clock `by` later from now on, so a test can age
    /// entries without waiting.
    pub(crate) fn skew_clock(prefix: &Path, by: Duration) {
        SKEWS.lock().unwrap().push((cache_key(prefix), by));
    }

    pub(super) fn now_for(path: &Path) -> Instant {
        let path = cache_key(path);
        let skews = SKEWS.lock().unwrap();
        let by = skews
            .iter()
            .rev()
            .find(|(prefix, _)| path.starts_with(prefix))
            .map_or(Duration::ZERO, |(_, by)| *by);
        Instant::now() + by
    }

    /// Probes in directories under `prefix` run `bin` with `timeout` from now on.
    pub(crate) fn use_fake_git(prefix: &Path, bin: &str, timeout: Duration) {
        OVERRIDES.lock().unwrap().push(Override {
            prefix: cache_key(prefix),
            bin: bin.to_owned(),
            timeout,
        });
    }

    pub(super) fn lookup(dir: &Path) -> Option<(String, Duration)> {
        let dir = cache_key(dir);
        let overrides = OVERRIDES.lock().unwrap();
        overrides
            .iter()
            .find(|o| dir.starts_with(&o.prefix))
            .map(|o| (o.bin.clone(), o.timeout))
    }
}

#[cfg(test)]
fn clock(path: &Path) -> Instant {
    test_hooks::now_for(path)
}

#[cfg(test)]
fn binary_and_timeout(dir: &Path) -> (String, Duration) {
    test_hooks::lookup(dir).unwrap_or_else(|| (super::worktree::git_bin(), PROBE_TIMEOUT))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// An executable `sh` script standing in for git.
    fn fake_git(dir: &Path, body: &str) -> String {
        let path = dir.join("fake-git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_probe_runs_with_no_optional_locks_first_and_returns_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_git(dir.path(), "echo \"$@\"");
        let out = git_with(&bin, dir.path(), &["status", "--porcelain"], PROBE_TIMEOUT);
        assert_eq!(
            out,
            Git::Out("--no-optional-locks status --porcelain\n".into())
        );
    }

    #[test]
    fn a_failing_probe_reports_failed_and_a_missing_git_too() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_git(dir.path(), "echo partial; exit 3");
        assert_eq!(
            git_with(&bin, dir.path(), &["status"], PROBE_TIMEOUT),
            Git::Failed
        );
        let missing = dir.path().join("no-such-git");
        let out = git_with(
            missing.to_str().unwrap(),
            dir.path(),
            &["status"],
            PROBE_TIMEOUT,
        );
        assert_eq!(out, Git::Failed);
    }

    #[test]
    fn output_that_is_not_utf8_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_git(dir.path(), "printf ' M caf\\351.txt\\n'");
        let out = git_with(&bin, dir.path(), &["status"], PROBE_TIMEOUT).out();
        assert!(out.is_some_and(|text| text.contains("caf")));
    }

    #[test]
    fn a_hanging_probe_is_killed_at_its_timeout_reports_timed_out_and_the_call_returns() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        // `exec` makes the script's pid the sleeper's, so the recorded pid is the child we kill.
        let bin = fake_git(
            dir.path(),
            &format!("echo $$ > {}; exec sleep 60", pid_file.display()),
        );
        let started = Instant::now();
        let out = git_with(&bin, dir.path(), &["status"], Duration::from_millis(500));
        let took = started.elapsed();
        assert_eq!(out, Git::TimedOut);
        assert!(
            took >= Duration::from_millis(500),
            "returned early: {took:?}"
        );
        assert!(
            took < Duration::from_secs(30),
            "did not stop the child: {took:?}"
        );
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .to_owned();
        // `kill -0` fails once the killed child has been reaped.
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid])
            .status()
            .unwrap()
            .success();
        assert!(!alive, "child {pid} still running");
    }

    fn facts(dirty: Option<bool>) -> GitFacts {
        GitFacts {
            branch: Some("main".into()),
            dirty,
            repo_path: None,
        }
    }

    /// A worktree whose `.git` is a directory holding `HEAD` and `index`.
    fn fake_worktree(dir: &Path) -> PathBuf {
        let wt = dir.join("wt");
        std::fs::create_dir_all(wt.join(".git")).unwrap();
        std::fs::write(wt.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(wt.join(".git/index"), "one").unwrap();
        wt
    }

    fn at(wt: &Path) -> Option<u64> {
        facts_stamp(wt)
    }

    /// Reads `wt` through `cache` and counts the probes that actually ran.
    fn read(
        cache: &ProbeCache<GitFacts>,
        wt: &Path,
        now: Instant,
        spawns: &Cell<u32>,
        result: (GitFacts, bool),
    ) -> GitFacts {
        cache.get_at(wt, at(wt), now, || {
            spawns.set(spawns.get() + 1);
            result
        })
    }

    fn clean() -> (GitFacts, bool) {
        (facts(Some(false)), true)
    }

    #[test]
    fn a_listing_with_no_changes_spawns_nothing_after_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        for _ in 0..5 {
            assert_eq!(read(&cache, &wt, now, &spawns, clean()), facts(Some(false)));
        }
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn an_index_change_invalidates_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        std::fs::write(wt.join(".git/index"), "a longer index").unwrap();
        read(&cache, &wt, now, &spawns, clean());
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_head_change_invalidates_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        std::fs::write(wt.join(".git/HEAD"), "ref: refs/heads/feature/other\n").unwrap();
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_file_event_invalidates_without_an_index_change() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        cache.invalidate(&cache_key(&wt));
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_file_event_under_another_worktree_keeps_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        cache.invalidate(&cache_key(&dir.path().join("elsewhere")));
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn an_invalidation_during_a_read_keeps_the_stale_result_out_of_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        cache.get_at(&wt, at(&wt), now, || {
            // A file event lands while git is still reading the old state.
            cache.invalidate(&cache_key(&wt));
            clean()
        });
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 1, "the overtaken read was not kept");
    }

    #[test]
    fn an_entry_is_read_again_once_it_is_old() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        read(
            &cache,
            &wt,
            now + MAX_AGE - Duration::from_secs(1),
            &spawns,
            clean(),
        );
        assert_eq!(spawns.get(), 1);
        read(&cache, &wt, now + MAX_AGE, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_read_that_is_not_kept_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        for _ in 0..2 {
            read(&cache, &wt, now, &spawns, (facts(None), false));
        }
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_worktree_with_no_gitdir_is_never_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        for _ in 0..2 {
            read(&cache, dir.path(), now, &spawns, clean());
        }
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_linked_worktree_is_stamped_by_the_gitdir_its_dot_git_file_names() {
        let dir = tempfile::tempdir().unwrap();
        let gitdir = dir.path().join("main/.git/worktrees/wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/x\n").unwrap();
        std::fs::write(gitdir.join("index"), "one").unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        read(&cache, &wt, now, &spawns, clean());
        std::fs::write(gitdir.join("index"), "changed index").unwrap();
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_clones_worktree_list_is_stamped_by_its_entries_and_their_heads() {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path().join("clone");
        let entry = clone.join(".git/worktrees/one");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(clone.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(entry.join("HEAD"), "ref: refs/heads/a\n").unwrap();
        let before = porcelain_stamp(&clone);
        assert!(before.is_some());
        assert_eq!(porcelain_stamp(&clone), before);
        std::fs::write(entry.join("HEAD"), "ref: refs/heads/another\n").unwrap();
        let after_checkout = porcelain_stamp(&clone);
        assert_ne!(after_checkout, before);
        std::fs::create_dir_all(clone.join(".git/worktrees/two")).unwrap();
        assert_ne!(porcelain_stamp(&clone), after_checkout);
        assert_eq!(porcelain_stamp(&dir.path().join("not-a-clone")), None);
    }

    #[test]
    fn a_file_event_under_a_subfolder_inset_invalidates_the_worktrees_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let inset = wt.join("src/deep");
        std::fs::create_dir_all(&inset).unwrap();
        let (cache, spawns, now) = (ProbeCache::new(Some(MAX_AGE)), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        // The key the watch builds for an inset opened on a subfolder.
        cache.invalidate(&cache_key(&worktree_top(&inset)));
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_cache_with_no_max_age_keeps_an_entry_while_its_stamp_holds() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::new(None), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        read(
            &cache,
            &wt,
            now + Duration::from_secs(24 * 3600),
            &spawns,
            clean(),
        );
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn two_concurrent_reads_of_one_path_share_one_probe() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let cache = ProbeCache::new(Some(MAX_AGE));
        let probes = AtomicUsize::new(0);
        let started = std::sync::atomic::AtomicBool::new(false);
        let stamp = facts_stamp(&wt);
        let now = Instant::now();
        let (first, second) = std::thread::scope(|scope| {
            let leader = scope.spawn(|| {
                cache.get_at(&wt, stamp, now, || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    started.store(true, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(200));
                    clean()
                })
            });
            // The second reader arrives while the first is still reading.
            while !started.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            let follower = scope.spawn(|| {
                cache.get_at(&wt, stamp, now, || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    clean()
                })
            });
            (leader.join().unwrap(), follower.join().unwrap())
        });
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
    }

    /// Blocks until `count` readers wait on the read of `path` in flight, so a test's leader
    /// ends its read only once its followers are known to be waiting on it.
    fn until_waiting<V>(cache: &ProbeCache<V>, path: &Path, count: usize) {
        let key = cache_key(path);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let waiting = cache
                .inner
                .lock()
                .unwrap()
                .in_flight
                .get(&key)
                .map_or(0, |flight| flight.waiters);
            if waiting >= count {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "only {waiting} of {count} came to wait"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn waiters_take_the_read_they_waited_for_even_when_it_was_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let cache = ProbeCache::new(Some(MAX_AGE));
        let probes = AtomicUsize::new(0);
        let started = std::sync::atomic::AtomicBool::new(false);
        let stamp = facts_stamp(&wt);
        let now = Instant::now();
        let follow = || {
            cache.get_at(&wt, stamp, now, || {
                probes.fetch_add(1, Ordering::SeqCst);
                clean()
            })
        };
        let (first, second, third) = std::thread::scope(|scope| {
            // A read that timed out: unknown, and not kept.
            let leader = scope.spawn(|| {
                cache.get_at(&wt, stamp, now, || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    started.store(true, Ordering::SeqCst);
                    until_waiting(&cache, &wt, 2);
                    (facts(None), false)
                })
            });
            while !started.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            let (one, two) = (scope.spawn(follow), scope.spawn(follow));
            (
                leader.join().unwrap(),
                one.join().unwrap(),
                two.join().unwrap(),
            )
        });
        assert_eq!(
            probes.load(Ordering::SeqCst),
            1,
            "the waiters did not read again"
        );
        assert_eq!((second, third), (first.clone(), first));
        // Shared, not kept: the next read probes.
        follow();
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_read_an_invalidation_overtook_is_not_handed_to_its_waiters() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let cache = ProbeCache::new(Some(MAX_AGE));
        let probes = AtomicUsize::new(0);
        let started = std::sync::atomic::AtomicBool::new(false);
        let stamp = facts_stamp(&wt);
        let now = Instant::now();
        let followed = std::thread::scope(|scope| {
            let leader = scope.spawn(|| {
                cache.get_at(&wt, stamp, now, || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    started.store(true, Ordering::SeqCst);
                    until_waiting(&cache, &wt, 1);
                    // A file event lands while git is still reading the old state.
                    cache.invalidate(&cache_key(&wt));
                    clean()
                })
            });
            while !started.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            let follower = scope.spawn(|| {
                cache.get_at(&wt, stamp, now, || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    (facts(Some(true)), true)
                })
            });
            leader.join().unwrap();
            follower.join().unwrap()
        });
        assert_eq!(probes.load(Ordering::SeqCst), 2);
        assert_eq!(followed, facts(Some(true)), "the waiter read the new state");
    }

    #[test]
    fn the_top_level_is_the_nearest_ancestor_with_a_dot_git() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let sub = wt.join("src/deep");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(worktree_top(&sub), wt);
        assert_eq!(worktree_top(&wt), wt);
    }

    #[test]
    fn work_runs_for_every_item_with_no_more_than_the_limit_at_once() {
        let items: Vec<u32> = (0..24).collect();
        let (running, peak, done) = (
            AtomicUsize::new(0),
            AtomicUsize::new(0),
            AtomicUsize::new(0),
        );
        for_each_bounded(&items, 4, |_| {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(10));
            running.fetch_sub(1, Ordering::SeqCst);
            done.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(done.load(Ordering::SeqCst), 24);
        assert!(peak.load(Ordering::SeqCst) <= 4);
    }
}

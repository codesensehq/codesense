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
//! These helpers are the listing's only. The teardown gate and the run-launch branch check read
//! git through the unbounded originals in `worktree.rs`, because a slow answer there must not
//! read as "no branch" or "clean".
//!
//! [`ProbeCache`] keeps what a listing read, so a listing where nothing changed spawns no git at
//! all. An entry is good while its stamp (the mtimes and sizes of the gitdir files that change
//! when the answer does) is what it was; it is dropped by [`ProbeCache::invalidate`], which the
//! existing worktree file watch calls for a changed file (an edit to a tracked file does not touch
//! the index, so the stamp alone would miss it) and the existing clone `worktrees/` watch calls
//! for a worktree added or removed. An entry older than [`MAX_AGE`] is read again, so a worktree
//! no watch covers (one with no editor open) lags by at most that long. A read that timed out is
//! never kept, and neither is one an invalidation overtook while it ran.

use crate::shared::proc_capture::{spawn_capture, CaptureRequest};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// How long one probe may run before it is killed and its fact is reported as unknown.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A status's output is only tested for being empty, and a worktree list is a few lines a
/// worktree; a huge untracked tree must not fill memory.
const MAX_OUTPUT: usize = 1024 * 1024;
/// How long an entry is trusted without a changed stamp or a file event.
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
    test_hooks::record_spawn(dir);
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
}

pub(crate) struct ProbeCache<V> {
    inner: Mutex<Inner<V>>,
}

impl<V> Default for ProbeCache<V> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                generations: HashMap::new(),
            }),
        }
    }
}

impl<V: Clone> ProbeCache<V> {
    /// The cached value for `path` while `stamp` holds, else `probe()`, which returns the value
    /// and whether it may be kept. A path with no stamp is never kept.
    pub(crate) fn get_at(
        &self,
        path: &Path,
        stamp: Option<u64>,
        now: Instant,
        probe: impl FnOnce() -> (V, bool),
    ) -> V {
        let key = cache_key(path);
        let generation = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(stamp) = stamp {
                if let Some(entry) = inner.entries.get(&key) {
                    if entry.stamp == stamp && now.saturating_duration_since(entry.at) < MAX_AGE {
                        return entry.value.clone();
                    }
                }
            }
            inner.generations.get(&key).copied().unwrap_or(0)
        };
        // No lock across the probe: other worktrees read while this one runs.
        let (value, keep) = probe();
        if let (true, Some(stamp)) = (keep, stamp) {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.generations.get(&key).copied().unwrap_or(0) == generation {
                inner.entries.insert(
                    key,
                    Entry {
                        stamp,
                        at: now,
                        value: value.clone(),
                    },
                );
            }
        }
        value
    }

    /// Forget `key` ([`cache_key`] of a worktree top level) because something under it changed.
    pub(crate) fn invalidate(&self, key: &Path) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.entries.remove(key);
        *inner.generations.entry(key.to_path_buf()).or_default() += 1;
    }

    /// Forget everything.
    pub(crate) fn invalidate_all(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<PathBuf> = inner.entries.keys().cloned().collect();
        inner.entries.clear();
        for key in keys {
            *inner.generations.entry(key).or_default() += 1;
        }
    }
}

fn facts_cache() -> &'static ProbeCache<GitFacts> {
    static CACHE: OnceLock<ProbeCache<GitFacts>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn clone_cache() -> &'static ProbeCache<Option<PathBuf>> {
    static CACHE: OnceLock<ProbeCache<Option<PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn porcelain_cache() -> &'static ProbeCache<Option<String>> {
    static CACHE: OnceLock<ProbeCache<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The listing's facts for `worktree`.
pub(crate) fn listing_facts(worktree: &Path) -> GitFacts {
    facts_cache().get_at(worktree, facts_stamp(worktree), Instant::now(), || {
        probe_facts(worktree)
    })
}

/// The clone a worktree belongs to: its common git dir's parent.
pub(crate) fn listing_clone_of(worktree: &Path) -> Option<PathBuf> {
    clone_cache().get_at(worktree, clone_stamp(worktree), Instant::now(), || {
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
    porcelain_cache().get_at(clone, porcelain_stamp(clone), Instant::now(), || {
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

    static SPAWNS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    static OVERRIDES: Mutex<Vec<Override>> = Mutex::new(Vec::new());

    pub(crate) fn record_spawn(dir: &Path) {
        SPAWNS.lock().unwrap().push(cache_key(dir));
    }

    /// How many git processes were started in a directory under `prefix`.
    pub(crate) fn spawns_under(prefix: &Path) -> usize {
        let prefix = cache_key(prefix);
        let spawns = SPAWNS.lock().unwrap();
        spawns.iter().filter(|dir| dir.starts_with(&prefix)).count()
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
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        for _ in 0..5 {
            assert_eq!(read(&cache, &wt, now, &spawns, clean()), facts(Some(false)));
        }
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn an_index_change_invalidates_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
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
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        std::fs::write(wt.join(".git/HEAD"), "ref: refs/heads/feature/other\n").unwrap();
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_file_event_invalidates_without_an_index_change() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        cache.invalidate(&cache_key(&wt));
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_file_event_under_another_worktree_keeps_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        cache.invalidate(&cache_key(&dir.path().join("elsewhere")));
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn an_invalidation_during_a_read_keeps_the_stale_result_out_of_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
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
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
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
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        for _ in 0..2 {
            read(&cache, &wt, now, &spawns, (facts(None), false));
        }
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_worktree_with_no_gitdir_is_never_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
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
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
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
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns, clean());
        // The key the watch builds for an inset opened on a subfolder.
        cache.invalidate(&cache_key(&worktree_top(&inset)));
        read(&cache, &wt, now, &spawns, clean());
        assert_eq!(spawns.get(), 2);
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

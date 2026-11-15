// SPDX-License-Identifier: MIT
//! Bounded git reads for the worktree listing.
//!
//! The Worktrees panel reads a branch, a dirty flag and the parent clone for every worktree.
//! Each read used to be an unbounded `git` child, so one worktree under a cargo build could hold
//! the whole listing for minutes. A read here runs as `git --no-optional-locks …` (a status that
//! only looks never takes the index lock a build's own git needs), and a read that outlives its
//! timeout is killed, by its own pid only, and reports nothing.
//!
//! [`ProbeCache`] keeps what a listing read, so a listing where nothing changed spawns no git
//! at all. An entry is good while the mtime and size of the worktree's gitdir `HEAD` and `index`
//! are what they were, and it is dropped by [`ProbeCache::invalidate_under`], which the existing
//! worktree file watch calls for a changed file (an edit to a tracked file does not touch the
//! index, so the stamp alone would miss it). An entry older than [`MAX_AGE`] is read again, so a
//! worktree no watch covers cannot show a stale flag for long.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// How long one probe may run before it is killed and its fact is reported as unknown.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// More than a status's first screenful is never needed; a huge untracked tree must not fill memory.
const MAX_OUTPUT: u64 = 1024 * 1024;

/// Run `git --no-optional-locks <args>` in `worktree`, and return its stdout when it exits
/// zero within [`PROBE_TIMEOUT`]. A spawn failure, a non-zero exit and a timeout are all `None`.
pub(crate) fn git_stdout(worktree: &Path, args: &[&str]) -> Option<String> {
    git_stdout_with(&super::worktree::git_bin(), worktree, args, PROBE_TIMEOUT)
}

pub(crate) fn git_stdout_with(
    git: &str,
    worktree: &Path,
    args: &[&str],
    timeout: Duration,
) -> Option<String> {
    // A file, not a pipe: a child that writes more than a pipe holds would block until killed.
    let mut out = tempfile::tempfile().ok()?;
    let mut child = Command::new(git)
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(worktree)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out.try_clone().ok()?))
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                // Our own child only: never a pattern, never a process group.
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    read_capped(&mut out)
}

fn read_capped(file: &mut File) -> Option<String> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_OUTPUT).read_to_end(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

/// The facts the listing shows for one worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitFacts {
    pub branch: Option<String>,
    pub dirty: Option<bool>,
    pub repo_path: Option<PathBuf>,
}

/// How long an entry is trusted without a changed stamp or a file event.
const MAX_AGE: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStamp(Option<(SystemTime, u64)>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    head: FileStamp,
    index: FileStamp,
}

struct Entry {
    stamp: Stamp,
    at: Instant,
    facts: GitFacts,
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

fn file_stamp(path: &Path) -> FileStamp {
    FileStamp(
        std::fs::metadata(path)
            .ok()
            .and_then(|meta| Some((meta.modified().ok()?, meta.len()))),
    )
}

fn stamp_of(worktree: &Path) -> Option<Stamp> {
    let gitdir = gitdir_of(worktree)?;
    Some(Stamp {
        head: file_stamp(&gitdir.join("HEAD")),
        index: file_stamp(&gitdir.join("index")),
    })
}

/// A path as the cache keys it: resolved, so the watch's path and the listing's agree.
pub(crate) fn cache_key(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// A relative path the watch reports that the cache ignores: build output churns constantly and
/// never changes what git reports.
fn is_build_output(relative: &str) -> bool {
    relative == "target" || relative.starts_with("target/")
}

#[derive(Default)]
pub(crate) struct ProbeCache {
    entries: Mutex<HashMap<PathBuf, Entry>>,
}

impl ProbeCache {
    /// The cached facts for `worktree` while its stamp holds, else `probe()`. A read whose
    /// status failed (a timeout, or no repo) is returned but not kept, so the next listing
    /// asks again.
    pub(crate) fn facts_at(
        &self,
        worktree: &Path,
        now: Instant,
        probe: impl FnOnce() -> GitFacts,
    ) -> GitFacts {
        let key = cache_key(worktree);
        let stamp = stamp_of(worktree);
        if let Some(stamp) = stamp {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = entries.get(&key) {
                if entry.stamp == stamp && now.saturating_duration_since(entry.at) < MAX_AGE {
                    return entry.facts.clone();
                }
            }
        }
        // No lock across the probe: other worktrees read while this one runs.
        let facts = probe();
        if let Some(stamp) = stamp {
            if facts.dirty.is_some() {
                let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
                entries.insert(
                    key,
                    Entry {
                        stamp,
                        at: now,
                        facts: facts.clone(),
                    },
                );
            }
        }
        facts
    }

    /// Forget `worktree` because a file under it changed at `relative` (the watch's path,
    /// relative to its root). `key` is [`cache_key`] of the watched root, resolved once.
    pub(crate) fn invalidate_under(&self, key: &Path, relative: &str) {
        if is_build_output(relative) {
            return;
        }
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.remove(key);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

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
        let git = fake_git(dir.path(), "echo \"$@\"");
        let out = git_stdout_with(&git, dir.path(), &["status", "--porcelain"], PROBE_TIMEOUT);
        assert_eq!(
            out.as_deref(),
            Some("--no-optional-locks status --porcelain\n")
        );
    }

    #[test]
    fn a_failing_probe_reports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let git = fake_git(dir.path(), "echo partial; exit 3");
        assert_eq!(
            git_stdout_with(&git, dir.path(), &["status"], PROBE_TIMEOUT),
            None
        );
    }

    #[test]
    fn a_missing_git_reports_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-git");
        let out = git_stdout_with(
            missing.to_str().unwrap(),
            dir.path(),
            &["status"],
            PROBE_TIMEOUT,
        );
        assert_eq!(out, None);
    }

    #[test]
    fn a_hanging_probe_is_killed_at_its_timeout_and_the_call_returns() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        // `exec` makes the script's pid the sleeper's, so the recorded pid is the child we kill.
        let git = fake_git(
            dir.path(),
            &format!("echo $$ > {}; exec sleep 60", pid_file.display()),
        );
        let started = Instant::now();
        let out = git_stdout_with(&git, dir.path(), &["status"], Duration::from_millis(500));
        let took = started.elapsed();
        assert_eq!(out, None);
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
        let alive = Command::new("kill")
            .args(["-0", &pid])
            .status()
            .unwrap()
            .success();
        assert!(!alive, "child {pid} still running");
    }

    use std::cell::Cell;

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

    /// Reads `wt` through `cache` and counts the probes that actually ran.
    fn read(cache: &ProbeCache, wt: &Path, now: Instant, spawns: &Cell<u32>) -> GitFacts {
        cache.facts_at(wt, now, || {
            spawns.set(spawns.get() + 1);
            facts(Some(false))
        })
    }

    #[test]
    fn a_listing_with_no_changes_spawns_nothing_after_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        for _ in 0..5 {
            assert_eq!(read(&cache, &wt, now, &spawns), facts(Some(false)));
        }
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn an_index_change_invalidates_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns);
        std::fs::write(wt.join(".git/index"), "a longer index").unwrap();
        read(&cache, &wt, now, &spawns);
        read(&cache, &wt, now, &spawns);
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_head_change_invalidates_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns);
        std::fs::write(wt.join(".git/HEAD"), "ref: refs/heads/feature/other\n").unwrap();
        read(&cache, &wt, now, &spawns);
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_file_event_invalidates_without_an_index_change() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns);
        cache.invalidate_under(&cache_key(&wt), "src/main.rs");
        read(&cache, &wt, now, &spawns);
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_file_event_under_target_or_another_worktree_keeps_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns);
        cache.invalidate_under(&cache_key(&wt), "target/debug/app");
        cache.invalidate_under(&cache_key(&wt), "target");
        cache.invalidate_under(&cache_key(&dir.path().join("elsewhere")), "src/main.rs");
        read(&cache, &wt, now, &spawns);
        assert_eq!(spawns.get(), 1);
    }

    #[test]
    fn an_entry_is_read_again_once_it_is_old() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        read(&cache, &wt, now, &spawns);
        read(&cache, &wt, now + MAX_AGE - Duration::from_secs(1), &spawns);
        assert_eq!(spawns.get(), 1);
        read(&cache, &wt, now + MAX_AGE, &spawns);
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_failed_status_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let wt = fake_worktree(dir.path());
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        for _ in 0..2 {
            cache.facts_at(&wt, now, || {
                spawns.set(spawns.get() + 1);
                facts(None)
            });
        }
        assert_eq!(spawns.get(), 2);
    }

    #[test]
    fn a_worktree_with_no_gitdir_is_never_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, spawns, now) = (ProbeCache::default(), Cell::new(0), Instant::now());
        for _ in 0..2 {
            read(&cache, dir.path(), now, &spawns);
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
        read(&cache, &wt, now, &spawns);
        read(&cache, &wt, now, &spawns);
        std::fs::write(gitdir.join("index"), "changed index").unwrap();
        read(&cache, &wt, now, &spawns);
        assert_eq!(spawns.get(), 2);
    }
}

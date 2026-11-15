// SPDX-License-Identifier: MIT
//! Bounded git reads for the worktree listing.
//!
//! The Worktrees panel reads a branch, a dirty flag and the parent clone for every worktree.
//! Each read used to be an unbounded `git` child, so one worktree under a cargo build could hold
//! the whole listing for minutes. A read here runs as `git --no-optional-locks …` (a status that
//! only looks never takes the index lock a build's own git needs), and a read that outlives its
//! timeout is killed, by its own pid only, and reports nothing.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
}

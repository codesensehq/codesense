// SPDX-License-Identifier: MIT
//! The terminal caption's prompt segment: where a session is and what its Git
//! checkout looks like, the way a shell prompt (starship, p10k) shows it.
//!
//! Every host answers this for its own sessions — the in-process app and the
//! local sidecar for This Mac, the remote session server for a Machine — so
//! `git` always runs next to the checkout, never over the wire. The status is
//! read with one `git status --porcelain=v2 --branch` and parsed here; a path
//! outside a repository (or a host without `git`) answers `None`.
//!
//! Reads are cheap but not free, so each host keeps a short per-path cache:
//! several tabs in one checkout, or a caption polling while a command finishes,
//! share one `git` run per [`CACHE_TTL`].

use codesense_platform::process::{exited_unreaped, kill_hard, ProcessTree};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A checkout's state as a prompt shows it. Counts are of paths.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPromptStatus {
    /// The checked-out branch; `None` on a detached HEAD.
    pub branch: Option<String>,
    pub detached: bool,
    /// The HEAD commit (full hex); `None` before the first commit.
    pub sha: Option<String>,
    /// The upstream branch, when one is set.
    pub upstream: Option<String>,
    /// Paths with changes in the index.
    pub staged: u32,
    /// Tracked paths with changes in the working tree not yet staged.
    pub modified: u32,
    pub untracked: u32,
    /// Unmerged paths (a merge, rebase or cherry-pick stopped on them).
    pub conflicted: u32,
    /// Commits ahead of / behind the upstream.
    pub ahead: u32,
    pub behind: u32,
}

/// Everything the caption's prompt segment needs about one session, read on
/// the host that runs it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrompt {
    /// The working directory the session last reported (OSC 7).
    pub cwd: Option<PathBuf>,
    /// The host account's home directory, so the caption can say `~`.
    pub home: Option<PathBuf>,
    /// The checkout `cwd` is inside, or `None` outside a repository.
    pub git: Option<GitPromptStatus>,
}

/// How long one path's status is reused.
pub const CACHE_TTL: Duration = Duration::from_millis(1500);
/// A `git status` slower than this is abandoned (a cold, huge checkout).
pub const GIT_TIMEOUT: Duration = Duration::from_secs(3);
/// Output past this many bytes is not read further; counts stay a floor.
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

/// The argv after `git` for one prompt read. Hardened like a prompt should
/// be: no optional locks (a prompt must never contend with the user's own
/// `git` for `index.lock`), no fsmonitor daemon or hooks started from a
/// repository's own config, no terminal prompts.
pub fn git_status_args() -> Vec<&'static str> {
    vec![
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "color.status=false",
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=normal",
        "--ignore-submodules=dirty",
    ]
}

/// Parse `git status --porcelain=v2 --branch` output.
pub fn parse_porcelain_v2(text: &str) -> GitPromptStatus {
    let mut status = GitPromptStatus::default();
    let mut tracking_known = false;
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => {
                    status.sha = (value != "(initial)" && !value.is_empty()).then(|| value.into());
                }
                "branch.head" => {
                    if value == "(detached)" {
                        status.detached = true;
                        status.branch = None;
                    } else if !value.is_empty() {
                        status.branch = Some(value.into());
                    }
                }
                "branch.upstream" => status.upstream = Some(value.into()),
                "branch.ab" => {
                    tracking_known = true;
                    for part in value.split_whitespace() {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let mut fields = line.splitn(3, ' ');
        match (fields.next(), fields.next()) {
            (Some("1" | "2"), Some(xy)) => {
                let mut xy = xy.chars();
                if xy.next().is_some_and(|x| x != '.') {
                    status.staged += 1;
                }
                if xy.next().is_some_and(|y| y != '.') {
                    status.modified += 1;
                }
            }
            (Some("u"), Some(_)) => status.conflicted += 1,
            (Some("?"), Some(_)) => status.untracked += 1,
            _ => {}
        }
    }
    // An upstream that is configured but gone (deleted on the remote, pruned)
    // has no ahead/behind line: don't present it as tracked and in sync.
    if !tracking_known {
        status.upstream = None;
    }
    status
}

/// The status of the checkout `path` is in, or `None` outside a repository,
/// on a timeout, or where `git` is unavailable.
pub fn read_status(path: &Path) -> Option<GitPromptStatus> {
    read(path).ok()
}

/// Why a read has no status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Miss {
    /// Outside a repository, `git` unavailable or refusing.
    NoStatus,
    /// `git status` (or a helper holding its output) outlived [`GIT_TIMEOUT`].
    TimedOut,
}

/// Inherited git variables that would point the prompt's `git status` at another
/// repository, index, object store, history (shallow, grafts, replace refs) or config
/// than the directory it reads, or let discovery cross into another filesystem.
const GIT_ENV_CLEARED: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

/// The prompt's `git status` in `path`, with an environment that cannot misdirect it.
fn git_status_command(path: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .args(git_status_args())
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for var in GIT_ENV_CLEARED {
        command.env_remove(var);
    }
    command
}

fn read(path: &Path) -> Result<GitPromptStatus, Miss> {
    if !path.is_dir() {
        return Err(Miss::NoStatus);
    }
    run(git_status_command(path))
}

/// Run a prompt read's `command` (see [`git_status_command`]) and parse what it
/// prints.
fn run(mut command: Command) -> Result<GitPromptStatus, Miss> {
    // A tree of its own, so a timeout kills a helper `git` started (a filter,
    // a credential helper) along with it, and whatever is left once `git`
    // exits goes too. Hidden: `git` is a console program, and a windowed host
    // would otherwise open a console for every read. `kill_hard` is only ever
    // called while `git` is unreaped (running, or a zombie), so the group id is
    // still `git`'s own and can't name a reused group.
    let mut tree = ProcessTree::spawn_hidden(&mut command).map_err(|_| Miss::NoStatus)?;
    let Some(mut stdout) = tree.child().stdout.take() else {
        let _ = kill_hard(&tree);
        let _ = tree.wait();
        return Err(Miss::NoStatus);
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut buf) {
            if n == 0 {
                break;
            }
            if out.len() < OUTPUT_LIMIT {
                out.extend_from_slice(&buf[..n]);
            }
        }
        let _ = sender.send(out);
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    // Wait for `git` to exit but leave it unreaped until the pipe is drained.
    loop {
        match exited_unreaped(tree.child()) {
            Ok(true) => break,
            Ok(false) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(false) => {
                let _ = kill_hard(&tree);
                let _ = tree.wait();
                return Err(Miss::TimedOut);
            }
            Err(_) => {
                // The exit can't be observed without reaping (or something
                // else reaped `git`): signal the group only while `git` is
                // provably still running, since a reaped pid may be reused.
                // A `try_wait` that reaps `git` closes the tree, which kills
                // what it left in its group, as after any exit: the group id
                // stays reserved while a member lives, and an empty one is
                // not an error. One that can't read the exit either leaves
                // the tree signalling nothing, now or when it drops.
                if matches!(tree.try_wait(), Ok(None)) {
                    let _ = kill_hard(&tree);
                    let _ = tree.wait();
                }
                return Err(Miss::NoStatus);
            }
        }
    }
    // A child `git` spawned (a filter, a credential helper) may still hold the
    // pipe after `git` exits: wait out the deadline, never far past it. A short
    // grace lets the reader drain a `git` that exited just before the deadline.
    let out = receiver
        .recv_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(100)),
        )
        .ok();
    if out.is_none() {
        // A helper still holds the pipe: `git` is a zombie, so its group id
        // is still reserved, and the kill reaches only that group.
        let _ = kill_hard(&tree);
    }
    // Reaping `git` kills whatever it left running; a wait that can't read
    // its exit signals nothing, now or when the tree drops.
    let exit = tree.wait().map_err(|_| Miss::NoStatus)?;
    let out = out.ok_or(Miss::TimedOut)?;
    if !exit.success() {
        return Err(Miss::NoStatus);
    }
    Ok(parse_porcelain_v2(&String::from_utf8_lossy(&out)))
}

/// How long a timed-out read is remembered: a checkout whose status always
/// outlives [`GIT_TIMEOUT`] isn't re-run (for the full timeout) every poll.
pub const TIMEOUT_TTL: Duration = Duration::from_secs(30);

type Cache = Mutex<HashMap<PathBuf, CacheEntry>>;

struct CacheEntry {
    at: Instant,
    ttl: Duration,
    status: Option<GitPromptStatus>,
}

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// [`read_status`] through this host's per-path cache.
pub fn cached_status(path: &Path) -> Option<GitPromptStatus> {
    cached_with(path, read)
}

fn cached_with(
    path: &Path,
    read: impl FnOnce(&Path) -> Result<GitPromptStatus, Miss>,
) -> Option<GitPromptStatus> {
    let now = Instant::now();
    if let Ok(cache) = cache().lock() {
        if let Some(entry) = cache.get(path) {
            if now.duration_since(entry.at) < entry.ttl {
                return entry.status.clone();
            }
        }
    }
    let result = read(path);
    let ttl = if result == Err(Miss::TimedOut) {
        TIMEOUT_TTL
    } else {
        CACHE_TTL
    };
    let status = result.ok();
    if let Ok(mut cache) = cache().lock() {
        // Bounded: a long-lived host visits many directories.
        if cache.len() > 256 {
            cache.retain(|_, entry| now.duration_since(entry.at) < entry.ttl);
        }
        cache.insert(
            path.to_path_buf(),
            CacheEntry {
                at: Instant::now(),
                ttl,
                status: status.clone(),
            },
        );
    }
    status
}

/// A session's prompt from its reported `cwd` and its host's `home`.
pub fn session_prompt(cwd: Option<PathBuf>, home: Option<PathBuf>) -> SessionPrompt {
    let git = cwd.as_deref().and_then(cached_status);
    SessionPrompt { cwd, home, git }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codesense_host_proto::test_support::strip_attribution_env;

    #[test]
    fn the_status_command_clears_every_redirecting_git_variable() {
        let command = git_status_command(Path::new("/tmp"));
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        for var in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_NAMESPACE",
            "GIT_CEILING_DIRECTORIES",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
            "GIT_SHALLOW_FILE",
            "GIT_GRAFT_FILE",
            "GIT_REPLACE_REF_BASE",
            "GIT_NO_REPLACE_OBJECTS",
            "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        ] {
            assert!(removed.iter().any(|k| k == var), "{var} not cleared");
        }
        // Git sets GIT_PREFIX for the commands it runs and never reads it.
        assert!(!removed.iter().any(|k| k == "GIT_PREFIX"));
        let set: Vec<(String, String)> = command
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert!(set.contains(&("GIT_OPTIONAL_LOCKS".into(), "0".into())));
        assert!(set.contains(&("GIT_TERMINAL_PROMPT".into(), "0".into())));
    }

    #[test]
    fn parses_branch_ahead_behind_and_counts() {
        let text = "\
# branch.oid 0123456789abcdef0123456789abcdef01234567
# branch.head feat/prompt
# branch.upstream origin/feat/prompt
# branch.ab +3 -1
1 M. N... 100644 100644 100644 aaa bbb src/staged.rs
1 .M N... 100644 100644 100644 aaa bbb src/modified.rs
1 MM N... 100644 100644 100644 aaa bbb src/both.rs
1 .D N... 100644 100644 000000 aaa bbb src/deleted.rs
2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\told.rs
? notes.txt
? scratch/
! target/
";
        let status = parse_porcelain_v2(text);
        assert_eq!(
            status,
            GitPromptStatus {
                branch: Some("feat/prompt".into()),
                detached: false,
                sha: Some("0123456789abcdef0123456789abcdef01234567".into()),
                upstream: Some("origin/feat/prompt".into()),
                staged: 3,
                modified: 3,
                untracked: 2,
                conflicted: 0,
                ahead: 3,
                behind: 1,
            }
        );
    }

    #[test]
    fn parses_detached_head_without_upstream() {
        let text =
            "# branch.oid deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n# branch.head (detached)\n";
        let status = parse_porcelain_v2(text);
        assert!(status.detached);
        assert_eq!(status.branch, None);
        assert_eq!(
            status.sha.as_deref(),
            Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        );
        assert_eq!(status.upstream, None);
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn parses_conflicts_and_initial_commit() {
        let text = "\
# branch.oid (initial)
# branch.head main
u UU N... 100644 100644 100644 100644 a b c both.txt
u AA N... 100644 100644 100644 100644 a b c added.txt
1 A. N... 000000 100644 100644 000 aaa new.txt
";
        let status = parse_porcelain_v2(text);
        assert_eq!(status.sha, None);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.conflicted, 2);
        assert_eq!(status.staged, 1);
        assert_eq!(status.modified, 0);
    }

    #[test]
    fn a_gone_upstream_is_not_shown_as_tracked() {
        // `branch.upstream` without `branch.ab`: configured, but the remote
        // branch no longer exists.
        let status = parse_porcelain_v2(
            "# branch.oid abc\n# branch.head feat\n# branch.upstream origin/feat\n",
        );
        assert_eq!(status.upstream, None);
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn clean_checkout_is_all_zero() {
        let status = parse_porcelain_v2("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n");
        assert_eq!(
            status.staged + status.modified + status.untracked + status.conflicted,
            0
        );
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn status_args_are_hardened_porcelain_v2() {
        let args = git_status_args();
        assert_eq!(args[0], "--no-optional-locks");
        assert!(args.windows(2).any(|w| w == ["-c", "core.fsmonitor=false"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["-c", "core.hooksPath=/dev/null"]));
        let status = args.iter().position(|a| *a == "status").unwrap();
        assert_eq!(
            &args[status..status + 3],
            &["status", "--porcelain=v2", "--branch"]
        );
    }

    #[test]
    fn reads_a_real_checkout_and_none_outside_one() {
        let dir = tempfile::tempdir().unwrap();
        // Outside any checkout there is no status, unless TMPDIR itself sits
        // inside one (then the enclosing checkout is what `git` sees).
        let enclosed = strip_attribution_env(&mut Command::new("git"))
            .args(["rev-parse", "--is-inside-work-tree"])
            .current_dir(dir.path())
            .output()
            .is_ok_and(|o| o.status.success());
        if !enclosed {
            assert_eq!(read_status(dir.path()), None);
        }
        let git = |args: &[&str]| {
            strip_attribution_env(&mut Command::new("git"))
                .args([
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .current_dir(dir.path())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
        };
        if !git(&["init", "-q", "-b", "main"]).status.success() {
            return; // no git on this machine
        }
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        assert!(git(&["add", "a.txt"]).status.success());
        assert!(git(&["commit", "-qm", "init"]).status.success());
        std::fs::write(dir.path().join("a.txt"), "b").unwrap();
        std::fs::write(dir.path().join("u.txt"), "u").unwrap();
        let status = read_status(dir.path()).expect("a checkout");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.sha.as_ref().map(String::len), Some(40));
        assert_eq!(
            (status.modified, status.untracked, status.staged),
            (1, 1, 0)
        );
        let prompt = session_prompt(Some(dir.path().into()), None);
        assert_eq!(prompt.git, Some(status));
    }

    #[test]
    fn a_timed_out_read_is_remembered_longer_than_a_status() {
        let timed_out = std::env::temp_dir().join("codesense-git-prompt-timeout-ttl");
        let mut reads = 0;
        assert_eq!(
            cached_with(&timed_out, |_| {
                reads += 1;
                Err(Miss::TimedOut)
            }),
            None
        );
        // Past the short TTL, the timeout still answers from the cache.
        if let Ok(mut cache) = cache().lock() {
            cache.get_mut(&timed_out).unwrap().at -= CACHE_TTL * 2;
        }
        assert_eq!(
            cached_with(&timed_out, |_| {
                reads += 1;
                Err(Miss::TimedOut)
            }),
            None
        );
        assert_eq!(reads, 1);

        let plain = std::env::temp_dir().join("codesense-git-prompt-plain-ttl");
        assert_eq!(cached_with(&plain, |_| Err(Miss::NoStatus)), None);
        if let Ok(mut cache) = cache().lock() {
            cache.get_mut(&plain).unwrap().at -= CACHE_TTL * 2;
        }
        let fresh = cached_with(&plain, |_| Ok(GitPromptStatus::default()));
        assert_eq!(fresh, Some(GitPromptStatus::default()));
    }

    /// Poll `done` every 20 ms for up to 5 s.
    fn eventually(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            if Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    /// A `git` stand-in: `script` run by `sh` with `$0` naming the file it
    /// writes its helper's pid to, piped as the prompt's `git` is.
    fn stand_in(script: &str, pid_file: &Path) -> Command {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .arg(pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    /// The helper pid the stand-in wrote.
    fn helper_pid(pid_file: &Path) -> u32 {
        let mut pid = None;
        assert!(eventually(|| {
            pid = std::fs::read_to_string(pid_file)
                .ok()
                .and_then(|text| text.trim().parse().ok());
            pid.is_some()
        }));
        pid.unwrap()
    }

    fn running(pid: u32) -> bool {
        codesense_platform::process::is_alive(codesense_platform::process::Pid::from_raw(pid))
    }

    /// The exit check sees `git` exit and leaves it to be reaped, with its
    /// status.
    #[test]
    fn an_exit_is_seen_without_reaping() {
        let mut running_child = Command::new("sleep").arg("30").spawn().unwrap();
        assert!(!exited_unreaped(&running_child).unwrap());
        running_child.kill().unwrap();
        running_child.wait().unwrap();

        let mut child = Command::new("sh").args(["-c", "exit 3"]).spawn().unwrap();
        assert!(eventually(|| exited_unreaped(&child).unwrap()));
        assert!(exited_unreaped(&child).unwrap(), "still unreaped");
        assert_eq!(child.wait().unwrap().code(), Some(3));
    }

    /// A `git` that outlives the timeout is killed with its whole group.
    #[test]
    fn a_timed_out_read_kills_the_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("helper.pid");
        let command = stand_in("sleep 30 & echo $! > \"$0\"; wait", &pid_file);
        assert_eq!(run(command), Err(Miss::TimedOut));
        let helper = helper_pid(&pid_file);
        assert!(eventually(|| !running(helper)), "the helper outlived it");
    }

    /// A helper `git` leaves running (not holding its output) is killed once
    /// `git`'s exit is seen: a status read's helpers do not outlive it.
    #[test]
    fn a_helper_left_behind_by_git_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("helper.pid");
        let command = stand_in("sleep 30 >/dev/null 2>&1 & echo $! > \"$0\"", &pid_file);
        assert_eq!(run(command), Ok(GitPromptStatus::default()));
        let helper = helper_pid(&pid_file);
        assert!(eventually(|| !running(helper)), "the helper outlived git");
    }

    /// A helper that still holds the output after `git` exits is killed with
    /// the group once the timeout passes.
    #[test]
    fn a_helper_holding_the_output_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("helper.pid");
        let command = stand_in("sleep 30 & echo $! > \"$0\"", &pid_file);
        assert_eq!(run(command), Err(Miss::TimedOut));
        let helper = helper_pid(&pid_file);
        assert!(eventually(|| !running(helper)), "the helper outlived it");
    }
}

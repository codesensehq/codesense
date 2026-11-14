// SPDX-License-Identifier: MIT
//! `probe_environment`: a read-only look at this Mac for the setup guide.
//!
//! It answers which agent CLIs, git and `gh` are installed, whether `gh` is signed in to
//! github.com (account and scopes), whether a folder is a git repository, and whether
//! named environment variables are set in the user's login shell. It never returns a
//! secret: the login shell runs a fixed script that prints only `0` or `1` per variable,
//! `gh auth status` is run without `--show-token` and only its account and scope lines are
//! read, and the `gh` token file is never opened.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use rmcp::schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::deps::{DependencyManager, DependencyStatus};

/// How many environment variable names one call may ask about.
pub const MAX_ENV_NAMES: usize = 32;
const MAX_ENV_NAME_LEN: usize = 128;
/// The longest `gitRepoPath` accepted, in bytes.
const MAX_REPO_PATH_LEN: usize = 1024;
/// The limit for each child the probe runs (`gh auth status`, the login shell).
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How much of each `gh` output stream is kept; the rest is read and dropped.
const MAX_OUTPUT: usize = 64 * 1024;
/// Home folders macOS guards with a privacy prompt, the File Provider and iCloud Drive
/// roots included; `/Volumes` (removable and network drives) is guarded too. A stat inside
/// one can raise the prompt against CodeSense.
const PRIVACY_HOME_DIRS: [&str; 5] = [
    "Documents",
    "Desktop",
    "Downloads",
    "Library/CloudStorage",
    "Library/Mobile Documents",
];
/// The data volume's firmlink root: `/System/Volumes/Data/Users/...` is `/Users/...`.
const DATA_VOLUME: &str = "/System/Volumes/Data";
/// The most links followed while resolving `gitRepoPath`, the kernel's own limit.
const MAX_LINK_HOPS: usize = 40;
/// How long an answer from `gh auth status` or the login shell is reused for the same
/// question, so repeated calls don't each start a child.
const ANSWER_TTL: Duration = Duration::from_secs(3);

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEnvironmentParams {
    /// An absolute folder path to test for being a git repository (it holds `.git`). At
    /// most 1024 bytes, with no `..`; a folder under ~/Documents, ~/Desktop, ~/Downloads,
    /// the cloud storage folders in ~/Library or /Volumes is refused unless it is inside a
    /// folder already attached as a source repo.
    #[serde(default)]
    pub git_repo_path: Option<String>,
    /// Environment variable names to test in the login shell (at most 32). Each is
    /// reported as set or not; a value is never read back.
    #[serde(default)]
    pub env_names: Vec<String>,
}

/// Run `gh auth status --hostname github.com` and read it into
/// `{signed_in, account, scopes}`; used by the tool.
pub fn probe_gh_auth(gh: Option<&str>, timeout: Duration) -> Value {
    let Some(gh) = gh else {
        return json!({"signed_in": false, "account": null, "scopes": [], "reason": "gh_missing"});
    };
    let args = ["auth", "status", "--hostname", "github.com"];
    match run_with_timeout(Path::new(gh), &args, timeout) {
        Some((success, output)) => parse_gh_auth(success, &output),
        None => json!({"signed_in": false, "account": null, "scopes": [], "reason": "gh_failed"}),
    }
}

/// Read `gh auth status` output. Only the github.com account and its token scopes are
/// taken; any other line, including a masked or unmasked token line, is dropped unread.
pub fn parse_gh_auth(success: bool, output: &str) -> Value {
    let mut account: Option<String> = None;
    let mut scopes: Vec<String> = Default::default();
    let mut failed = false;
    let mut on_github = false;
    for line in output.lines() {
        let line = line.trim();
        if let Some(host) = host_after(line, "Logged in to ") {
            on_github = host == "github.com";
            if on_github && account.is_none() {
                account = account_in(line);
            }
        } else if let Some(host) = host_after(line, "Failed to log in to ") {
            on_github = host == "github.com";
            failed |= on_github;
        } else if !line.is_empty() && !line.starts_with(['-', '✓', 'X', '✗']) {
            // A host heading such as `github.com` starts a new block.
            on_github = line == "github.com";
        }
        if on_github && scopes.is_empty() {
            if let Some(list) = line.split_once("Token scopes:").map(|(_, list)| list) {
                scopes = token_scopes(list);
            }
        }
    }
    let signed_in = success && !failed && account.is_some();
    json!({
        "signed_in": signed_in,
        "account": if signed_in { account } else { None },
        "scopes": if signed_in { scopes } else { vec![] },
    })
}

fn host_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let rest = &line[line.find(marker)? + marker.len()..];
    rest.split_whitespace().next()
}

fn account_in(line: &str) -> Option<String> {
    let mut words = line
        .split_whitespace()
        .skip_while(|w| *w != "account" && *w != "as");
    words.next()?;
    let name = words.next()?;
    // A GitHub login: letters, digits and hyphens.
    (name.len() <= 39
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
    .then(|| name.to_string())
}

/// The scopes in the list after `Token scopes:`, quoted (`'repo', 'read:org'`) or bare
/// (older gh: `repo, read:org`). A GitHub scope name is lower-case letters, `:` and `_`,
/// so anything else, a token included, is dropped.
fn token_scopes(list: &str) -> Vec<String> {
    list.split(',')
        .map(|item| item.trim().trim_matches('\''))
        .filter(|scope| {
            !scope.is_empty()
                && scope.len() <= 64
                && *scope != "none"
                && scope
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || matches!(c, ':' | '_'))
        })
        .map(str::to_string)
        .collect()
}

/// Read up to [`MAX_OUTPUT`] bytes of `stream` on its own thread, then keep reading and
/// dropping the rest, so a child never blocks on a full pipe.
fn drain(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Default::default();
        let mut chunk = [0u8; 8192];
        while let Ok(n @ 1..) = stream.read(&mut chunk) {
            let room = MAX_OUTPUT.saturating_sub(kept.len()).min(n);
            kept.extend_from_slice(&chunk[..room]);
        }
        let _ = sender.send(kept);
    });
    receiver
}

/// Stop `child` and everything it started: it leads its own process group, so a wrapper
/// `gh` (a version-manager shim) or a helper it spawned goes too. Always reaps the child.
fn kill_tree(child: &mut Child) {
    // The child is not reaped yet, so its pid is still its own group's id.
    crate::commands::dashboard_launch::kill_process_group(Child::id(child));
    let _ = child.kill();
    let _ = child.wait();
}

/// Spawn `path args` with no input and a hard time limit, in its own process group, with
/// stdout and stderr drained on their own threads. `None` when it cannot start or does
/// not finish in time; otherwise its success and its stdout and stderr together.
fn run_with_timeout(path: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut command = Command::new(path);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                kill_tree(&mut child);
                return None;
            }
        }
    };
    // A helper the child left running may still hold a pipe: wait no longer than the limit.
    let mut text: String = Default::default();
    for receiver in [stdout, stderr].into_iter().flatten() {
        let wait = deadline.saturating_duration_since(Instant::now());
        if let Ok(bytes) = receiver.recv_timeout(wait.max(Duration::from_millis(50))) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
        text.push('\n');
    }
    Some((status.success(), text))
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ENV_NAME_LEN
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Whether `path` is `root` or inside it, comparing names without case (APFS ignores it).
fn is_within(path: &Path, root: &Path) -> bool {
    let mut parts = path.components();
    !root.components().any(|want| {
        !parts.next().is_some_and(|have| {
            have.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&want.as_os_str().to_string_lossy())
        })
    })
}

/// `path` with a leading `/System/Volumes/Data` read as `/`, the path that firmlink names.
fn without_data_volume(path: &Path) -> PathBuf {
    if is_within(path, Path::new(DATA_VOLUME)) {
        let skipped = Path::new(DATA_VOLUME).components().count();
        Path::new("/").join(path.components().skip(skipped).collect::<PathBuf>())
    } else {
        path.to_path_buf()
    }
}

/// Whether `path` starts with a hidden top-level name, such as the macOS alias paths
/// `/.vol/<dev>/<inode>`, `/.nofollow/<path>` and `/.resolve/<n>/<path>`, which reach any
/// file without naming the folder it is in.
fn is_hidden_root(path: &Path) -> bool {
    path.components()
        .find_map(|part| match part {
            Component::Normal(name) => Some(name.to_string_lossy().starts_with('.')),
            _ => None,
        })
        .unwrap_or(false)
}

/// Whether `path` is in a folder macOS guards with a privacy prompt, and not inside a
/// folder the user already attached (which they picked, so its prompt is already settled).
/// A path under a hidden top-level name is always refused (see [`is_hidden_root`]).
fn is_privacy_guarded(path: &Path, home: Option<&Path>, attached: &[PathBuf]) -> bool {
    let path = without_data_volume(path);
    let path = path.as_path();
    if is_hidden_root(path) {
        return true;
    }
    let guarded = is_within(path, Path::new("/Volumes"))
        || home.is_some_and(|home| {
            PRIVACY_HOME_DIRS
                .iter()
                .any(|dir| is_within(path, &home.join(dir)))
        });
    guarded && !attached.iter().any(|folder| is_within(path, folder))
}

/// Check `gitRepoPath` before anything touches the disk: at most [`MAX_REPO_PATH_LEN`]
/// bytes, absolute, no `..`, and not in a privacy-guarded folder (see
/// [`is_privacy_guarded`]). Returns the path with `.` and repeated `/` removed, and the
/// data volume's firmlink spelling read as the path it names.
fn checked_repo_path(
    raw: &str,
    home: Option<&Path>,
    attached: &[PathBuf],
) -> Result<PathBuf, String> {
    if raw.len() > MAX_REPO_PATH_LEN {
        return Err(format!("gitRepoPath: at most {MAX_REPO_PATH_LEN} bytes"));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("gitRepoPath: must be an absolute path".to_string());
    }
    if path.components().any(|part| part == Component::ParentDir) {
        return Err("gitRepoPath: must not contain `..`".to_string());
    }
    let path = without_data_volume(&path.components().collect::<PathBuf>());
    if is_privacy_guarded(&path, home, attached) {
        return Err(PRIVACY_REFUSAL.to_string());
    }
    Ok(path)
}

const PRIVACY_REFUSAL: &str = "gitRepoPath: CodeSense does not look inside ~/Documents, \
     ~/Desktop, ~/Downloads, the cloud storage folders in ~/Library or /Volumes unless the \
     folder is inside one already attached as a source repo, or under a hidden top-level \
     folder such as /.vol";

/// One step left to resolve: a name, or `..` from a link target.
enum Step {
    Name(OsString),
    Up,
}

/// Queue `path`'s components so the first comes off the end next.
fn push_steps(steps: &mut Vec<Step>, path: &Path) {
    for part in path.components().rev() {
        match part {
            Component::Normal(name) => steps.push(Step::Name(name.to_os_string())),
            Component::ParentDir => steps.push(Step::Up),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
}

/// Resolve `path` one component at a time without following anything unchecked: each
/// path is checked before it is looked at, and a link is read with `read_link` and its
/// target walked the same way. A step may pass through a guarded folder only on the way to
/// an attached folder inside it; the result must not be guarded. `Ok(None)` when a
/// component is missing or the links loop.
fn resolve_checked(
    path: &Path,
    home: Option<&Path>,
    attached: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    let mut steps: Vec<Step> = Default::default();
    push_steps(&mut steps, path);
    let mut resolved = PathBuf::from("/");
    let mut hops = 0;
    while let Some(step) = steps.pop() {
        let name = match step {
            Step::Up => {
                resolved.pop();
                continue;
            }
            Step::Name(name) => name,
        };
        let candidate = resolved.join(name);
        let on_the_way = attached
            .iter()
            .any(|folder| is_within(folder, &without_data_volume(&candidate)));
        if !on_the_way && is_privacy_guarded(&candidate, home, attached) {
            return Err(PRIVACY_REFUSAL.to_string());
        }
        let Ok(meta) = std::fs::symlink_metadata(&candidate) else {
            return Ok(None);
        };
        if !meta.file_type().is_symlink() {
            resolved = candidate;
            continue;
        }
        hops += 1;
        let Ok(target) = std::fs::read_link(&candidate) else {
            return Ok(None);
        };
        if hops > MAX_LINK_HOPS {
            return Ok(None);
        }
        if target.is_absolute() {
            resolved = PathBuf::from("/");
        }
        push_steps(&mut steps, &target);
    }
    if is_privacy_guarded(&resolved, home, attached) {
        return Err(PRIVACY_REFUSAL.to_string());
    }
    Ok(Some(resolved))
}

/// Check the arguments before anything runs: the variable names, and `gitRepoPath`
/// (see [`checked_repo_path`]), which is returned.
pub fn check_params(
    params: &ProbeEnvironmentParams,
    home: Option<&Path>,
    attached: &[PathBuf],
) -> Result<Option<PathBuf>, String> {
    if params.env_names.len() > MAX_ENV_NAMES {
        return Err(format!("envNames: at most {MAX_ENV_NAMES} names"));
    }
    if let Some(bad) = params.env_names.iter().find(|n| !valid_env_name(n)) {
        return Err(format!(
            "envNames: {bad:?} is not a variable name (letters, digits and _ only)"
        ));
    }
    params
        .git_repo_path
        .as_deref()
        .map(|raw| checked_repo_path(raw, home, attached))
        .transpose()
}

/// `git_repo` for a checked path, resolved by [`resolve_checked`] so a link into a guarded
/// folder is refused before anything in that folder is looked at.
fn git_repo_report(
    raw: &str,
    path: &Path,
    home: Option<&Path>,
    attached: &[PathBuf],
) -> Result<Value, String> {
    let Some(real) = resolve_checked(path, home, attached)? else {
        return Ok(json!({"path": raw, "exists": false, "is_repo": false}));
    };
    let exists = real.is_dir();
    Ok(json!({
        "path": raw,
        "exists": exists,
        // `.git` is a folder in a clone and a file in a linked worktree; a link there is
        // counted without being followed.
        "is_repo": exists && std::fs::symlink_metadata(real.join(".git")).is_ok(),
    }))
}

/// Assemble the report from facts already gathered. `env_is_set` answers for one
/// variable name: whether the login shell exports it with a non-empty value, or `None`
/// when the shell could not be read. `home` and `attached` scope `gitRepoPath`.
pub fn build_report(
    status: &DependencyStatus,
    params: &ProbeEnvironmentParams,
    home: Option<&Path>,
    attached: &[PathBuf],
    gh_auth: Value,
    env_is_set: impl Fn(&str) -> Option<bool>,
) -> Result<Value, String> {
    let repo_path = check_params(params, home, attached)?;
    let clis: BTreeMap<&str, Value> = status
        .agents
        .iter()
        .map(|(name, agent)| {
            (
                name.as_str(),
                json!({
                    "available": agent.available,
                    "version": agent.version,
                    "resolving": agent.resolving,
                }),
            )
        })
        .collect();
    let mut report = json!({
        "clis": clis,
        "git": {"available": status.git.available, "version": status.git.version},
        "gh_version": status.gh.version,
        "gh_auth": gh_auth,
    });
    if let (Some(raw), Some(path)) = (&params.git_repo_path, repo_path) {
        report["git_repo"] = git_repo_report(raw, &path, home, attached)?;
    }
    if !params.env_names.is_empty() {
        let set: BTreeMap<&str, Option<bool>> = params
            .env_names
            .iter()
            .map(|name| (name.as_str(), env_is_set(name)))
            .collect();
        report["env_set"] = json!(set);
    }
    Ok(report)
}

/// The dependency status, with `gh` re-resolved first when it is not found: the guide
/// may have just installed it. `re_resolve_gh` is [`DependencyManager::re_resolve_gh`]
/// outside tests. Blocking.
fn status_with_fresh_gh(
    deps: &DependencyManager,
    re_resolve_gh: impl FnOnce(&DependencyManager),
) -> DependencyStatus {
    let status = DependencyManager::status(deps);
    if status.gh.available {
        return status;
    }
    re_resolve_gh(deps);
    DependencyManager::status(deps)
}

/// The answer for `key` from `answers` when one is younger than `ttl`, else `run`'s, kept
/// for the next caller. The lock is held while `run` runs, so concurrent callers wait for
/// one answer rather than each starting a child.
fn recent_or_run<K: PartialEq, V: Clone>(
    answers: &Mutex<Vec<(K, Instant, V)>>,
    ttl: Duration,
    key: K,
    run: impl FnOnce() -> V,
) -> V {
    let mut answers = answers.lock().unwrap_or_else(|e| e.into_inner());
    answers.retain(|(_, at, _)| at.elapsed() < ttl);
    if let Some((_, _, answer)) = answers.iter().find(|(asked, _, _)| *asked == key) {
        return answer.clone();
    }
    let answer = run();
    answers.push((key, Instant::now(), answer.clone()));
    answer
}

/// Recent `gh auth status` answers, by the `gh` path asked.
static GH_AUTH_ANSWERS: LazyLock<Mutex<Vec<(Option<String>, Instant, Value)>>> =
    LazyLock::new(Default::default);
/// The login shell's answer: one bool per name asked, `None` when it could not be read.
type EnvAnswer = Option<Vec<bool>>;
/// Recent login-shell answers, by the variable names asked.
static ENV_SET_ANSWERS: LazyLock<Mutex<Vec<(Vec<String>, Instant, EnvAnswer)>>> =
    LazyLock::new(Default::default);

/// The folders attached as source repos on this Mac, by any local profile.
fn attached_folders() -> Vec<PathBuf> {
    crate::commands::paths::codesense_home_dir()
        .map(|home| crate::attribution::prefs::all_attached_checkouts(&home))
        .unwrap_or_default()
}

/// The tool: the arguments are checked first, then, off the async runtime, the
/// dependency status (gh re-resolved when missing), `gh auth status` and the login-shell
/// variable check run side by side, each under [`PROBE_TIMEOUT`]. An answer to the same
/// question within [`ANSWER_TTL`] is reused.
pub async fn probe_environment_request(
    app: tauri::AppHandle,
    params: ProbeEnvironmentParams,
) -> Result<Value, String> {
    use tauri::Manager;
    let home = dirs::home_dir();
    let attached = if params.git_repo_path.is_some() {
        attached_folders()
    } else {
        Default::default()
    };
    check_params(&params, home.as_deref(), &attached)?;
    crate::commands::await_blocking("mcp.probe_environment", move || {
        let deps: &DependencyManager = app
            .try_state::<DependencyManager>()
            .ok_or_else(|| "the dependency manager is not available".to_string())?
            .inner();
        let status = status_with_fresh_gh(deps, DependencyManager::re_resolve_gh);
        let names: Vec<&str> = params.env_names.iter().map(String::as_str).collect();
        let (gh_auth, env_set) = std::thread::scope(|scope| {
            let env_set = (!names.is_empty()).then(|| {
                scope.spawn(|| {
                    let key = params.env_names.clone();
                    recent_or_run(&*ENV_SET_ANSWERS, ANSWER_TTL, key, || {
                        crate::commands::deps::login_shell_env_set(&names, PROBE_TIMEOUT)
                    })
                })
            });
            let gh_path = status.gh.path.clone();
            let gh_auth = recent_or_run(&*GH_AUTH_ANSWERS, ANSWER_TTL, gh_path, || {
                probe_gh_auth(status.gh.path.as_deref(), PROBE_TIMEOUT)
            });
            (
                gh_auth,
                env_set.and_then(|handle| handle.join().ok()).flatten(),
            )
        });
        // Each name with the shell's answer; empty when the shell could not be read.
        let answers: BTreeMap<&str, bool> = names
            .iter()
            .copied()
            .zip(env_set.into_iter().flatten())
            .collect();
        build_report(
            &status,
            &params,
            home.as_deref(),
            &attached,
            gh_auth,
            |name| answers.get(name).copied(),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::deps::GhStatus;

    // Built at run time so no token-shaped literal sits in the source.
    fn token() -> String {
        ["ghp", "_0123456789abcdefghijklmnopqrstuvwxyzAB"].concat()
    }

    fn oauth() -> String {
        ["gho", "_SECRETSECRETSECRETSECRETSECRETSECRET"].concat()
    }

    fn status() -> DependencyStatus {
        let mut status =
            DependencyManager::cached_for_test(&[("claude", Some("2.1.150")), ("codex", None)])
                .status();
        status.gh = GhStatus {
            available: true,
            path: Some("/opt/homebrew/bin/gh".to_string()),
            version: Some("2.50.0".to_string()),
            resolving: false,
        };
        status
    }

    /// `build_report` with no home folder, nothing attached and an env lookup.
    fn report(
        params: &ProbeEnvironmentParams,
        gh_auth: Value,
        env_is_set: impl Fn(&str) -> Option<bool>,
    ) -> Result<Value, String> {
        build_report(&status(), params, None, &[], gh_auth, env_is_set)
    }

    fn signed_in_output() -> String {
        let oauth = oauth();
        format!(
            "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: {oauth}\n  - Token scopes: 'gist', 'read:org', 'repo'\n"
        )
    }

    #[test]
    fn reports_clis_git_and_the_gh_version_without_paths() {
        let report = report(
            &ProbeEnvironmentParams::default(),
            json!({"signed_in": false}),
            |_| Some(false),
        )
        .unwrap();
        assert_eq!(report["clis"]["claude"]["available"], true);
        assert_eq!(report["clis"]["claude"]["version"], "2.1.150");
        assert_eq!(report["clis"]["codex"]["version"], Value::Null);
        assert_eq!(report["git"]["available"], false);
        assert_eq!(report["gh_version"], "2.50.0");
        let text = report.to_string();
        assert!(!text.contains("/bin/"), "no install path in {text}");
        assert!(report.get("git_repo").is_none());
        assert!(report.get("env_set").is_none());
    }

    #[test]
    fn gh_auth_reads_the_account_and_scopes() {
        let oauth = oauth();
        let auth = parse_gh_auth(true, &signed_in_output());
        assert_eq!(auth["signed_in"], true);
        assert_eq!(auth["account"], "octocat");
        assert_eq!(auth["scopes"], json!(["gist", "read:org", "repo"]));
        assert!(!auth.to_string().contains(&oauth));
    }

    #[test]
    fn gh_auth_reads_the_older_output_format() {
        let out = "github.com\n  ✓ Logged in to github.com as octocat (oauth_token)\n  ✓ Token: *******************\n  ✓ Token scopes: gist, repo\n";
        let auth = parse_gh_auth(true, out);
        assert_eq!(auth["signed_in"], true);
        assert_eq!(auth["account"], "octocat");
        assert_eq!(auth["scopes"], json!(["gist", "repo"]));
    }

    #[test]
    fn gh_auth_says_not_signed_in() {
        let none = parse_gh_auth(
            false,
            "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
        );
        assert_eq!(none["signed_in"], false);
        assert_eq!(none["account"], Value::Null);
        assert_eq!(none["scopes"], json!([]));

        let bad = parse_gh_auth(
            false,
            "github.com\n  X Failed to log in to github.com account octocat (keyring)\n  - The token in keyring is invalid.\n",
        );
        assert_eq!(bad["signed_in"], false);

        let other_host = parse_gh_auth(
            true,
            "ghe.example.com\n  ✓ Logged in to ghe.example.com account octocat (keyring)\n",
        );
        assert_eq!(other_host["signed_in"], false);
    }

    #[test]
    fn gh_auth_drops_anything_that_is_not_a_login_or_scope() {
        let token = token();
        let out = format!(
            "  ✓ Logged in to github.com account {token} (keyring)\n  - Token scopes: '{token}', 'repo'\n"
        );
        let auth = parse_gh_auth(true, &out);
        assert_eq!(
            auth["signed_in"], false,
            "a token-shaped account is refused"
        );
        assert!(!auth.to_string().contains(&token));
        let scopes = token_scopes(&format!(" '{token}extra words', 'repo'"));
        assert_eq!(scopes, vec!["repo".to_string()]);
    }

    #[test]
    fn a_bare_token_in_the_scopes_of_a_valid_account_is_dropped() {
        let token = token();
        for out in [
            format!("github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token scopes: '{token}', 'repo'\n"),
            format!("github.com\n  ✓ Logged in to github.com as octocat (oauth_token)\n  ✓ Token scopes: {token}, repo\n"),
        ] {
            let auth = parse_gh_auth(true, &out);
            assert_eq!(auth["signed_in"], true);
            assert_eq!(auth["scopes"], json!(["repo"]));
            assert!(!auth.to_string().contains(&token));
        }
        // Scope names are lower-case letters, `:` and `_` only.
        assert_eq!(
            token_scopes(" 'Repo', 'admin:org', 'x1', 'workflow', 'none'"),
            vec!["admin:org".to_string(), "workflow".to_string()]
        );
    }

    #[test]
    fn env_set_is_a_bool_and_a_token_value_never_appears() {
        let oauth = oauth();
        let token = token();
        let env: BTreeMap<&str, &str> = [("GH_TOKEN", token.as_str()), ("EMPTY_ONE", "")].into();
        let params = ProbeEnvironmentParams {
            git_repo_path: None,
            env_names: vec!["GH_TOKEN".into(), "EMPTY_ONE".into(), "NOT_THERE".into()],
        };
        let gh_auth = parse_gh_auth(true, &signed_in_output());
        let report = report(&params, gh_auth, |name| {
            Some(env.get(name).is_some_and(|v| !v.is_empty()))
        })
        .unwrap();
        assert_eq!(
            report["env_set"],
            json!({"GH_TOKEN": true, "EMPTY_ONE": false, "NOT_THERE": false})
        );
        let text = report.to_string();
        for secret in [token.as_str(), oauth.as_str(), "ghp_", "gho_"] {
            assert!(!text.contains(secret), "{secret} leaked into {text}");
        }
    }

    #[test]
    fn env_set_is_null_when_the_login_shell_could_not_be_read() {
        let params = ProbeEnvironmentParams {
            git_repo_path: None,
            env_names: vec!["GH_TOKEN".into()],
        };
        let report = report(&params, json!({}), |_| None).unwrap();
        assert_eq!(report["env_set"], json!({"GH_TOKEN": null}));
    }

    #[test]
    fn env_names_are_checked() {
        let long = "A".repeat(129);
        for bad in ["", "1ABC", "A B", "A=B", "A$(x)", "a\nb", long.as_str()] {
            let params = ProbeEnvironmentParams {
                git_repo_path: None,
                env_names: vec![bad.to_string()],
            };
            assert!(
                report(&params, json!({}), |_| Some(false)).is_err(),
                "{bad:?}"
            );
        }
        let many = ProbeEnvironmentParams {
            git_repo_path: None,
            env_names: (0..=MAX_ENV_NAMES).map(|i| format!("V{i}")).collect(),
        };
        assert!(report(&many, json!({}), |_| Some(false)).is_err());
    }

    #[test]
    fn git_repo_tells_a_repo_from_a_folder_and_a_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        let linked = dir.path().join("linked");
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join(".git"), "gitdir: /elsewhere\n").unwrap();
        std::fs::create_dir_all(&plain).unwrap();
        let probe = |p: &Path| {
            let params = ProbeEnvironmentParams {
                git_repo_path: Some(p.display().to_string()),
                env_names: vec![],
            };
            report(&params, json!({}), |_| Some(false)).unwrap()["git_repo"].clone()
        };
        assert_eq!(probe(&repo)["is_repo"], true);
        assert_eq!(probe(&linked)["is_repo"], true);
        assert_eq!(probe(&plain)["is_repo"], false);
        let missing = probe(&dir.path().join("nope"));
        assert_eq!(
            (missing["exists"].clone(), missing["is_repo"].clone()),
            (json!(false), json!(false))
        );

        let relative = ProbeEnvironmentParams {
            git_repo_path: Some("relative/repo".into()),
            env_names: vec![],
        };
        assert!(report(&relative, json!({}), |_| Some(false)).is_err());
    }

    #[test]
    fn git_repo_path_is_capped_and_refuses_parent_steps() {
        let probe = |path: String| ProbeEnvironmentParams {
            git_repo_path: Some(path),
            env_names: vec![],
        };
        let long = format!("/{}", "a".repeat(MAX_REPO_PATH_LEN));
        assert!(report(&probe(long), json!({}), |_| None).is_err());
        assert!(report(&probe("/tmp/../etc".into()), json!({}), |_| None).is_err());
        let ok = report(
            &probe("/nonexistent-probe-dir/./x".into()),
            json!({}),
            |_| None,
        )
        .unwrap();
        assert_eq!(ok["git_repo"]["exists"], false);
    }

    #[test]
    fn privacy_guarded_folders_are_refused_unless_attached() {
        let home = Path::new("/home/user");
        let attached = [home.join("Documents/code/app")];
        let check = |raw: &str| checked_repo_path(raw, Some(home), &attached);
        for refused in [
            "/home/user/Documents",
            "/home/user/Documents/other",
            "/home/user/documents/other",
            "/home/user/Desktop/x",
            "/home/user/Downloads/x",
            "/Volumes/USB/repo",
            "/Volumes",
            "/home/user/Library/CloudStorage/Drive-user/repo",
            "/home/user/Library/Mobile Documents/com~apple~CloudDocs/repo",
            "/System/Volumes/Data/home/user/Documents/other",
            "/system/volumes/data/home/user/Desktop",
            "/System/Volumes/Data/Volumes/USB/repo",
            "/.vol/16777220/12345",
            "/.nofollow/home/user/Documents/x",
            "/.resolve/1/home/user/Documents/x",
            "/.vol",
            "/System/Volumes/Data/.vol/16777220/12345",
        ] {
            let error = check(refused).unwrap_err();
            assert!(error.contains("does not look inside"), "{refused}: {error}");
        }
        for allowed in [
            "/home/user/Documents/code/app",
            "/home/user/Documents/code/app/sub",
            "/home/user/src/app",
            "/home/user/DocumentsArchive",
            "/home/user/Library/Caches/x",
            "/tmp/x",
        ] {
            assert!(check(allowed).is_ok(), "{allowed}");
        }
        // The data volume's firmlink spelling is read as the path it names.
        assert_eq!(
            check("/System/Volumes/Data/home/user/src/app"),
            Ok(PathBuf::from("/home/user/src/app"))
        );
        assert!(check("/System/Volumes/Data/home/user/Documents/code/app").is_ok());
    }

    /// Each link is read and its target checked before anything at that target is looked
    /// at, so a link into a guarded folder is refused even where the target is missing (a
    /// lookup there would have answered "missing" after touching the folder).
    #[cfg(unix)]
    #[test]
    fn every_link_hop_is_checked_before_it_is_followed() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(home.join("Documents")).unwrap();
        std::fs::create_dir_all(home.join("code")).unwrap();
        std::fs::create_dir_all(home.join("real/app/.git")).unwrap();
        // Absolute, relative and two-hop links into the guarded folder, at missing targets.
        symlink(home.join("Documents/missing/deeper"), home.join("code/abs")).unwrap();
        symlink("../Documents/missing", home.join("code/rel")).unwrap();
        symlink(home.join("code/abs"), home.join("code/hop")).unwrap();
        symlink(home.join("code/rel/x"), home.join("code/through")).unwrap();
        // A link outside any guarded folder is followed as before.
        symlink("../real/app", home.join("code/app")).unwrap();
        symlink(home.join("code/loop"), home.join("code/loop")).unwrap();
        // A link to a macOS alias path is refused before the alias is looked up.
        symlink("/.vol/16777220/12345", home.join("code/vol")).unwrap();
        let probe = |path: PathBuf| {
            let params = ProbeEnvironmentParams {
                git_repo_path: Some(path.display().to_string()),
                env_names: vec![],
            };
            build_report(
                &status(),
                &params,
                Some(home.as_path()),
                &[],
                json!({}),
                |_| None,
            )
        };
        for link in ["abs", "rel", "hop", "through", "vol"] {
            let error = probe(home.join("code").join(link)).unwrap_err();
            assert!(error.contains("does not look inside"), "{link}: {error}");
        }
        let app = probe(home.join("code/app")).unwrap();
        assert_eq!(app["git_repo"]["is_repo"], true);
        assert_eq!(
            probe(home.join("code/loop")).unwrap()["git_repo"]["exists"],
            false
        );
    }

    /// A `.git` link is counted as present without being followed.
    #[cfg(unix)]
    #[test]
    fn a_git_link_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::os::unix::fs::symlink(home.join("Documents/secret/.git"), repo.join(".git")).unwrap();
        let params = ProbeEnvironmentParams {
            git_repo_path: Some(repo.display().to_string()),
            env_names: vec![],
        };
        let report = build_report(
            &status(),
            &params,
            Some(home.as_path()),
            &[],
            json!({}),
            |_| None,
        )
        .unwrap();
        assert_eq!(report["git_repo"]["is_repo"], true);
    }

    #[test]
    fn a_recent_answer_is_reused_and_one_run_serves_concurrent_callers() {
        let answers: Mutex<Vec<(&str, Instant, u32)>> = Default::default();
        let runs = std::sync::atomic::AtomicU32::new(0);
        let run = || {
            std::thread::sleep(Duration::from_millis(100));
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
        };
        let ttl = Duration::from_secs(60);
        let (a, b) = std::thread::scope(|scope| {
            let a = scope.spawn(|| recent_or_run(&answers, ttl, "k", run));
            let b = scope.spawn(|| recent_or_run(&answers, ttl, "k", run));
            (a.join().unwrap(), b.join().unwrap())
        });
        assert_eq!((a, b), (1, 1));
        assert_eq!(recent_or_run(&answers, ttl, "other", run), 2);
        assert_eq!(recent_or_run(&answers, Duration::ZERO, "k", run), 3);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_into_a_guarded_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let guarded = home.join("Documents").join("repo");
        std::fs::create_dir_all(guarded.join(".git")).unwrap();
        let link = home.join("link");
        std::os::unix::fs::symlink(&guarded, &link).unwrap();
        let params = ProbeEnvironmentParams {
            git_repo_path: Some(link.display().to_string()),
            env_names: vec![],
        };
        let refused = build_report(
            &status(),
            &params,
            Some(home.as_path()),
            &[],
            json!({}),
            |_| None,
        );
        assert!(refused.is_err());
        let attached = [guarded.clone()];
        let allowed = build_report(
            &status(),
            &params,
            Some(home.as_path()),
            &attached,
            json!({}),
            |_| None,
        )
        .unwrap();
        assert_eq!(allowed["git_repo"]["is_repo"], true);
    }

    #[test]
    fn a_missing_gh_is_resolved_again_before_the_probe() {
        let deps = DependencyManager::cached_for_test(&[("claude", Some("2.1.150"))]);
        let status = status_with_fresh_gh(&deps, |deps| {
            deps.set_gh_for_test("/opt/homebrew/bin/gh", "2.60.0")
        });
        assert!(status.gh.available);
        assert_eq!(status.gh.version.as_deref(), Some("2.60.0"));

        // A gh that is already found is not resolved again.
        let again = status_with_fresh_gh(&deps, |_| panic!("re-resolved a found gh"));
        assert_eq!(again.gh.version.as_deref(), Some("2.60.0"));
    }

    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_gh_is_run_with_fixed_arguments_and_its_token_stays_out() {
        let oauth = oauth();
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(
            dir.path(),
            &format!(
                "[ \"$*\" = \"auth status --hostname github.com\" ] || exit 9\necho 'github.com'\necho '  ✓ Logged in to github.com account octocat (keyring)'\necho '  - Token: {oauth}'\necho \"  - Token scopes: 'repo'\" >&2"
            ),
        );
        let auth = probe_gh_auth(gh.to_str(), Duration::from_secs(5));
        assert_eq!(auth["signed_in"], true);
        assert_eq!(auth["account"], "octocat");
        assert_eq!(auth["scopes"], json!(["repo"]));
        assert!(!auth.to_string().contains(&oauth));
    }

    #[cfg(unix)]
    #[test]
    fn a_gh_that_hangs_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(dir.path(), "sleep 30");
        let start = Instant::now();
        let auth = probe_gh_auth(gh.to_str(), Duration::from_millis(200));
        assert!(start.elapsed() < Duration::from_secs(10));
        assert_eq!(auth["signed_in"], false);
        assert_eq!(auth["reason"], "gh_failed");
    }

    #[cfg(unix)]
    #[test]
    fn a_gh_with_more_output_than_a_pipe_holds_still_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(
            dir.path(),
            "head -c 300000 /dev/zero | tr '\\0' x\necho\necho '  ✓ Logged in to github.com account octocat (keyring)' >&2\nhead -c 300000 /dev/zero | tr '\\0' y >&2",
        );
        let auth = probe_gh_auth(gh.to_str(), Duration::from_secs(5));
        assert_eq!(auth["signed_in"], true, "{auth}");
        assert_eq!(auth["account"], "octocat");
    }

    #[cfg(unix)]
    #[test]
    fn a_gh_that_hangs_is_stopped_with_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("helper.pid");
        let gh = fake_gh(
            dir.path(),
            &format!("sleep 30 &\necho $! > '{}'\nsleep 30", pid_file.display()),
        );
        let auth = probe_gh_auth(gh.to_str(), Duration::from_millis(500));
        assert_eq!(auth["reason"], "gh_failed");
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process still exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "the helper gh started outlived it"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_missing_gh_is_reported_not_signed_in() {
        let auth = probe_gh_auth(None, Duration::from_secs(1));
        assert_eq!(auth["signed_in"], false);
        assert_eq!(auth["reason"], "gh_missing");
    }
}

// SPDX-License-Identifier: MIT
//! `probe_environment`: a read-only look at this Mac for the setup guide.
//!
//! It answers which agent CLIs, git and `gh` are installed, whether `gh` is signed in
//! (account and scopes), whether a folder is a git repository, and whether named
//! environment variables are set. It never returns a secret: an environment variable is
//! reported as a bool, `gh auth status` is run without `--show-token` and only its account
//! and scope lines are read, and the `gh` token file is never opened.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rmcp::schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::deps::{DependencyManager, DependencyStatus};

/// How many environment variable names one call may ask about.
pub const MAX_ENV_NAMES: usize = 32;
const MAX_ENV_NAME_LEN: usize = 128;
const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEnvironmentParams {
    /// An absolute folder path to test for being a git repository (it holds `.git`).
    #[serde(default)]
    pub git_repo_path: Option<String>,
    /// Environment variable names to test (at most 32). Each is reported as set or not; a
    /// value is never returned.
    #[serde(default)]
    pub env_names: Vec<String>,
}

/// Run `gh auth status` and read it into `{signedIn, account, scopes}`; used by the tool.
pub fn probe_gh_auth(gh: Option<&str>, timeout: Duration) -> Value {
    let Some(gh) = gh else {
        return json!({"signed_in": false, "account": null, "scopes": [], "reason": "gh_missing"});
    };
    match run_with_timeout(Path::new(gh), &["auth", "status"], timeout) {
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
        if on_github && line.contains("Token scopes:") && scopes.is_empty() {
            scopes = quoted_scopes(line);
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

fn quoted_scopes(line: &str) -> Vec<String> {
    line.split('\'')
        .skip(1)
        .step_by(2)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
        })
        .map(str::to_string)
        .collect()
}

/// Spawn `path args` with no input and a hard time limit. `None` when it cannot start or
/// does not finish; otherwise its success and its stdout and stderr together.
fn run_with_timeout(path: &Path, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let mut child = Command::new(path)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return None,
        }
    };
    let mut text: String = Default::default();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.by_ref().take(64 * 1024).read_to_string(&mut text);
    }
    if let Some(mut err) = child.stderr.take() {
        text.push('\n');
        let _ = err.by_ref().take(64 * 1024).read_to_string(&mut text);
    }
    Some((status.success(), text))
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ENV_NAME_LEN
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Assemble the report from facts already gathered. `env_is_set` answers for one
/// variable name and returns only whether it is set to a non-empty value.
pub fn build_report(
    status: &DependencyStatus,
    params: &ProbeEnvironmentParams,
    gh_auth: Value,
    env_is_set: impl Fn(&str) -> bool,
) -> Result<Value, String> {
    if params.env_names.len() > MAX_ENV_NAMES {
        return Err(format!("envNames: at most {MAX_ENV_NAMES} names"));
    }
    if let Some(bad) = params.env_names.iter().find(|n| !valid_env_name(n)) {
        return Err(format!(
            "envNames: {bad:?} is not a variable name (letters, digits and _ only)"
        ));
    }
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
    if let Some(path) = &params.git_repo_path {
        let folder = Path::new(path);
        if !folder.is_absolute() {
            return Err("gitRepoPath: must be an absolute path".to_string());
        }
        let exists = folder.is_dir();
        report["git_repo"] = json!({
            "path": path,
            "exists": exists,
            // `.git` is a folder in a clone and a file in a linked worktree.
            "is_repo": exists && folder.join(".git").exists(),
        });
    }
    if !params.env_names.is_empty() {
        let set: BTreeMap<&str, bool> = params
            .env_names
            .iter()
            .map(|name| (name.as_str(), env_is_set(name)))
            .collect();
        report["env_set"] = json!(set);
    }
    Ok(report)
}

/// The tool: status from the dependency manager, `gh auth status` and the folder and
/// variable checks, all off the async runtime.
pub async fn probe_environment_request(
    app: tauri::AppHandle,
    params: ProbeEnvironmentParams,
) -> Result<Value, String> {
    use tauri::Manager;
    let status = app
        .try_state::<DependencyManager>()
        .ok_or_else(|| "the dependency manager is not available".to_string())?
        .status();
    crate::commands::await_blocking("mcp.probe_environment", move || {
        let gh_auth = probe_gh_auth(status.gh.path.as_deref(), GH_AUTH_TIMEOUT);
        build_report(&status, &params, gh_auth, |name| {
            std::env::var_os(name).is_some_and(|value| !value.is_empty())
        })
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
        };
        status
    }

    fn signed_in_output() -> String {
        let oauth = oauth();
        format!(
            "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: {oauth}\n  - Token scopes: 'gist', 'read:org', 'repo'\n"
        )
    }

    #[test]
    fn reports_clis_git_and_the_gh_version_without_paths() {
        let report = build_report(
            &status(),
            &ProbeEnvironmentParams::default(),
            json!({"signed_in": false}),
            |_| false,
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
        let scopes = quoted_scopes(&format!("- Token scopes: '{token}extra words', 'repo'"));
        assert_eq!(scopes, vec!["repo".to_string()]);
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
        let report = build_report(&status(), &params, gh_auth, |name| {
            env.get(name).is_some_and(|v| !v.is_empty())
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
    fn env_names_are_checked() {
        let long = "A".repeat(129);
        for bad in ["", "1ABC", "A B", "A=B", "A$(x)", "a\nb", long.as_str()] {
            let params = ProbeEnvironmentParams {
                git_repo_path: None,
                env_names: vec![bad.to_string()],
            };
            assert!(
                build_report(&status(), &params, json!({}), |_| false).is_err(),
                "{bad:?}"
            );
        }
        let many = ProbeEnvironmentParams {
            git_repo_path: None,
            env_names: (0..=MAX_ENV_NAMES).map(|i| format!("V{i}")).collect(),
        };
        assert!(build_report(&status(), &many, json!({}), |_| false).is_err());
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
            build_report(&status(), &params, json!({}), |_| false).unwrap()["git_repo"].clone()
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
        assert!(build_report(&status(), &relative, json!({}), |_| false).is_err());
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
                "[ \"$1 $2 $#\" = \"auth status 2\" ] || exit 9\necho 'github.com'\necho '  ✓ Logged in to github.com account octocat (keyring)'\necho '  - Token: {oauth}'\necho \"  - Token scopes: 'repo'\" >&2"
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

    #[test]
    fn a_missing_gh_is_reported_not_signed_in() {
        let auth = probe_gh_auth(None, Duration::from_secs(1));
        assert_eq!(auth["signed_in"], false);
        assert_eq!(auth["reason"], "gh_missing");
    }
}

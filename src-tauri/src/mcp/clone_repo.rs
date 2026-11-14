// SPDX-License-Identifier: MIT
//! `clone_repo`: the setup guide's one clone verb.
//!
//! The agent has no shell, so the inputs of a clone are checked here, in Rust,
//! before anything runs. [`validate_clone`] holds the rules; the `#[tool]` method
//! in [`super::handler`] calls it first, and only a [`ValidClone`] reaches the
//! terminal tab, which runs `git clone -- https://github.com/<repo>.git <path>` as an
//! argument vector (the tab's first process, no shell, nothing interpolated). Setup
//! needs no `gh`: git signs in to the host however the person has set it up.
//!
//! `path` is the clone's own folder and its parent is derived from it, so the bound
//! on where a clone may land is the home rule: `path` sits under the profile's home
//! folder, not under `~/Library`, and no segment below home starts with `.` (so no
//! dot folder like `~/.ssh` or `~/.config/git`). The parent must be a real,
//! non-symlink directory, and the last segment is the repo's name.
//!
//! A directory the verb creates is recorded in [`CloneRecords`] with the tab that
//! clones into it; `stop` closes that tab, then removes only a recorded folder whose
//! clone hasn't finished. A folder that was already there (empty) is never recorded,
//! so Stop leaves it alone, and the record ends when the clone is bound.
//!
//! Accepted residual: between validation and the clone, a local writer could swap
//! the parent for a symlink or create the target first. Closing that needs a clone
//! anchored on an open directory handle, which `git clone` can't take; Stop's
//! refusal of a finished checkout bounds the second case.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The host every clone comes from, fixed for now.
pub(crate) const CLONE_HOST: &str = "https://github.com";
/// How long a call waits for the clone before it replies, kept well under the
/// shortest MCP tool timeout a runtime applies (60 s).
pub(crate) const CLONE_WAIT_SECS: u64 = 25;
/// The longest `path` accepted, in bytes.
pub(crate) const MAX_PATH_BYTES: usize = 1024;
const MAX_OWNER_BYTES: usize = 39;
const MAX_NAME_BYTES: usize = 100;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloneRepoParams {
    /// `owner/name` on GitHub, e.g. `acme/api`. A URL, `@`, `:`, a space or any
    /// non-ASCII character is refused.
    pub repo: String,
    /// The absolute folder to clone into: `<a parent folder that exists>/<name>`, under
    /// your home folder but not `~/Library`, with no segment below home starting with
    /// `.`. Its last segment must equal the repo's name; the target must be absent or
    /// empty; the parent must be a real directory with no symlink in its path.
    pub path: String,
    /// The team's org (`owner/repo` slug) whose tracked `repo` the clone is bound to.
    /// Required unless `stop` is true.
    #[serde(default)]
    pub org: Option<String>,
    /// The team that tracks `repo`. Required unless `stop` is true.
    #[serde(default)]
    pub team: Option<String>,
    /// The viewer id of an open workspace that hosts the visible tab. Required unless
    /// `stop` is true.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// `true` stops the clone: it closes the clone's tab, then removes `path` only when
    /// an earlier `clone_repo` call created it and the clone hasn't finished. Nothing
    /// else is touched. Use it when the person stops a clone.
    #[serde(default)]
    pub stop: Option<bool>,
}

/// What a clone call reports, so the step can probe it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStarted {
    pub repo: String,
    pub path: String,
    /// The verb created the folder (it was absent). Only then does Stop remove it.
    pub created: bool,
    /// The visible tab running the clone, for `read_terminal_tab`.
    pub tab: serde_json::Value,
    /// `git` exited before the clone finished: it failed, and the tab says why.
    pub git_exited: bool,
    /// The clone had finished and was bound with `attach_source_repo_path`.
    pub attached: bool,
    /// The binding, when `attached`.
    pub source: Option<crate::commands::source_repo_add::TrackedSourceRepo>,
    /// Why it isn't attached yet: the clone is still running (probe the folder, then call
    /// `attach_source_repo_path`), `git` exited first, or the binding was refused.
    pub note: Option<String>,
}

/// What a stop call did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStopped {
    /// The folder was created by `clone_repo` and is now gone.
    pub removed: bool,
    /// Why nothing was removed: `not_recorded` (not a folder this verb created, or
    /// already stopped or bound), `not_a_folder` (gone, or now a symlink or a file),
    /// `finished` (a finished checkout is never Stop's to remove) or `remove_failed`
    /// (kept on record, so Stop can be retried).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

impl CloneStopped {
    fn kept(reason: &'static str) -> Self {
        Self {
            removed: false,
            reason: Some(reason),
        }
    }
}

/// The rule a refused input broke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloneRefusal {
    RepoShape,
    RepoOwner,
    RepoName,
    PathNotAbsolute,
    PathTooLong,
    PathCharacter,
    PathSegment,
    PathHidden,
    Containment,
    PathLibrary,
    NameMismatch,
    ParentMissing,
    ParentNotDirectory,
    ParentSymlink,
    TargetNotEmpty,
}

impl CloneRefusal {
    /// A stable name for the rule, for tests and for the agent.
    pub(crate) fn rule(self) -> &'static str {
        match self {
            Self::RepoShape => "repo_shape",
            Self::RepoOwner => "repo_owner",
            Self::RepoName => "repo_name",
            Self::PathNotAbsolute => "path_not_absolute",
            Self::PathTooLong => "path_too_long",
            Self::PathCharacter => "path_character",
            Self::PathSegment => "path_segment",
            Self::PathHidden => "path_hidden",
            Self::Containment => "containment",
            Self::PathLibrary => "path_library",
            Self::NameMismatch => "name_mismatch",
            Self::ParentMissing => "parent_missing",
            Self::ParentNotDirectory => "parent_not_directory",
            Self::ParentSymlink => "parent_symlink",
            Self::TargetNotEmpty => "target_not_empty",
        }
    }

    fn what(self) -> &'static str {
        match self {
            Self::RepoShape => "repo must be ASCII `owner/name` with exactly one `/`",
            Self::RepoOwner => {
                "repo owner must be 1-39 letters, digits or `-`, starting and ending with a letter or digit"
            }
            Self::RepoName => {
                "repo name must be 1-100 letters, digits, `.`, `_` or `-`, not `.`/`..`, not starting with `-`, not ending `.git`"
            }
            Self::PathNotAbsolute => "path must be absolute (start with `/`)",
            Self::PathTooLong => "path must be at most 1024 bytes",
            Self::PathCharacter => "path may only use letters, digits, `.`, `_`, `-`, space and `/`",
            Self::PathSegment => "path must have no `..`, `.`, empty (`//`) or trailing-`/` segment",
            Self::PathHidden => "no folder in path below home may start with `.`",
            Self::Containment => "path must sit inside your home folder",
            Self::PathLibrary => "path must not be under `~/Library`",
            Self::NameMismatch => "path's last segment must equal the repo's name",
            Self::ParentMissing => "the parent folder must exist",
            Self::ParentNotDirectory => "the parent must be a directory",
            Self::ParentSymlink => "the parent folder's path must not contain a symlink",
            Self::TargetNotEmpty => "the target must be absent or an empty directory",
        }
    }
}

impl std::fmt::Display for CloneRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "clone_repo refused ({}): {}", self.rule(), self.what())
    }
}

/// Inputs that passed every rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidClone {
    pub repo: String,
    pub path: PathBuf,
    /// The folder is absent, so this call creates it.
    pub creates: bool,
}

fn alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// `owner/name`: the owner and name patterns, ASCII only, exactly one `/`.
fn check_repo(repo: &str) -> Result<&str, CloneRefusal> {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(CloneRefusal::RepoShape);
    };
    if !repo.is_ascii() {
        return Err(CloneRefusal::RepoShape);
    }
    let owner_ok = (1..=MAX_OWNER_BYTES).contains(&owner.len())
        && owner.starts_with(alnum)
        && owner.ends_with(alnum)
        && owner.chars().all(|c| alnum(c) || c == '-');
    if !owner_ok {
        return Err(CloneRefusal::RepoOwner);
    }
    let name_ok = (1..=MAX_NAME_BYTES).contains(&name.len())
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && !name.ends_with(".git")
        && name
            .chars()
            .all(|c| alnum(c) || matches!(c, '.' | '_' | '-'));
    if !name_ok {
        return Err(CloneRefusal::RepoName);
    }
    Ok(name)
}

/// The text rules for `path`: absolute, bounded, allowlisted, normalized.
fn check_path_text(path: &str) -> Result<(), CloneRefusal> {
    if !path.starts_with('/') {
        return Err(CloneRefusal::PathNotAbsolute);
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(CloneRefusal::PathTooLong);
    }
    let allowed = |c: char| alnum(c) || matches!(c, '.' | '_' | '-' | ' ' | '/');
    if !path.chars().all(allowed) {
        return Err(CloneRefusal::PathCharacter);
    }
    let bad_segment = path
        .split('/')
        .skip(1)
        .any(|segment| segment.is_empty() || segment == "." || segment == "..");
    if bad_segment {
        return Err(CloneRefusal::PathSegment);
    }
    Ok(())
}

/// The folder a clone at `path` would sit in: `path` minus its last segment.
pub(crate) fn parent_of(path: &str) -> &Path {
    std::path::Path::new(path)
        .parent()
        .unwrap_or(std::path::Path::new("/"))
}

/// The profile's home folder, which bounds where a clone may land.
pub(crate) fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Where a clone may land: strictly inside `home`, not under `~/Library`, and with
/// no segment below home starting with `.`. Case is ignored for `Library`, since
/// the Mac's default volume is case-insensitive.
fn check_home(target: &Path, home: &Path) -> Result<(), CloneRefusal> {
    let Ok(rest) = target.strip_prefix(home) else {
        return Err(CloneRefusal::Containment);
    };
    let mut below = rest.components().peekable();
    let Some(Component::Normal(first)) = below.peek().copied() else {
        return Err(CloneRefusal::Containment);
    };
    if std::ffi::OsStr::eq_ignore_ascii_case(first, "Library") {
        return Err(CloneRefusal::PathLibrary);
    }
    // The path is ASCII by now, so every segment is valid UTF-8.
    let hidden = below.any(|segment| {
        std::ffi::OsStr::to_str(segment.as_os_str()).is_some_and(|text| text.starts_with('.'))
    });
    if hidden {
        return Err(CloneRefusal::PathHidden);
    }
    Ok(())
}

/// The rules that need no filesystem: the repo and path text, the home rule, and
/// the name. The parent is always `path`'s own parent.
pub(crate) fn validate_text(repo: &str, path: &str, home: &Path) -> Result<PathBuf, CloneRefusal> {
    let name = check_repo(repo)?;
    check_path_text(path)?;
    let target = std::path::Path::new(path);
    check_home(target, home)?;
    if target.file_name() != Some(std::ffi::OsStr::new(name)) {
        return Err(CloneRefusal::NameMismatch);
    }
    Ok(target.to_path_buf())
}

/// Check `repo` and `path` against every rule, in order: the text rules, then the
/// home rule and the name, then the filesystem. Nothing is created.
pub(crate) fn validate_clone(
    repo: &str,
    path: &str,
    home: &Path,
) -> Result<ValidClone, CloneRefusal> {
    let target = validate_text(repo, path, home)?;
    check_parent(parent_of(path))?;
    let creates = check_target(&target)?;
    Ok(ValidClone {
        repo: repo.to_string(),
        path: target,
        creates,
    })
}

/// The rules a Stop checks: the text rules and the parent, which must still be a
/// real directory, so a removal can't resolve through a parent that has become a
/// symlink. The target holds the clone by then, so it isn't checked.
pub(crate) fn validate_stop(repo: &str, path: &str, home: &Path) -> Result<PathBuf, CloneRefusal> {
    let target = validate_text(repo, path, home)?;
    check_parent(parent_of(path))?;
    Ok(target)
}

/// The parent exists, is a directory, and is its own canonical path (so no
/// component of it is a symlink).
fn check_parent(parent: &Path) -> Result<(), CloneRefusal> {
    let Ok(meta) = std::fs::symlink_metadata(parent) else {
        return Err(CloneRefusal::ParentMissing);
    };
    if meta.file_type().is_symlink() {
        return Err(CloneRefusal::ParentSymlink);
    }
    if !meta.is_dir() {
        return Err(CloneRefusal::ParentNotDirectory);
    }
    match std::fs::canonicalize(parent) {
        Ok(canonical) if canonical == parent => Ok(()),
        _ => Err(CloneRefusal::ParentSymlink),
    }
}

/// `Ok(true)`: absent, the clone creates it. `Ok(false)`: an empty directory.
fn check_target(target: &Path) -> Result<bool, CloneRefusal> {
    let Ok(meta) = std::fs::symlink_metadata(target) else {
        return Ok(true);
    };
    if !meta.is_dir() {
        return Err(CloneRefusal::TargetNotEmpty);
    }
    let Ok(mut entries) = std::fs::read_dir(target) else {
        return Err(CloneRefusal::TargetNotEmpty);
    };
    match entries.next() {
        None => Ok(false),
        Some(_) => Err(CloneRefusal::TargetNotEmpty),
    }
}

/// What a `clone_repo` call does, decided before anything runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Plan {
    /// Stop the clone at this folder.
    Stop(PathBuf),
    /// Clone into a checked target, for this org, team and workspace.
    Clone {
        valid: ValidClone,
        org: String,
        team: String,
        workspace_id: String,
    },
}

/// The handler's first step: every input rule, then the fields a clone needs. A
/// refusal is the message the tool returns; only a [`Plan::Clone`] reaches the code
/// that looks up the team and opens a tab.
pub(crate) fn plan(params: &CloneRepoParams, home: &Path) -> Result<Plan, String> {
    if params.stop == Some(true) {
        return validate_stop(&params.repo, &params.path, home)
            .map(Plan::Stop)
            .map_err(|refusal| refusal.to_string());
    }
    let valid =
        validate_clone(&params.repo, &params.path, home).map_err(|refusal| refusal.to_string())?;
    let (Some(org), Some(team), Some(workspace_id)) =
        (&params.org, &params.team, &params.workspace_id)
    else {
        return Err("clone_repo needs org, team and workspaceId".to_string());
    };
    Ok(Plan::Clone {
        valid,
        org: org.clone(),
        team: team.clone(),
        workspace_id: workspace_id.clone(),
    })
}

/// The argument vector the tab runs: `git clone -- <url> <path>`. The URL is built
/// from the fixed host and the checked `owner/name`; `--` ends git's options, and
/// neither operand could start with `-` anyway (the URL starts with the host, the
/// path with `/`).
pub(crate) fn clone_argv(git: &str, valid: &ValidClone) -> Vec<String> {
    vec![
        git.to_string(),
        "clone".to_string(),
        "--".to_string(),
        format!("{CLONE_HOST}/{}.git", valid.repo),
        valid.path.to_string_lossy().into_owned(),
    ]
}

/// A folder `clone_repo` created, and the tab cloning into it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Created {
    path: PathBuf,
    tab: Option<String>,
}

/// The folders `clone_repo` created and Stop may remove.
#[derive(Debug, Default)]
pub(crate) struct CloneRecords {
    created: Mutex<Vec<Created>>,
}

impl CloneRecords {
    fn entries(&self) -> std::sync::MutexGuard<'_, Vec<Created>> {
        Mutex::lock(&self.created).unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Record a folder this call is creating, with the handle of the tab cloning into
    /// it. A second record for the same folder replaces the first.
    pub(crate) fn note_created(&self, path: &Path, tab: Option<&str>) {
        let mut created = self.entries();
        Vec::retain(&mut created, |entry| entry.path != path);
        Vec::push(
            &mut created,
            Created {
                path: path.to_path_buf(),
                tab: tab.map(str::to_string),
            },
        );
    }

    pub(crate) fn is_recorded(&self, path: &Path) -> bool {
        <[Created]>::iter(&self.entries()).any(|entry| entry.path == path)
    }

    /// The tab cloning into a recorded folder; `None` when the folder isn't recorded.
    pub(crate) fn tab_of(&self, path: &Path) -> Option<String> {
        <[Created]>::iter(&self.entries())
            .find(|entry| entry.path == path)
            .and_then(|entry| entry.tab.clone())
    }

    /// Forget a folder: its clone was bound, or it never came to exist.
    pub(crate) fn forget(&self, path: &Path) {
        Vec::retain(&mut self.entries(), |entry| entry.path != path);
    }

    /// Remove `path` when this verb created it and its clone hasn't finished. The
    /// record is dropped once the folder is gone or can never be Stop's (it is no
    /// longer a real folder, or it holds a finished checkout); a failed removal keeps
    /// it, so Stop can be retried. A path that was never recorded is left alone.
    /// The caller closes the clone's tab first.
    pub(crate) fn stop(&self, path: &Path) -> CloneStopped {
        let mut created = self.entries();
        if !<[Created]>::iter(&created).any(|entry| entry.path == path) {
            return CloneStopped::kept("not_recorded");
        }
        let real_dir = std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir());
        let outcome = if !real_dir {
            CloneStopped::kept("not_a_folder")
        } else if finished(path) {
            CloneStopped::kept("finished")
        } else if std::fs::remove_dir_all(path).is_ok() {
            CloneStopped {
                removed: true,
                reason: None,
            }
        } else {
            return CloneStopped::kept("remove_failed");
        };
        Vec::retain(&mut created, |entry| entry.path != path);
        outcome
    }
}

/// The process-wide record of created folders.
pub(crate) fn records() -> &'static CloneRecords {
    static RECORDS: OnceLock<CloneRecords> = std::sync::OnceLock::new();
    RECORDS.get_or_init(Default::default)
}

/// Whether the clone at `path` has finished: git writes the index when its checkout
/// ends. A repository with no commits never gets one, which reads as "still running".
pub(crate) fn finished(path: &Path) -> bool {
    std::path::Path::is_file(&path.join(".git").join("index"))
}

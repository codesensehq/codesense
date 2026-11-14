// SPDX-License-Identifier: MIT
//! `clone_repo`: the setup guide's one clone verb.
//!
//! The agent has no shell, so the inputs of a clone are checked here, in Rust,
//! before anything runs. [`validate_clone`] holds the rules; the `#[tool]` method
//! in [`super::handler`] calls it first, and only a [`ValidClone`] reaches the
//! terminal tab, which runs `gh repo clone <repo> <path>` as an argument vector
//! (the tab's first process, no shell, nothing interpolated).
//!
//! `path` is the clone's own folder; its parent is the folder the person chose, so
//! containment reduces to: `path` is exactly one segment under a real, non-symlink
//! parent, and that segment is the repo's name.
//!
//! A directory the verb creates is recorded in [`CloneRecords`]; `stop` removes
//! only a recorded one. A folder that was already there (empty) is never recorded,
//! so Stop leaves it alone.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rmcp::schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
    /// The absolute folder to clone into: `<a parent folder that exists>/<name>`. Its last
    /// segment must equal the repo's name; the target must be absent or empty; the
    /// parent must be a real directory with no symlink in its path.
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
    /// `true` removes `path` only when an earlier `clone_repo` call created it; nothing
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
    /// The clone had finished and was bound with `attach_source_repo_path`.
    pub attached: bool,
    /// The binding, when `attached`.
    pub source: Option<crate::commands::source_repo_add::TrackedSourceRepo>,
    /// Why it isn't attached yet: the clone is still running (probe the folder, then call
    /// `attach_source_repo_path`), or the binding was refused.
    pub note: Option<String>,
}

/// What a stop call did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneStopped {
    /// The folder was created by `clone_repo` and is now gone.
    pub removed: bool,
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
    Containment,
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
            Self::Containment => "containment",
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
            Self::Containment => "path must sit directly under its parent folder",
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
    Path::new(path).parent().unwrap_or(Path::new("/"))
}

/// The rules that need no filesystem: the repo and path text, containment, and the
/// name. This is all a Stop needs; the target holds the clone by then.
pub(crate) fn validate_text(
    repo: &str,
    parent: &Path,
    path: &str,
) -> Result<PathBuf, CloneRefusal> {
    let name = check_repo(repo)?;
    check_path_text(path)?;
    let target = Path::new(path);
    let Ok(rest) = target.strip_prefix(parent) else {
        return Err(CloneRefusal::Containment);
    };
    let mut segments = rest.components();
    let (Some(Component::Normal(segment)), None) = (segments.next(), segments.next()) else {
        return Err(CloneRefusal::Containment);
    };
    if segment != std::ffi::OsStr::new(name) {
        return Err(CloneRefusal::NameMismatch);
    }
    Ok(target.to_path_buf())
}

/// Check `repo`, `parent` and `path` against every rule, in order: the text rules,
/// then containment and the name, then the filesystem. Nothing is created.
pub(crate) fn validate_clone(
    repo: &str,
    parent: &Path,
    path: &str,
) -> Result<ValidClone, CloneRefusal> {
    let target = validate_text(repo, parent, path)?;
    check_parent(parent)?;
    let creates = check_target(&target)?;
    Ok(ValidClone {
        repo: repo.to_string(),
        path: target,
        creates,
    })
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

/// The argument vector the tab runs. Operands never start with `-`: the repo's owner
/// starts with a letter or digit and the path with `/`.
pub(crate) fn clone_argv(gh: &str, valid: &ValidClone) -> Vec<String> {
    vec![
        gh.to_string(),
        "repo".to_string(),
        "clone".to_string(),
        valid.repo.clone(),
        valid.path.to_string_lossy().into_owned(),
    ]
}

/// The folders `clone_repo` created and Stop may remove.
#[derive(Debug, Default)]
pub(crate) struct CloneRecords {
    created: Mutex<Vec<PathBuf>>,
}

impl CloneRecords {
    pub(crate) fn note_created(&self, path: &Path) {
        let mut created = self.created.lock().unwrap_or_else(|e| e.into_inner());
        if !created.iter().any(|p| p == path) {
            created.push(path.to_path_buf());
        }
    }

    pub(crate) fn is_recorded(&self, path: &Path) -> bool {
        let created = self.created.lock().unwrap_or_else(|e| e.into_inner());
        created.iter().any(|p| p == path)
    }

    /// Remove `path` when this verb created it, and forget it either way. A path that
    /// was never recorded is left alone; so is one that has since become a symlink
    /// or a file.
    pub(crate) fn stop(&self, path: &Path) -> CloneStopped {
        let mut created = self.created.lock().unwrap_or_else(|e| e.into_inner());
        let Some(at) = created.iter().position(|p| p == path) else {
            return CloneStopped { removed: false };
        };
        created.remove(at);
        let real_dir = std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir());
        let removed = real_dir && std::fs::remove_dir_all(path).is_ok();
        CloneStopped { removed }
    }
}

/// The process-wide record of created folders.
pub(crate) fn records() -> &'static CloneRecords {
    static RECORDS: OnceLock<CloneRecords> = OnceLock::new();
    RECORDS.get_or_init(|| CloneRecords {
        created: Mutex::new(vec![]),
    })
}

/// Whether the clone at `path` has finished: git writes the index when its checkout
/// ends. A repository with no commits never gets one, which reads as "still running".
pub(crate) fn finished(path: &Path) -> bool {
    Path::is_file(&path.join(".git").join("index"))
}

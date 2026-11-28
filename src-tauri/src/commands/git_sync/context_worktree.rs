// SPDX-License-Identifier: MIT
use super::*;
use crate::install::worktree_index::{ContextWorktreeOwner, ContextWorktreeRecord};
use crate::work_item::WorkItemId;
use tauri::Manager;

pub(crate) async fn resolve(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<ContextWorktreeRecord, String> {
    let (home, user) = crate::commands::route_to_context::resolve_ambient(app).await?;
    let id = id.to_string();
    crate::commands::await_blocking("context worktree source", move || {
        let principal = crate::domain::Principal::from(user);
        let row = crate::install::worktree_index::context_records(&home, &principal)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| format!("No registered context worktree '{id}'"))?;
        crate::commands::workspace_open::validate_context_worktree(&row)?;
        Ok(row)
    })
    .await
}

fn baseline(repo: &git2::Repository) -> Result<git2::Commit<'_>, String> {
    let main = repo
        .refname_to_id("refs/heads/main")
        .map_err(|_| "The context clone has no local main branch")?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let base = repo
        .merge_base(main, head.id())
        .map_err(|e| e.to_string())?;
    repo.find_commit(base).map_err(|e| e.to_string())
}

pub(crate) fn publish_set(root: &Path, prefix: Option<&str>) -> Result<PublishSet, String> {
    publish_set_for(root, prefix, &Default::default())
}

pub(crate) fn publish_set_for(
    root: &Path,
    prefix: Option<&str>,
    scope: &crate::context_repo::caller_scope::CallerScope,
) -> Result<PublishSet, String> {
    let repo = open_repo(root)?;
    let tree = baseline(&repo)?.tree().map_err(|e| e.to_string())?;
    Ok(group_by_provenance(
        root,
        changeset_records_for(&repo, Some(&tree), prefix, scope)?,
    ))
}

pub(crate) fn redline(
    row: &ContextWorktreeRecord,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileRedline, String> {
    let root = &row.root;
    let repo = open_repo(root)?;
    let tree = baseline(&repo)?.tree().map_err(|e| e.to_string())?;
    let mut redline = file_redline_against_baseline(&repo, root, Some(&tree), path, old_path)?;
    let base = baseline(&repo)?.id().to_string();
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?
        .id()
        .to_string();
    let status = repo
        .status_file(Path::new(path))
        .unwrap_or(git2::Status::CURRENT);
    let changed = !status.is_empty() && !status.is_ignored();
    redline.before_label = Some(format!("main · {}", &base[..7]));
    redline.after_label = Some(format!(
        "{} · {}",
        row.name,
        if changed { "uncommitted" } else { &head[..7] }
    ));
    redline.baseline_sha = Some(base);
    Ok(redline)
}

/// A lead's combined, read-only diff: every context worktree carrying its work item,
/// each measured against its own merge base with main. Story branches come first, by
/// branch, then the lead's own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadDiff {
    pub work_item: String,
    /// The lead's agent name, else its handle, from the first worktree that names it.
    pub lead: Option<String>,
    pub branches: Vec<LeadBranch>,
}

/// One branch of a [`LeadDiff`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadBranch {
    /// The registered worktree id, which reads a file's redline on this branch.
    pub worktree: String,
    pub branch: String,
    /// The worktree's name: the story it works.
    pub story: String,
    /// The lead's own worktree rather than a story's.
    pub own: bool,
    /// The branch ref or its checkout is gone; such a branch lists no files.
    pub deleted: bool,
    pub files: Vec<LeadDiffFile>,
}

/// A changed file on one branch, with how many of the lead's branches change its path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeadDiffFile {
    #[serde(flatten)]
    pub file: PublishFile,
    pub branches: usize,
}

fn owned_by_lead(row: &ContextWorktreeRecord, lead: Option<&String>) -> bool {
    match (&row.owner, lead) {
        (Some(ContextWorktreeOwner::Agent { handle, .. }), Some(lead)) => handle == lead,
        _ => false,
    }
}

fn branch_files(row: &ContextWorktreeRecord) -> Result<Option<Vec<PublishFile>>, String> {
    if !Path::exists(&row.root) {
        return Ok(None);
    }
    let repo = open_repo(&row.root)?;
    let refname = format!("refs/heads/{}", row.branch);
    if Result::is_err(&git2::Repository::find_reference(&repo, &refname)) {
        return Ok(None);
    }
    let scope = crate::context_repo::caller_scope::CallerScope::Human;
    let set = publish_set_for(&row.root, None, &scope)?;
    let mut files = set.general.files;
    for bucket in set.buckets {
        Vec::extend(&mut files, bucket.files);
    }
    <[PublishFile]>::sort_by(&mut files, |a, b| String::cmp(&a.path, &b.path));
    Ok(Some(files))
}

/// The combined diff of every record carrying `work_item`. A path two branches change
/// is listed once on each, never merged into one.
pub(crate) fn lead_diff_impl(
    records: &[ContextWorktreeRecord],
    work_item: &WorkItemId,
) -> Result<LeadDiff, String> {
    let carried: Vec<_> = Iterator::collect(Iterator::filter_map(
        <[ContextWorktreeRecord]>::iter(records),
        |row| {
            let item = Option::as_ref(&row.work_item)?;
            (item.id == *work_item).then_some((row, item))
        },
    ));
    let lead = Iterator::find_map(<[_]>::iter(&carried), |(_, item)| {
        Option::or_else(Option::clone(&item.lead_agent), || {
            Option::clone(&item.lead_handle)
        })
    });
    let mut branches = Vec::new();
    for (row, item) in carried {
        let files = branch_files(row)?;
        branches.push(LeadBranch {
            worktree: String::clone(&row.id),
            branch: String::clone(&row.branch),
            story: String::clone(&row.name),
            own: owned_by_lead(row, Option::as_ref(&item.lead_handle)),
            deleted: Option::is_none(&files),
            files: Iterator::collect(Iterator::map(
                IntoIterator::into_iter(Option::unwrap_or_else(files, Vec::new)),
                |file| LeadDiffFile { file, branches: 0 },
            )),
        });
    }
    <[LeadBranch]>::sort_by(&mut branches, |a, b| {
        Ord::cmp(&(a.own, &a.branch), &(b.own, &b.branch))
    });
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for branch in &branches {
        for f in &branch.files {
            *std::collections::hash_map::Entry::or_insert(
                std::collections::HashMap::entry(&mut counts, String::clone(&f.file.path)),
                0,
            ) += 1;
        }
    }
    for branch in &mut branches {
        for f in &mut branch.files {
            f.branches = counts[&f.file.path];
        }
    }
    Ok(LeadDiff {
        work_item: String::from(WorkItemId::as_str(work_item)),
        lead,
        branches,
    })
}

/// The Tauri door for [`lead_diff_impl`] over this Mac's context worktree records.
#[tauri::command]
pub async fn lead_diff(app: tauri::AppHandle, work_item: String) -> Result<LeadDiff, String> {
    let id = Option::ok_or_else(WorkItemId::parse(&work_item), || {
        format!("Not a work item id: {work_item}")
    })?;
    let (home, user) = crate::commands::route_to_context::resolve_ambient(&app).await?;
    crate::commands::await_blocking("lead diff", move || {
        let principal = crate::domain::Principal::from(user);
        let records = crate::install::worktree_index::context_records(&home, &principal)
            .map_err(|e| e.to_string())?;
        lead_diff_impl(&records, &id)
    })
    .await
}

pub(crate) async fn status(
    app: &tauri::AppHandle,
    row: ContextWorktreeRecord,
) -> Result<serde_json::Value, String> {
    status_for(app, row, Default::default()).await
}

pub(crate) async fn status_for(
    app: &tauri::AppHandle,
    row: ContextWorktreeRecord,
    scope: crate::context_repo::caller_scope::CallerScope,
) -> Result<serde_json::Value, String> {
    let sessions = app
        .try_state::<crate::commands::dashboard_launch::DashboardLaunchState>()
        .map(|s| crate::commands::dashboard_launch::DashboardLaunchState::snapshot(&s))
        .unwrap_or_default();
    let app = app.clone();
    crate::commands::await_blocking("context worktree status", move || {
        let ids: Vec<_> = sessions.iter().filter_map(|s| s.session_id.as_deref()).collect();
        let alive = crate::commands::pty_backend::alive_session_ids(&app, &ids);
        let agents: Vec<_> = sessions.into_iter().filter(|s| s.worktree_dir.as_ref() == Some(&row.launch_cwd)
            && s.session_id.as_ref().is_some_and(|id| match &alive { crate::commands::pty_backend::Liveness::Known(ids) => ids.contains(id), _ => false }))
            .map(|s| serde_json::json!({"handle":s.handle,"name":s.meta.display_name.unwrap_or(s.handle),"role":s.meta.role,"avatar":s.meta.avatar})).collect();
        status_impl_for(&row, agents, &scope)
    }).await
}

pub(crate) fn status_impl(
    row: &ContextWorktreeRecord,
    agents: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    status_impl_for(row, agents, &Default::default())
}

fn status_impl_for(
    row: &ContextWorktreeRecord,
    agents: Vec<serde_json::Value>,
    scope: &crate::context_repo::caller_scope::CallerScope,
) -> Result<serde_json::Value, String> {
    crate::commands::workspace_open::validate_context_worktree(row)?;
    let repo = open_repo(&row.root)?;
    let main = repo
        .refname_to_id("refs/heads/main")
        .map_err(|e| e.to_string())?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let (ahead, behind) = repo
        .graph_ahead_behind(head.id(), main)
        .map_err(|e| e.to_string())?;
    let base = baseline(&repo)?.id().to_string();
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let uncommitted_paths: Vec<_> = statuses
        .iter()
        .filter(|s| !s.status().is_ignored())
        .filter_map(|s| Result::ok(s.path()).map(str::to_string))
        .filter(|path| scope.allows(&row.root.join(path)))
        .collect();
    let mut value = serde_json::to_value(
        crate::commands::context_repo_git::context_repo_status_impl_for(&row.root, scope)?,
    )
    .map_err(|e| e.to_string())?;
    value["ahead"] = serde_json::json!(ahead);
    value["behind"] = serde_json::json!(behind);
    value["headSha"] = serde_json::json!(head.id().to_string());
    value["hasUpstream"] = serde_json::json!(true);
    value["upstream"] = serde_json::json!("main");
    // Git operations and conflicts belong to this checkout, even though its
    // comparison is local and the card never offers remote sync actions.
    value["sync"]["lastSyncedAt"] = serde_json::Value::Null;
    value["sync"]["noSender"] = serde_json::json!(true);
    value["worktree"] = serde_json::json!({"id":row.id,"name":row.name,"path":row.root,"mergeBase":base,"uncommittedPaths":uncommitted_paths});
    value["uncommitted"] = serde_json::json!(uncommitted_paths.len());
    value["owner"] = serde_json::json!(row.owner);
    value["agents"] = serde_json::json!(agents);
    Ok(value)
}

#[cfg(test)]
#[path = "context_worktree_tests.rs"]
mod tests;

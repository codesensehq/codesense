// SPDX-License-Identifier: MIT
use super::*;
use crate::domain::Principal;
use crate::install::worktree_index::{self, ContextWorktreeRecord};

#[derive(Debug, Clone)]
pub(crate) struct ContextDestination {
    pub record: ContextWorktreeRecord,
    pub created: bool,
    pub warnings: Vec<LaunchWarning>,
}

/// Bounded Git subprocess, owned by this attempt, with its own process group.
fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut child = Command::new(super::super::worktree::git_bin())
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > std::time::Duration::from_secs(30) {
            // The child was spawned as its own process-group leader.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
            let _ = out.join();
            let _ = err.join();
            return Err("Git took too long creating the worktree. Nothing was launched".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let output = out.join().unwrap_or_default();
    let error = err.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("Git {} failed: {}", args.join(" "), error.trim()));
    }
    Ok(output.trim().to_string())
}

pub(crate) fn resolve(
    home: &Path,
    principal: &Principal,
    scope: &ActiveTeam,
    content: &Path,
    workspace_name: &str,
    requested: Option<&str>,
    create: bool,
) -> Result<ContextDestination, String> {
    if create && requested.is_none() {
        return Err("createWorktree:true requires a worktree name".into());
    }
    if !create {
        let rows = worktree_index::context_records(home, principal).map_err(|e| e.to_string())?;
        let team_rows: Vec<_> = rows
            .iter()
            .filter(|r| r.org == scope.org && r.team == scope.team)
            .collect();
        let selected =
            requested.and_then(|name| rows.iter().find(|r| r.id == name || named(r, scope, name)));
        let existing = match requested {
            Some(_) => selected,
            None => team_rows.first().copied(),
        };
        if let Some(row) = existing {
            if row.org != scope.org || row.team != scope.team {
                return Err(format!(
                    "{} belongs to {}:{}, not {}:{}",
                    row.name, row.org, row.team, scope.org, scope.team
                ));
            }
            validate(row)?;
            return Ok(ContextDestination {
                record: row.clone(),
                created: false,
                warnings: legacy_warning(home, principal, scope, workspace_name, &row.name),
            });
        }
        if let Some(name) = requested {
            return Err(format!("{} has no worktree named '{name}'. Its worktrees: {}. Pass createWorktree:true to create it", scope.team, team_rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }
    let name = requested.unwrap_or(workspace_name).trim();
    if name.is_empty() || name.chars().count() > 64 || !name.chars().any(char::is_alphanumeric) {
        return Err("Name the worktree with a letter or digit, using at most 64 characters".into());
    }
    let repo = crate::content_engine::git_worktree::GitWorktree::discover(content)?.ok_or(
        "The team's context repo isn't set up on this Mac, so there's nowhere to make a worktree",
    )?;
    // Held from the duplicate check through the record write, so two opens of one name
    // can't both pick the same root and branch.
    crate::context_repo::branch_common::with_clone_lock(&repo.root, || {
        create_new(home, principal, scope, &repo.root, workspace_name, name)
    })
}

/// `row` is the team's worktree called `name`, ignoring case.
fn named(row: &ContextWorktreeRecord, scope: &ActiveTeam, name: &str) -> bool {
    row.org == scope.org && row.team == scope.team && row.name.to_lowercase() == name.to_lowercase()
}

/// The most worktrees one name gets: `<slug>`, then `<slug>-2` up to `<slug>-100`.
const MAX_SUFFIX: usize = 100;

fn create_new(
    home: &Path,
    principal: &Principal,
    scope: &ActiveTeam,
    clone: &Path,
    workspace_name: &str,
    name: &str,
) -> Result<ContextDestination, String> {
    let rows = worktree_index::context_records(home, principal).map_err(|e| e.to_string())?;
    if rows.iter().any(|r| named(r, scope, name)) {
        return Err(format!(
            "{name} already exists. Pick it from the list, or use another name"
        ));
    }
    let base_sha = git(clone, &["rev-parse", "--verify", "refs/heads/main^{commit}"])
        .map_err(|_| {
            "The context repo has no local main commit. Commit the team files on main before launching"
                .to_string()
        })?;
    let slug = worker_slug(name).ok_or("The worktree name needs a letter or digit")?;
    let parent = crate::context_repo::path_to_user_home(home, principal)
        .join("context-worktrees")
        .join(&scope.org)
        .join(&scope.team);
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    // Loose refs are files, and APFS ignores case, so every comparison does too.
    let heads: Vec<String> = git(clone, &["for-each-ref", "--format=%(refname)", "refs/heads/"])?
        .lines()
        .filter_map(|r| r.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .collect();
    let team_prefix = format!("cs/{}", scope.team);
    if let Some(blocker) = Iterator::find(&mut heads.iter(), |h| {
        h.eq_ignore_ascii_case("cs") || h.eq_ignore_ascii_case(&team_prefix)
    }) {
        return Err(format!(
            "Branch {blocker} in the team's context repo blocks worktree branches under {team_prefix}/, so rename or delete it"
        ));
    }
    let mut candidates = (1..=MAX_SUFFIX).map(|n| {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        (
            format!("{team_prefix}/{slug}{suffix}"),
            parent.join(format!("{slug}{suffix}")),
        )
    });
    let (branch, root) = Iterator::find(&mut candidates, |(branch, root)| {
        !root.exists() && !ref_conflict(&heads, branch)
    })
    .ok_or_else(|| {
        format!("{name} already has {MAX_SUFFIX} worktrees ({team_prefix}/{slug} to -{MAX_SUFFIX}). Use another name")
    })?;
    let changes = git(clone, &["status", "--porcelain", "--", &scope.team])?
        .lines()
        .count();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let record = ContextWorktreeRecord {
        owner: Some(worktree_index::ContextWorktreeOwner::Person),
        schema_version: worktree_index::SCHEMA_VERSION,
        kind: "context".into(),
        id: format!("cw_{}", uuid::Uuid::new_v4().simple()),
        org: scope.org.clone(),
        team: scope.team.clone(),
        name: name.into(),
        branch,
        base_sha,
        launch_cwd: root.join(&scope.team).join("content"),
        root,
        created_at: now,
        last_used_at: now,
        extras: Default::default(),
    };
    // A failed add made nothing this attempt may remove, so there is nothing to roll back.
    git(
        clone,
        &[
            "worktree",
            "add",
            "-b",
            &record.branch,
            "--",
            &record.root.to_string_lossy(),
            &record.base_sha,
        ],
    )?;
    let result = (|| {
        validate(&record)?;
        worktree_index::write_context_record(home, principal, &record).map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        remove_created(clone, &record);
        return Err(error);
    }
    let mut warnings = if changes > 0 {
        vec![LaunchWarning { code: LaunchWarningCode::ContextCloneEdits, message: format!("Your clone has {changes} uncommitted changes in {}. They aren't in the new worktree {name}.", scope.team) }]
    } else {
        Vec::new()
    };
    warnings.extend(legacy_warning(
        home,
        principal,
        scope,
        workspace_name,
        &record.name,
    ));
    Ok(ContextDestination {
        record,
        created: true,
        warnings,
    })
}

/// Git can't create `branch` beside a ref with the same name, a parent path or a child path.
fn ref_conflict(heads: &[String], branch: &str) -> bool {
    let branch = branch.to_lowercase();
    heads.iter().any(|head| {
        let head = head.to_lowercase();
        head == branch
            || branch.starts_with(&format!("{head}/"))
            || head.starts_with(&format!("{branch}/"))
    })
}

/// Removes a worktree this attempt created, then its branch if it still points at the base.
fn remove_created(clone: &Path, row: &ContextWorktreeRecord) -> bool {
    if git(
        clone,
        &["worktree", "remove", "--", &row.root.to_string_lossy()],
    )
    .is_err()
    {
        return false;
    }
    let _ = git(
        clone,
        &[
            "update-ref",
            "-d",
            &format!("refs/heads/{}", row.branch),
            &row.base_sha,
        ],
    );
    true
}

pub(crate) fn validate(record: &ContextWorktreeRecord) -> Result<(), String> {
    if !record.launch_cwd.is_dir() {
        return Err("That worktree no longer exists. Pick another or create a new one".into());
    }
    let git = crate::content_engine::git_worktree::GitWorktree::discover(&record.launch_cwd)?
        .ok_or("That context worktree has no Git registration")?;
    if !git.linked || git.root != record.root.canonicalize().map_err(|e| e.to_string())? {
        return Err("That context worktree's Git registration changed".into());
    }
    Ok(())
}

pub(crate) fn layer(
    home: &Path,
    principal: &Principal,
    destination: &ContextDestination,
    agent: &AgentLaunch,
    progress: &dyn Fn(&crate::agents::prepare::PrepareProgress),
) -> Result<(), String> {
    use crate::agents::prepare;
    let record = &destination.record;
    validate(record)?;
    crate::commands::managed_worktree_config::write_context(&record.launch_cwd, home, principal)?;
    // An additional tab keeps the inherited snapshot already used by its neighbors.
    if !destination.created {
        return Ok(());
    }
    let canonical = crate::context_repo::path_to_org_root(home, principal, &record.org)?;
    let mut want = prepare::WantSet::for_context_worktree(
        home,
        principal,
        &agent.startup_context.target,
        &canonical,
        &record.root,
    )?;
    let team_layer = format!("team:{}/{}", record.org, record.team);
    // The checkout supplies team files. Only native discovery from outside it is layered.
    want.files.retain(|file| file.layer != team_layer);
    let report = prepare::prepare(prepare::PrepareRequest {
        home,
        principal,
        destination: prepare::Destination::Local {
            root: &record.launch_cwd,
        },
        want: &want,
        origin: "step2:context-worktree".into(),
        workspace: record.id.clone(),
        agent: agent.name.clone(),
        legacy: &|| Ok(Vec::new()),
        prune: false,
        progress,
        validate: &|| validate(record),
        explicit: Default::default(),
    })?;
    prepare::progress::finish(progress, &report, &record.id, &agent.name, "team content");
    if let Some(error) = crate::agents::prepare::PrepareReport::failure(&report) {
        return Err(error);
    }
    Ok(())
}

pub(crate) fn rollback(home: &Path, principal: &Principal, destination: &ContextDestination) {
    if !destination.created {
        return;
    }
    let row = &destination.record;
    if git(&row.root, &["rev-parse", "HEAD"]).ok().as_deref() != Some(&row.base_sha)
        || git(&row.root, &["status", "--porcelain"]).ok().as_deref() != Some("")
    {
        return;
    }
    let Ok(Some(g)) = crate::content_engine::git_worktree::GitWorktree::discover(&row.root) else {
        return;
    };
    let Ok(common) = git(
        &g.root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        return;
    };
    let Some(clone) = Path::new(&common).parent() else {
        return;
    };
    if remove_created(clone, row) {
        let _ = worktree_index::remove_record(home, principal, &row.root);
    }
}

fn legacy_notice(
    home: &Path,
    principal: &Principal,
    scope: &ActiveTeam,
    name: &str,
) -> Option<(PathBuf, PathBuf)> {
    let slug = worker_slug(name)?;
    let legacy = crate::context_repo::path_to_worker_workspace(
        home,
        principal,
        &scope.org,
        &scope.team,
        &slug,
    );
    if !legacy.is_dir() {
        return None;
    }
    let hash = crate::content_engine::lockfile::code_repo_path_hash(&legacy).ok()?;
    let notice = crate::context_repo::path_to_user_home(home, principal)
        .join("legacy-worker-notices")
        .join(hash);
    Some((legacy, notice))
}
fn legacy_warning(
    home: &Path,
    principal: &Principal,
    scope: &ActiveTeam,
    name: &str,
    destination: &str,
) -> Vec<LaunchWarning> {
    let Some((legacy, notice)) = legacy_notice(home, principal, scope, name) else {
        return Vec::new();
    };
    if notice.exists() {
        return Vec::new();
    }
    vec![LaunchWarning { code: LaunchWarningCode::LegacyWorker, message: format!("{name} used to run in its own folder ({}). That folder is kept; this launch uses worktree {destination}.", legacy.display()) }]
}
pub(crate) fn note_used(
    home: &Path,
    principal: &Principal,
    row: &crate::install::worktree_index::ContextWorktreeRecord,
    name: &str,
) -> Result<(), String> {
    let mut row = row.clone();
    row.last_used_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    worktree_index::write_context_record(home, principal, &row).map_err(|e| e.to_string())?;
    let scope = ActiveTeam {
        org: row.org,
        team: row.team,
    };
    if let Some((_, notice)) = legacy_notice(home, principal, &scope, name) {
        crate::content_engine::atomic_io::write_tmp_fsync_rename(&notice, b"shown")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        tmp: tempfile::TempDir,
        home: PathBuf,
        clone: PathBuf,
        content: PathBuf,
        principal: Principal,
        scope: ActiveTeam,
    }
    impl Fixture {
        fn new() -> Self {
            Self::with_team("default")
        }
        fn with_team(team: &str) -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let home = tmp.path().join("home");
            let clone = tmp.path().join("context");
            let content = clone.join(team).join("content");
            std::fs::create_dir_all(content.join(".claude/skills/own")).unwrap();
            std::fs::write(content.join("README.md"), "team files").unwrap();
            std::fs::write(content.join(".claude/skills/own/SKILL.md"), "own skill").unwrap();
            for args in [
                vec!["init", "-b", "main"],
                vec!["config", "user.name", "Test"],
                vec!["config", "user.email", "test@example.test"],
                vec!["add", "."],
                vec!["commit", "-m", "initial"],
            ] {
                git(&clone, &args).unwrap();
            }
            Self {
                tmp,
                home,
                clone,
                content,
                principal: Principal::from(42),
                scope: ActiveTeam {
                    org: "acme".into(),
                    team: team.into(),
                },
            }
        }
        fn try_open(&self, name: &str) -> Result<ContextDestination, String> {
            resolve(
                &self.home,
                &self.principal,
                &self.scope,
                &self.content,
                name,
                Some(name),
                true,
            )
        }
        fn open(&self, name: &str) -> ContextDestination {
            self.try_open(name).unwrap()
        }
        fn refs(&self, refs: &[&str]) {
            let mut child = std::process::Command::new("git")
                .args(["update-ref", "--stdin"])
                .current_dir(&self.clone)
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let lines: String = refs.iter().map(|r| format!("create {r} HEAD\n")).collect();
            use std::io::Write;
            child.stdin.take().unwrap().write_all(lines.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success());
        }
        fn branch_exists(&self, branch: &str) -> bool {
            git(
                &self.clone,
                &["show-ref", "--verify", &format!("refs/heads/{branch}")],
            )
            .is_ok()
        }
        fn snapshot(&self) -> (String, Vec<u8>, Vec<u8>) {
            (
                git(&self.clone, &["rev-parse", "HEAD"]).unwrap(),
                std::fs::read(self.clone.join(".git/index")).unwrap(),
                std::fs::read(self.content.join("README.md")).unwrap(),
            )
        }
    }
    #[test]
    fn team_workspace_launch_then_story_open_lookup_succeeds() {
        let f = Fixture::new();
        let launched = f.open("Sprint 1");
        assert!(launched.created);
        let story_root = f.tmp.path().join("story-checkout");
        std::fs::create_dir_all(&story_root).unwrap();
        let row = worktree_index::WorktreeStoryRecord::new(
            &story_root,
            "acme",
            crate::domain::SourceRepoSlug::new("acme", "code").unwrap(),
            "X-1",
            f.content.join("X-1.md"),
        );
        worktree_index::write_record(&f.home, &f.principal, &row).unwrap();
        assert!(crate::commands::content_engine::register_story_workspace(
            &f.home,
            &f.principal,
            row.clone(),
        )
        .unwrap());
        let registrations = worktree_index::story_registrations(&f.home, &story_root).unwrap();
        assert_eq!(registrations, vec![(f.principal.clone(), row)]);
        assert!(
            worktree_index::story_registrations(&f.home, &launched.record.root)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn real_git_worktrees_are_isolated_shared_by_id_or_name_and_leave_clone_unchanged() {
        let f = Fixture::new();
        let before = f.snapshot();
        let a = f.open("Sprint 1");
        let b = f.open("Copy pass");
        assert_eq!(a.record.branch, "cs/default/sprint-1");
        assert!(a
            .record
            .root
            .starts_with(f.home.join("users/42/context-worktrees/acme/default")));
        let cwd = &a.record.launch_cwd;
        assert_eq!(
            git(
                cwd,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"]
            )
            .unwrap(),
            f.clone
                .join(".git")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(
            std::fs::read_to_string(cwd.join("README.md")).unwrap(),
            "team files"
        );
        std::fs::write(cwd.join("README.md"), "agent edit").unwrap();
        for reference in [&a.record.id, &"sPrInT 1".into()] {
            let shared = resolve(
                &f.home,
                &f.principal,
                &f.scope,
                &f.content,
                "second agent",
                Some(reference),
                false,
            )
            .unwrap();
            assert_eq!(shared.record.root, a.record.root);
            assert!(!shared.created);
            assert_eq!(
                std::fs::read_to_string(shared.record.launch_cwd.join("README.md")).unwrap(),
                "agent edit"
            );
        }
        assert_eq!(
            std::fs::read_to_string(b.record.launch_cwd.join("README.md")).unwrap(),
            "team files"
        );
        assert_eq!(f.snapshot(), before);
        let retained = worktree_index::context_records(&f.home, &f.principal).unwrap();
        assert_eq!(retained.len(), 2);
        assert!(resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "third agent",
            None,
            false
        )
        .is_ok());
        let _ = &f.tmp;
    }
    #[test]
    fn unknown_wrong_team_stale_and_duplicate_destinations_never_create_substitutes() {
        let f = Fixture::new();
        let a = f.open("Sprint 1");
        assert!(resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "agent",
            Some("unknown"),
            false
        )
        .unwrap_err()
        .contains("Sprint 1"));
        assert!(resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "agent",
            Some("SPRINT 1"),
            true
        )
        .is_err());
        let other = ActiveTeam {
            org: f.scope.org.clone(),
            team: "other".into(),
        };
        assert!(resolve(
            &f.home,
            &f.principal,
            &other,
            &f.content,
            "agent",
            Some(&a.record.id),
            false
        )
        .unwrap_err()
        .contains("belongs to"));
        git(
            &f.clone,
            &["worktree", "remove", &a.record.root.to_string_lossy()],
        )
        .unwrap();
        assert!(resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "agent",
            Some(&a.record.id),
            false
        )
        .unwrap_err()
        .contains("no longer exists"));
        assert_eq!(
            worktree_index::context_records(&f.home, &f.principal)
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn local_main_is_the_base_dirty_clone_warns_and_unborn_fails() {
        let f = Fixture::new();
        let main = git(&f.clone, &["rev-parse", "main"]).unwrap();
        git(&f.clone, &["checkout", "-b", "other"]).unwrap();
        std::fs::write(f.content.join("README.md"), "other branch").unwrap();
        git(&f.clone, &["commit", "-am", "other"]).unwrap();
        std::fs::write(f.content.join("README.md"), "canonical edit").unwrap();
        let before = f.snapshot();
        let a = f.open("Sprint 1");
        assert_eq!(a.record.base_sha, main);
        assert_eq!(a.warnings.len(), 1);
        assert!(a.warnings[0].message.contains("1 uncommitted"));
        assert_eq!(
            std::fs::read_to_string(a.record.launch_cwd.join("README.md")).unwrap(),
            "team files"
        );
        assert_eq!(f.snapshot(), before);
        let unborn = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(unborn.path().join("default/content")).unwrap();
        git(unborn.path(), &["init", "-b", "main"]).unwrap();
        assert!(resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &unborn.path().join("default/content"),
            "agent",
            Some("Unborn"),
            true
        )
        .unwrap_err()
        .contains("no local main commit"));
    }
    #[test]
    fn rollback_only_removes_an_untouched_worktree_created_by_this_attempt() {
        let f = Fixture::new();
        let a = f.open("Empty");
        rollback(&f.home, &f.principal, &a);
        assert!(!a.record.root.exists());
        assert!(!f.branch_exists(&a.record.branch));
        assert!(worktree_index::context_records(&f.home, &f.principal)
            .unwrap()
            .is_empty());
        let b = f.open("Edited");
        std::fs::write(b.record.launch_cwd.join("README.md"), "keep me").unwrap();
        rollback(&f.home, &f.principal, &b);
        assert!(b.record.root.is_dir());
        assert!(f.branch_exists(&b.record.branch));
        let mut existing = b.clone();
        existing.created = false;
        rollback(&f.home, &f.principal, &existing);
        assert!(existing.record.root.is_dir());
        assert!(f.branch_exists(&existing.record.branch));
    }
    #[test]
    fn cleanup_keeps_a_branch_that_moved_past_the_base() {
        let f = Fixture::new();
        let a = f.open("Moved");
        let branch_ref = format!("refs/heads/{}", a.record.branch);
        git(&a.record.root, &["checkout", "-q", "--detach"]).unwrap();
        let tree = format!("{}^{{tree}}", a.record.base_sha);
        let tip = git(
            &f.clone,
            &["commit-tree", &tree, "-p", &a.record.base_sha, "-m", "moved"],
        )
        .unwrap();
        git(&f.clone, &["update-ref", &branch_ref, &tip]).unwrap();
        assert!(remove_created(&f.clone, &a.record));
        assert!(!a.record.root.exists());
        assert_eq!(git(&f.clone, &["rev-parse", &branch_ref]).unwrap(), tip);
    }
    #[test]
    fn a_failed_worktree_add_leaves_the_other_attempts_worktree_alone() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let base = git(&f.clone, &["rev-parse", "main"]).unwrap();
        let root = f
            .home
            .join("users/42/context-worktrees/acme/default/sprint-1");
        let other = ContextWorktreeRecord {
            owner: Some(worktree_index::ContextWorktreeOwner::Person),
            schema_version: worktree_index::SCHEMA_VERSION,
            kind: "context".into(),
            id: "cw_other".into(),
            org: "acme".into(),
            team: "default".into(),
            name: "Other".into(),
            branch: "other/sprint-1".into(),
            base_sha: base.clone(),
            launch_cwd: root.join("default/content"),
            root: root.clone(),
            created_at: 1,
            last_used_at: 1,
            extras: Default::default(),
        };
        worktree_index::write_context_record(&f.home, &f.principal, &other).unwrap();
        // While this open creates its branch, another attempt makes its worktree at the
        // same root, as a racing open would, and this open's `worktree add` fails.
        let hook = f.clone.join(".git/hooks/reference-transaction");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\n\
                 [ \"$1\" = prepared ] || exit 0\n\
                 grep -q ' refs/heads/cs/default/sprint-1$' || exit 0\n\
                 rm -- \"$0\"\n\
                 unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n\
                 git -C '{}' worktree add -q -b other/sprint-1 -- '{}' {base} >/dev/null 2>&1\n\
                 exit 1\n",
                f.clone.display(),
                root.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = f.try_open("Sprint 1").unwrap_err();
        assert!(!hook.exists(), "the hook never ran: {error}");
        assert!(root.join("default/content/README.md").is_file(), "{error}");
        assert!(git(&f.clone, &["worktree", "list", "--porcelain"])
            .unwrap()
            .contains(&*root.canonicalize().unwrap().to_string_lossy()));
        assert!(f.branch_exists("other/sprint-1"));
        assert!(worktree_index::context_records(&f.home, &f.principal)
            .unwrap()
            .iter()
            .any(|r| r.id == "cw_other"));
    }
    #[test]
    fn new_branches_are_cs_prefixed_and_never_collide_with_an_existing_ref() {
        // (team, refs that already exist, the branch it gets or a fragment of the error)
        let cases: &[(&str, &[&str], Result<&str, &str>)] = &[
            ("main", &[], Ok("cs/main/sprint-1")),
            ("master", &["refs/heads/master"], Ok("cs/master/sprint-1")),
            ("master", &["refs/remotes/origin/master"], Ok("cs/master/sprint-1")),
            ("head", &["refs/heads/head"], Ok("cs/head/sprint-1")),
            ("default", &["refs/heads/default"], Ok("cs/default/sprint-1")),
            ("default", &["refs/heads/cs"], Err("Branch cs ")),
            ("default", &["refs/heads/CS"], Err("Branch CS ")),
            ("default", &["refs/heads/cs/default"], Err("Branch cs/default ")),
            ("default", &["refs/heads/cs/other"], Ok("cs/default/sprint-1")),
            ("default", &["refs/heads/cs/default/sprint-1"], Ok("cs/default/sprint-1-2")),
            ("default", &["refs/heads/cs/default/sprint-1/x"], Ok("cs/default/sprint-1-2")),
            ("default", &["refs/heads/cs/default/Sprint-1"], Ok("cs/default/sprint-1-2")),
        ];
        for (team, existing, expected) in cases {
            let f = Fixture::with_team(team);
            f.refs(existing);
            let label = format!("team {team}, existing {existing:?}");
            match (f.try_open("Sprint 1"), expected) {
                (Ok(opened), Ok(branch)) => {
                    assert_eq!(opened.record.branch, *branch, "{label}");
                    assert!(f.branch_exists(branch), "{label}");
                    assert!(opened.record.launch_cwd.join("README.md").is_file(), "{label}");
                }
                (Err(error), Err(fragment)) => {
                    assert!(error.contains(fragment), "{label}: {error}");
                    assert!(error.contains("rename or delete"), "{label}: {error}");
                    assert!(worktree_index::context_records(&f.home, &f.principal)
                        .unwrap()
                        .is_empty());
                    assert!(!f.home.join("users/42/context-worktrees/acme").join(team).join("sprint-1").exists());
                }
                (got, want) => panic!("{label}: got {got:?}, want {want:?}"),
            }
        }
    }
    #[test]
    fn the_suffix_search_stops_at_100() {
        let f = Fixture::new();
        let taken: Vec<String> = std::iter::once("refs/heads/cs/default/sprint-1".to_string())
            .chain((2..=100).map(|n| format!("refs/heads/cs/default/sprint-1-{n}")))
            .collect();
        f.refs(&taken.iter().map(String::as_str).collect::<Vec<_>>());
        let error = f.try_open("Sprint 1").unwrap_err();
        assert!(error.contains("100"), "{error}");
        assert!(worktree_index::context_records(&f.home, &f.principal)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn a_failed_record_check_removes_the_new_worktree_and_its_branch() {
        let f = Fixture::new();
        // The team folder is on disk but not committed, so the new worktree has no content.
        git(&f.clone, &["rm", "-r", "--cached", "-q", "default"]).unwrap();
        git(&f.clone, &["commit", "-q", "-m", "untrack"]).unwrap();
        let error = f.try_open("Sprint 1").unwrap_err();
        assert!(error.contains("no longer exists"), "{error}");
        assert!(!f.home.join("users/42/context-worktrees/acme/default/sprint-1").exists());
        assert!(!f.branch_exists("cs/default/sprint-1"));
        assert!(worktree_index::context_records(&f.home, &f.principal)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn concurrent_opens_of_one_name_create_it_once_and_keep_the_winner() {
        let f = Fixture::new();
        let barrier = std::sync::Barrier::new(2);
        let results: Vec<_> = std::thread::scope(|s| {
            let open = || {
                barrier.wait();
                f.try_open("Sprint 1")
            };
            let a = s.spawn(open);
            let b = s.spawn(open);
            vec![a.join().unwrap(), b.join().unwrap()]
        });
        let (won, lost): (Vec<_>, Vec<_>) = results.into_iter().partition(Result::is_ok);
        assert_eq!((won.len(), lost.len()), (1, 1), "{won:?} {lost:?}");
        let winner = won.into_iter().next().unwrap().unwrap();
        let error = lost.into_iter().next().unwrap().unwrap_err();
        assert!(error.contains("already exists. Pick it from the list"), "{error}");
        assert!(winner.record.launch_cwd.join("README.md").is_file());
        assert!(f.branch_exists(&winner.record.branch));
        let rows = worktree_index::context_records(&f.home, &f.principal).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, winner.record.id);
    }
    #[test]
    fn an_old_record_reopens_on_its_stored_branch() {
        let f = Fixture::new();
        let a = f.open("Old");
        git(&f.clone, &["branch", "-m", &a.record.branch, "default/old"]).unwrap();
        let mut old = a.record.clone();
        old.branch = "default/old".into();
        worktree_index::write_context_record(&f.home, &f.principal, &old).unwrap();
        let reopened = resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "agent",
            Some("Old"),
            false,
        )
        .unwrap();
        assert!(!reopened.created);
        assert_eq!(reopened.record.branch, "default/old");
        assert_eq!(reopened.record.root, a.record.root);
        rollback(&f.home, &f.principal, &reopened);
        assert!(f.branch_exists("default/old"));
    }
    #[test]
    fn legacy_folder_is_retained_and_notice_is_once_after_a_successful_launch() {
        let f = Fixture::new();
        let legacy = crate::context_repo::path_to_worker_workspace(
            &f.home,
            &f.principal,
            "acme",
            "default",
            "agent",
        );
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("notes.txt"), "old work").unwrap();
        let a = resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "Agent",
            None,
            false,
        )
        .unwrap();
        assert!(a
            .warnings
            .iter()
            .any(|w| w.message.contains(&*legacy.to_string_lossy())));
        note_used(&f.home, &f.principal, &a.record, "Agent").unwrap();
        let again = resolve(
            &f.home,
            &f.principal,
            &f.scope,
            &f.content,
            "Agent",
            None,
            false,
        )
        .unwrap();
        assert!(again.warnings.is_empty());
        assert_eq!(
            std::fs::read_to_string(legacy.join("notes.txt")).unwrap(),
            "old work"
        );
    }
}

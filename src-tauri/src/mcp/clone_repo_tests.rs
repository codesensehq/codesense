// SPDX-License-Identifier: MIT
//! The `clone_repo` rules: each hostile fixture is refused by a named rule before
//! any tab could open (the verb validates first), good inputs pass, and Stop removes
//! only an unfinished folder the verb created. No network and no `git` run.
//!
//! The parent is always derived from `path` (`parent_of`), as the tool does. A temp
//! folder stands in for the profile's home.

use std::path::{Path, PathBuf};

use super::clone_repo::{
    clone_argv, finished, parent_of, plan, records, validate_clone, validate_stop, validate_text,
    CloneRecords, CloneRefusal, CloneRepoParams, CloneStopped, Plan, ValidClone, CLONE_WAIT_SECS,
};

/// A canonical temp folder that stands in for home: macOS's temp dir sits behind a
/// symlink, which the rules refuse by design. Its own name (`.tmp...`) starts with
/// a dot; only segments below home are held to the hidden-folder rule.
fn home() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let real = std::fs::canonicalize(dir.path()).unwrap();
    (dir, real)
}

fn path_in(parent: &Path, name: &str) -> String {
    format!("{}/{name}", parent.display())
}

fn refused(home: &Path, repo: &str, path: &str) -> CloneRefusal {
    validate_clone(repo, path, home).unwrap_err()
}

fn kept(reason: &'static str) -> CloneStopped {
    CloneStopped {
        removed: false,
        reason: Some(reason),
    }
}

#[test]
fn a_good_clone_into_an_absent_folder_passes_and_creates_it() {
    let (_dir, home) = home();
    let path = path_in(&home, "api");
    let valid = validate_clone("acme/api", &path, &home).unwrap();
    assert_eq!(
        valid,
        ValidClone {
            repo: "acme/api".into(),
            path: PathBuf::from(&path),
            creates: true,
        }
    );
}

#[test]
fn an_empty_existing_folder_passes_and_is_not_created_by_the_verb() {
    let (_dir, home) = home();
    let path = path_in(&home, "api");
    std::fs::create_dir(&path).unwrap();
    assert!(!validate_clone("acme/api", &path, &home).unwrap().creates);
}

#[test]
fn dots_dashes_underscores_and_a_spaced_parent_pass() {
    let (_dir, home) = home();
    let spaced = home.join("My Code");
    std::fs::create_dir(&spaced).unwrap();
    let path = path_in(&spaced, "web.app_v2-x");
    assert!(validate_clone("a-b/web.app_v2-x", &path, &home).is_ok());
}

#[test]
fn the_argv_is_git_clone_of_the_fixed_host_with_no_gh() {
    let (_dir, home) = home();
    let path = path_in(&home, "api");
    let valid = validate_clone("acme/api", &path, &home).unwrap();
    assert_eq!(
        clone_argv("/usr/bin/git", &valid),
        [
            "/usr/bin/git",
            "clone",
            "--",
            "https://github.com/acme/api.git",
            path.as_str()
        ]
    );
}

#[test]
fn the_wait_stays_well_under_a_sixty_second_tool_timeout() {
    assert!(CLONE_WAIT_SECS <= 30, "{CLONE_WAIT_SECS}");
}

#[test]
fn hostile_repos_are_refused_by_the_repo_rules() {
    let (_dir, home) = home();
    let path = path_in(&home, "b");
    let long_name = format!("a/{}", "n".repeat(300));
    let long_owner = format!("{}/b", "o".repeat(40));
    let cases: [(&str, CloneRefusal); 16] = [
        ("a/b; rm -rf ~", CloneRefusal::RepoName),
        ("a/b$(id)", CloneRefusal::RepoName),
        ("a/b`id`", CloneRefusal::RepoName),
        ("a/b\nx", CloneRefusal::RepoName),
        ("-oProxyCommand=x/y", CloneRefusal::RepoOwner),
        ("../x", CloneRefusal::RepoOwner),
        ("a/..", CloneRefusal::RepoName),
        ("a/b/c", CloneRefusal::RepoShape),
        ("https://github.com/a/b", CloneRefusal::RepoShape),
        ("\u{0430}cme/b", CloneRefusal::RepoShape),
        ("a/b\0", CloneRefusal::RepoName),
        ("a/-b", CloneRefusal::RepoName),
        ("a/b.git", CloneRefusal::RepoName),
        ("a@b/c", CloneRefusal::RepoOwner),
        ("", CloneRefusal::RepoShape),
        ("noslash", CloneRefusal::RepoShape),
    ];
    for (repo, rule) in cases {
        assert_eq!(refused(&home, repo, &path), rule, "{repo:?}");
    }
    assert_eq!(refused(&home, &long_name, &path), CloneRefusal::RepoName);
    assert_eq!(refused(&home, &long_owner, &path), CloneRefusal::RepoOwner);
}

#[test]
fn hostile_paths_are_refused_by_the_path_rules() {
    let home = Path::new("/home/user");
    let long = format!("/home/user/{}", "p".repeat(1100));
    let cases: [(&str, CloneRefusal); 16] = [
        ("~/x", CloneRefusal::PathNotAbsolute),
        ("home/user/b", CloneRefusal::PathNotAbsolute),
        ("", CloneRefusal::PathNotAbsolute),
        ("/home/user/b; rm -rf ~", CloneRefusal::PathCharacter),
        ("/home/user/b$(id)", CloneRefusal::PathCharacter),
        ("/home/user/b`id`", CloneRefusal::PathCharacter),
        ("/home/user/b\nx", CloneRefusal::PathCharacter),
        ("/home/user/b\0", CloneRefusal::PathCharacter),
        ("/home/user/b'x", CloneRefusal::PathCharacter),
        ("/home/user/~b", CloneRefusal::PathCharacter),
        ("/home/user/\u{0431}", CloneRefusal::PathCharacter),
        ("/home/user/../etc", CloneRefusal::PathSegment),
        ("/home/user/./b", CloneRefusal::PathSegment),
        ("/home/user//b", CloneRefusal::PathSegment),
        ("/home/user/b/", CloneRefusal::PathSegment),
        ("/", CloneRefusal::PathSegment),
    ];
    for (path, rule) in cases {
        assert_eq!(refused(home, "a/b", path), rule, "{path:?}");
    }
    assert_eq!(refused(home, "a/b", &long), CloneRefusal::PathTooLong);
}

#[test]
fn a_clone_outside_home_is_refused() {
    let home = Path::new("/home/user");
    let cases: [(&str, &str); 5] = [
        ("a/x", "/etc/x"),
        ("a/repo", "/home/users/repo"),
        // `/home/user` is a string prefix of `/home/username`, not a parent of it.
        ("a/repo", "/home/username/repo"),
        ("a/user", "/home/user"),
        ("a/home", "/home"),
    ];
    for (repo, path) in cases {
        assert_eq!(
            refused(home, repo, path),
            CloneRefusal::Containment,
            "{path:?}"
        );
    }
}

#[test]
fn a_clone_into_a_dot_folder_or_library_is_refused() {
    let home = Path::new("/home/user");
    let cases: [(&str, &str, CloneRefusal); 7] = [
        ("x/git", "/home/user/.config/git", CloneRefusal::PathHidden),
        ("x/.ssh", "/home/user/.ssh", CloneRefusal::PathHidden),
        ("x/.aws", "/home/user/.aws", CloneRefusal::PathHidden),
        ("x/bin", "/home/user/.local/bin", CloneRefusal::PathHidden),
        (
            "x/.github",
            "/home/user/code/.github",
            CloneRefusal::PathHidden,
        ),
        (
            "x/LaunchAgents",
            "/home/user/Library/LaunchAgents",
            CloneRefusal::PathLibrary,
        ),
        // The Mac's volume is case-insensitive: `library` is `Library`.
        (
            "x/LaunchAgents",
            "/home/user/library/LaunchAgents",
            CloneRefusal::PathLibrary,
        ),
    ];
    for (repo, path, rule) in cases {
        assert_eq!(refused(home, repo, path), rule, "{path:?}");
    }
}

#[test]
fn a_real_dot_folder_and_library_under_home_are_refused_on_disk_too() {
    let (_dir, home) = home();
    for folder in [".config", "Library"] {
        std::fs::create_dir(home.join(folder)).unwrap();
    }
    assert_eq!(
        refused(&home, "x/git", &path_in(&home.join(".config"), "git")),
        CloneRefusal::PathHidden
    );
    assert_eq!(
        refused(
            &home,
            "x/LaunchAgents",
            &path_in(&home.join("Library"), "LaunchAgents")
        ),
        CloneRefusal::PathLibrary
    );
}

#[test]
fn the_last_segment_must_equal_the_repo_name() {
    let (_dir, home) = home();
    let path = path_in(&home, "other");
    assert_eq!(refused(&home, "a/repo", &path), CloneRefusal::NameMismatch);
    let case = path_in(&home, "REPO");
    assert_eq!(refused(&home, "a/repo", &case), CloneRefusal::NameMismatch);
    // `repo2` is a sibling of `repo`, not `repo`.
    let sibling = path_in(&home, "repo2");
    assert_eq!(
        refused(&home, "a/repo", &sibling),
        CloneRefusal::NameMismatch
    );
}

#[test]
fn a_missing_or_file_parent_is_refused() {
    let (_dir, home) = home();
    let gone = home.join("gone");
    assert_eq!(
        refused(&home, "a/b", &path_in(&gone, "b")),
        CloneRefusal::ParentMissing
    );
    let file = home.join("file");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(
        refused(&home, "a/b", &path_in(&file, "b")),
        CloneRefusal::ParentNotDirectory
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_parent_or_ancestor_is_refused() {
    let (_dir, home) = home();
    let real = home.join("real");
    std::fs::create_dir(&real).unwrap();
    let link = home.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert_eq!(
        refused(&home, "a/b", &path_in(&link, "b")),
        CloneRefusal::ParentSymlink
    );
    // A symlink higher up: the parent is a real folder reached through it.
    std::fs::create_dir(real.join("inner")).unwrap();
    let through = link.join("inner");
    assert_eq!(
        refused(&home, "a/b", &path_in(&through, "b")),
        CloneRefusal::ParentSymlink
    );
}

#[test]
fn a_target_that_holds_something_is_refused() {
    let (_dir, home) = home();
    let path = path_in(&home, "b");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(Path::new(&path).join("keep.txt"), "x").unwrap();
    assert_eq!(refused(&home, "a/b", &path), CloneRefusal::TargetNotEmpty);
    // A file at the target is refused too.
    let file = path_in(&home, "c");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(refused(&home, "a/c", &file), CloneRefusal::TargetNotEmpty);
}

#[cfg(unix)]
#[test]
fn a_symlink_at_the_target_is_refused() {
    let (_dir, home) = home();
    let real = home.join("real");
    std::fs::create_dir(&real).unwrap();
    let path = path_in(&home, "b");
    std::os::unix::fs::symlink(&real, &path).unwrap();
    assert_eq!(refused(&home, "a/b", &path), CloneRefusal::TargetNotEmpty);
}

#[test]
fn a_refusal_names_its_rule() {
    let message = CloneRefusal::ParentSymlink.to_string();
    assert!(message.contains("parent_symlink"), "{message}");
    assert!(message.contains("symlink"), "{message}");
    let message = CloneRefusal::PathHidden.to_string();
    assert!(message.contains("path_hidden"), "{message}");
}

#[test]
fn the_parent_is_the_path_minus_its_last_segment() {
    assert_eq!(parent_of("/home/user/api"), Path::new("/home/user"));
}

#[test]
fn stop_removes_only_a_folder_the_verb_created() {
    let (_dir, home) = home();
    let created = home.join("api");
    std::fs::create_dir(&created).unwrap();
    std::fs::write(created.join("README.md"), "x").unwrap();
    let records = CloneRecords::default();
    records.note_created(&created, Some("tab-1"));
    assert!(records.is_recorded(&created));
    assert_eq!(records.tab_of(&created).as_deref(), Some("tab-1"));

    assert_eq!(
        records.stop(&created),
        CloneStopped {
            removed: true,
            reason: None
        }
    );
    assert!(!created.exists());
    assert!(!records.is_recorded(&created));
    assert_eq!(records.tab_of(&created), None);
}

#[test]
fn stop_on_a_folder_that_was_already_there_removes_nothing() {
    let (_dir, home) = home();
    let existing = home.join("api");
    std::fs::create_dir(&existing).unwrap();
    // Validation found it empty, so the verb did not create it and never records it.
    assert!(
        !validate_clone("a/api", &path_in(&home, "api"), &home)
            .unwrap()
            .creates
    );
    let records = CloneRecords::default();

    assert_eq!(records.stop(&existing), kept("not_recorded"));
    assert!(existing.is_dir());
}

#[test]
fn stop_never_follows_a_recorded_path_that_became_a_symlink() {
    let (_dir, home) = home();
    let keep = home.join("keep");
    std::fs::create_dir(&keep).unwrap();
    std::fs::write(keep.join("data"), "x").unwrap();
    let swapped = home.join("api");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&keep, &swapped).unwrap();
    #[cfg(not(unix))]
    std::fs::create_dir(&swapped).unwrap();
    let records = CloneRecords::default();
    records.note_created(&swapped, None);

    #[cfg(unix)]
    assert_eq!(records.stop(&swapped), kept("not_a_folder"));
    #[cfg(not(unix))]
    let _ = records.stop(&swapped);
    assert!(keep.join("data").exists());
}

#[test]
fn stop_forgets_the_record_and_a_second_stop_removes_nothing() {
    let (_dir, home) = home();
    let created = home.join("api");
    std::fs::create_dir(&created).unwrap();
    let records = CloneRecords::default();
    records.note_created(&created, None);
    assert!(records.stop(&created).removed);

    // Someone else creates the folder again: it is not ours to remove.
    std::fs::create_dir(&created).unwrap();
    assert_eq!(records.stop(&created), kept("not_recorded"));
    assert!(created.is_dir());
}

#[test]
fn stop_never_removes_a_finished_checkout_and_forgets_it() {
    let (_dir, home) = home();
    let created = home.join("api");
    std::fs::create_dir_all(created.join(".git")).unwrap();
    std::fs::write(created.join(".git").join("index"), "x").unwrap();
    std::fs::write(created.join("work.txt"), "uncommitted").unwrap();
    let records = CloneRecords::default();
    records.note_created(&created, None);

    assert_eq!(records.stop(&created), kept("finished"));
    assert!(created.join("work.txt").exists());
    assert!(!records.is_recorded(&created));
}

#[cfg(unix)]
#[test]
fn a_failed_removal_keeps_the_record_so_stop_can_be_retried() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, home) = home();
    let created = home.join("api");
    let inner = created.join("src");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::write(inner.join("lib.rs"), "x").unwrap();
    // A folder whose entries can't be unlinked makes the removal fail.
    std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o555)).unwrap();
    let records = CloneRecords::default();
    records.note_created(&created, Some("tab-1"));

    let first = records.stop(&created);
    std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o755)).unwrap();
    if first.removed {
        // Running as root: permissions don't stop the removal, so there is nothing to retry.
        return;
    }
    assert_eq!(first, kept("remove_failed"));
    assert!(records.is_recorded(&created));
    assert_eq!(records.tab_of(&created).as_deref(), Some("tab-1"));

    assert!(records.stop(&created).removed);
    assert!(!created.exists());
    assert!(!records.is_recorded(&created));
}

#[test]
fn a_bound_or_never_made_clone_is_forgotten_and_stop_leaves_it() {
    let (_dir, home) = home();
    let bound = home.join("api");
    std::fs::create_dir(&bound).unwrap();
    let records = CloneRecords::default();
    records.note_created(&bound, Some("tab-1"));
    // The clone was bound: the record ends, so no later Stop can remove it.
    records.forget(&bound);
    assert_eq!(records.stop(&bound), kept("not_recorded"));
    assert!(bound.is_dir());
    assert_eq!(records.tab_of(&bound), None);
}

#[test]
fn a_second_record_for_a_folder_replaces_the_first() {
    let (_dir, home) = home();
    let path = home.join("api");
    let records = CloneRecords::default();
    records.note_created(&path, Some("tab-1"));
    records.note_created(&path, Some("tab-2"));
    assert_eq!(records.tab_of(&path).as_deref(), Some("tab-2"));
    records.forget(&path);
    assert!(!records.is_recorded(&path));
}

#[test]
fn the_process_wide_record_is_shared() {
    let (_dir, home) = home();
    let path = home.join("shared");
    records().note_created(&path, None);
    assert!(records().is_recorded(&path));
    assert_eq!(records().stop(&path), kept("not_a_folder"));
    assert!(!records().is_recorded(&path));
}

#[test]
fn stop_checks_the_text_rules_and_the_parent_but_not_the_target() {
    let (_dir, home) = home();
    let path = path_in(&home, "api");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(Path::new(&path).join("README.md"), "x").unwrap();
    // The full check refuses the filled target; a Stop's check does not.
    assert_eq!(refused(&home, "a/api", &path), CloneRefusal::TargetNotEmpty);
    assert_eq!(
        validate_stop("a/api", &path, &home).unwrap(),
        PathBuf::from(&path)
    );
    assert_eq!(
        validate_text("a/api", "/etc/api", &home).unwrap_err(),
        CloneRefusal::Containment
    );
    assert_eq!(
        validate_stop("a/api", &path_in(&home.join(".ssh"), "api"), &home).unwrap_err(),
        CloneRefusal::PathHidden
    );
}

#[cfg(unix)]
#[test]
fn stop_refuses_a_parent_that_became_a_symlink() {
    let (_dir, home) = home();
    let code = home.join("code");
    std::fs::create_dir(&code).unwrap();
    let elsewhere = home.join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("api")).unwrap();
    std::fs::write(elsewhere.join("api").join("keep.txt"), "x").unwrap();
    let path = path_in(&code, "api");
    records().note_created(Path::new(&path), None);
    // After the clone, the parent is swapped for a symlink to another folder.
    std::fs::remove_dir(&code).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &code).unwrap();

    assert_eq!(
        validate_stop("a/api", &path, &home).unwrap_err(),
        CloneRefusal::ParentSymlink
    );
    assert!(elsewhere.join("api").join("keep.txt").exists());
    records().forget(Path::new(&path));
}

#[test]
fn a_clone_is_finished_when_git_has_written_its_index() {
    let (_dir, home) = home();
    let target = home.join("api");
    std::fs::create_dir_all(target.join(".git")).unwrap();
    assert!(!finished(&target));
    std::fs::write(target.join(".git").join("index"), "x").unwrap();
    assert!(finished(&target));
}

/// The tool's own params, as an agent sends them.
fn params(json: serde_json::Value) -> CloneRepoParams {
    serde_json::from_value(json).unwrap()
}

#[test]
fn the_handler_plan_refuses_hostile_input_before_the_team_or_a_tab() {
    let (_dir, home) = home();
    let good = path_in(&home, "api");
    let hostile = [
        serde_json::json!({"repo": "a/api; id", "path": good, "org": "o", "team": "t", "workspaceId": "w"}),
        serde_json::json!({"repo": "x/.ssh", "path": path_in(&home, ".ssh"), "org": "o", "team": "t", "workspaceId": "w"}),
        serde_json::json!({"repo": "x/x", "path": "/etc/x", "org": "o", "team": "t", "workspaceId": "w"}),
        // A refused input is refused on Stop too.
        serde_json::json!({"repo": "x/x", "path": "/etc/x", "stop": true}),
    ];
    for json in hostile {
        let message = plan(&params(json.clone()), &home).unwrap_err();
        assert!(
            message.starts_with("clone_repo refused ("),
            "{json}: {message}"
        );
    }
    // The input rules come before the fields a clone needs.
    let message = plan(
        &params(serde_json::json!({"repo": "x/x", "path": "/etc/x"})),
        &home,
    )
    .unwrap_err();
    assert!(message.contains("(containment)"), "{message}");
    let message = plan(
        &params(serde_json::json!({"repo": "a/api", "path": good})),
        &home,
    )
    .unwrap_err();
    assert_eq!(message, "clone_repo needs org, team and workspaceId");
}

#[test]
fn the_handler_plan_passes_a_good_clone_and_a_stop() {
    let (_dir, home) = home();
    let good = path_in(&home, "api");
    let planned = plan(
        &params(serde_json::json!({"repo": "a/api", "path": good, "org": "o", "team": "t", "workspaceId": "w"})),
        &home,
    )
    .unwrap();
    assert_eq!(
        planned,
        Plan::Clone {
            valid: ValidClone {
                repo: "a/api".into(),
                path: PathBuf::from(&good),
                creates: true,
            },
            org: "o".into(),
            team: "t".into(),
            workspace_id: "w".into(),
        }
    );
    let stop = plan(
        &params(serde_json::json!({"repo": "a/api", "path": good, "stop": true})),
        &home,
    )
    .unwrap();
    assert_eq!(stop, Plan::Stop(PathBuf::from(&good)));
}
